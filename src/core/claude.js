/**
 * AI gateway HTTP client — replaces the old claude CLI subprocess.
 *
 * Gateway: POST localhost:4242/v1/chat  (OpenAI-compatible SSE)
 *          GET  localhost:4242/health
 *
 * SSE response format: OpenAI chat.completion.chunk events.
 * Tool use is detected via delta.tool_calls[].id (new tool call start).
 *
 * Fallback: callClaudeCLI() spawns `claude -p` via bash when all gateway
 * providers are exhausted. The CLI uses a separate Anthropic quota tier
 * that isn't reachable via plain HTTP.
 */

import { trace, SpanStatusCode, context, propagation } from '@opentelemetry/api';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:4242';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const DEFAULT_PROVIDERS = (process.env.GATEWAY_PROVIDERS ?? 'anthropic').split(',');

const tracer = trace.getTracer('claudebot', '2.0.0');

// ─── SSE stream parsing ───────────────────────────────────────────────────────

/**
 * Collect all SSE events from a ReadableStream body.
 * Buffers incomplete lines across TCP-split chunks (Reviewer Concern #1).
 */
async function collectStream(body) {
  const decoder = new TextDecoder();
  const events = [];
  let remainder = '';

  for await (const chunk of body) {
    remainder += decoder.decode(chunk, { stream: true });
    const lines = remainder.split('\n');
    remainder = lines.pop(); // last element may be incomplete

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
      try {
        events.push(JSON.parse(trimmed.slice(6)));
      } catch {
        // malformed line — skip
      }
    }
  }

  return events;
}

/**
 * Reconstruct full text and tool calls from OpenAI SSE delta events.
 * Returns { text, toolCalls, toolUseCount }.
 */
function reconstruct(events) {
  let text = '';
  const toolCallMap = {}; // index → { id, name, arguments }

  for (const event of events) {
    for (const choice of (event.choices ?? [])) {
      const delta = choice.delta ?? {};
      if (delta.content) text += delta.content;

      for (const tc of (delta.tool_calls ?? [])) {
        if (!toolCallMap[tc.index]) {
          toolCallMap[tc.index] = { id: '', name: '', arguments: '' };
        }
        if (tc.id) toolCallMap[tc.index].id = tc.id;
        if (tc.function?.name) toolCallMap[tc.index].name = tc.function.name;
        if (tc.function?.arguments) toolCallMap[tc.index].arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls = Object.values(toolCallMap).filter((tc) => tc.id);
  return { text: text.trim(), toolCalls, toolUseCount: toolCalls.length };
}

// ─── Claude CLI fallback ──────────────────────────────────────────────────────

const CLAUDE_BIN      = process.env.CLAUDE_BIN ?? 'claude';
const CLAUDE_WORK_DIR = process.env.CLAUDE_WORK_DIR ?? 'C:\\Users\\Admin\\WorkPlace';

/**
 * Call Claude via the `claude -p` CLI subprocess, bypassing the local gateway.
 * The CLI uses a separate Anthropic quota tier not accessible via plain HTTP.
 * Prompt is written to a temp file and piped via bash to avoid Windows
 * argument-length and escaping limits.
 * OAuth env vars are stripped so the CLI uses ~/.claude/.credentials.json.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {string} [opts.system]
 * @returns {Promise<{text: string, toolCalls: [], toolUseCount: 0}>}
 */
export async function callClaudeCLI({ messages, system, onChunk }) {
  const parts = [];
  if (system) parts.push(`System: ${system}\n`);
  for (const m of messages) {
    parts.push(`${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`);
  }
  const prompt = parts.join('\n\n');

  // Strip OAuth tokens — CLI rejects them as invalid API keys and should use
  // ~/.claude/.credentials.json directly for the Claude Code quota tier.
  const cleanEnv = { ...process.env };
  delete cleanEnv.ANTHROPIC_BASE_URL;
  delete cleanEnv.GATEWAY_URL;
  if (cleanEnv.ANTHROPIC_API_KEY?.startsWith('sk-ant-oat')) delete cleanEnv.ANTHROPIC_API_KEY;
  delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;
  delete cleanEnv.ANTHROPIC_AUTH_TOKEN;

  // Write to temp file — avoids Windows CLI arg-length/escaping limits
  const tmpFile = join(tmpdir(), `claude-bot-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt, 'utf8');

  const toUnix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const binPath  = toUnix(CLAUDE_BIN);
  const filePath = toUnix(tmpFile);
  const workDir  = toUnix(CLAUDE_WORK_DIR);

  console.log('[claude-cli] Falling back to Claude CLI subprocess');

  return new Promise((resolve, reject) => {
    const child = spawn(
      'bash',
      ['-c', `cat "${filePath}" | "${binPath}" --add-dir "${workDir}" --dangerously-skip-permissions -p`],
      {
        cwd  : CLAUDE_WORK_DIR,
        env  : cleanEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (onChunk) onChunk(d.toString());
    });
    child.stderr.on('data', (d) => { stderr += d; });

    const cleanup = () => { try { unlinkSync(tmpFile); } catch {} };

    const timer = setTimeout(() => {
      child.kill();
      cleanup();
      reject(new Error('Claude CLI timed out after 120s'));
    }, 120_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve({ text: stdout.trim(), toolCalls: [], toolUseCount: 0 });
      }
    });
    child.on('error', (err) => { clearTimeout(timer); cleanup(); reject(err); });
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call the AI gateway with a messages array.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {string} [opts.system]       - prepended as role:'system' message
 * @param {string[]} [opts.providers]  - provider list for failover
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{text: string, toolCalls: Array, toolUseCount: number}>}
 */
export async function callGateway(opts, _retried = false) {
  const {
    messages,
    system,
    providers = DEFAULT_PROVIDERS,
    model = DEFAULT_MODEL,
    maxTokens = 4096,
  } = opts;

  return tracer.startActiveSpan('gateway.call', async (span) => {
    const t0 = Date.now();
    try {
      const fullMessages = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;

      const body = JSON.stringify({
        messages: fullMessages,
        providers,
        model,
        max_tokens: maxTokens,
      });

      // Inject W3C traceparent for context propagation into the gateway
      const headers = { 'Content-Type': 'application/json' };
      propagation.inject(context.active(), headers);

      const res = await fetch(`${GATEWAY_URL}/v1/chat`, {
        method: 'POST',
        headers,
        body,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');

        // OAuth token expired — sync from ~/.claude/.credentials.json, restart, retry once
        if (!_retried && errText.includes('invalid_grant')) {
          console.warn('[claude] invalid_grant — syncing tokens and restarting gateway');
          try {
            const { syncAndRestart } = await import('./gateway-manager.js');
            await syncAndRestart();
          } catch (syncErr) {
            console.error('[claude] Token sync/restart failed:', syncErr.message);
          }
          span.end();
          return callGateway(opts, true);
        }

        // All gateway providers exhausted — fall back to CLI subprocess
        if (res.status === 503) {
          console.warn('[claude] All gateway providers exhausted — falling back to Claude CLI');
          try {
            span.end();
            return await callClaudeCLI({ messages: opts.messages, system: opts.system });
          } catch (cliErr) {
            console.error('[claude] Claude CLI fallback failed:', cliErr.message);
            let retryAfter = 60;
            try { retryAfter = JSON.parse(errText)?.retry_after ?? 60; } catch {}
            const err = new Error(`All providers exhausted — retry in ${retryAfter}s`);
            err.code = 'GATEWAY_RATE_LIMITED';
            err.retryAfter = retryAfter;
            throw err;
          }
        }

        throw new Error(`Gateway ${res.status}: ${errText}`);
      }

      const events = await collectStream(res.body);
      const result = reconstruct(events);

      span.setAttribute('tool_use_count', result.toolUseCount);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Check gateway health. Returns true if reachable and healthy.
 * Exponential backoff: 1s, 2s, 4s (Reviewer Concern #2).
 */
export async function checkGatewayHealth(retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${GATEWAY_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
    } catch {
      // unreachable or timeout
    }
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt))); // 1s, 2s, 4s
    }
  }
  return false;
}
