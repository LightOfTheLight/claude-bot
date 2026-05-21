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
import { writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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
// ─── CLI session tracking ─────────────────────────────────────────────────────

/**
 * Convert a Windows/Unix work dir to the slug Claude Code uses for its
 * project directory, e.g. C:\Users\Admin\WorkPlace → C--Users-Admin-WorkPlace
 */
function workDirToSlug(workDir) {
  return workDir.replace(/:/g, '-').replace(/[\\\/]/g, '-');
}

/**
 * Return the session ID (UUID filename) of the most recently touched .jsonl
 * in the Claude Code project directory for CLAUDE_WORK_DIR.
 * Returns null if the directory is missing or empty.
 */
function getNewestSessionId() {
  try {
    const projectDir = join(homedir(), '.claude', 'projects', workDirToSlug(CLAUDE_WORK_DIR));
    const newest = readdirSync(projectDir)
      .filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f))
      .map((f) => ({ id: f.slice(0, -6), mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest?.id ?? null;
  } catch {
    return null;
  }
}

/** Detect if a response is just asking for Y/N/edit confirmation. */
function isConfirmationPrompt(text) {
  // Matches patterns like [Y/n], [Y/edit/skip], [y/N], [yes/no], etc.
  return /\[[Yy][\/|][^\]]{0,20}\]\s*$/.test(text.trim()) ||
    /\b(proceed|continue|confirm|ready)\??\s*\[[Yy][^\]]*\]\s*$/i.test(text.trim());
}

/**
 * Run a single CLI subprocess for a given prompt string.
 *
 * @param {string}    prompt
 * @param {object}    cleanEnv
 * @param {function}  [onChunk]     - called with each stdout chunk while streaming
 * @param {function}  [onHeartbeat] - called every HEARTBEAT_MS while alive
 * @param {string}    [sessionId]   - if set, passes --resume <sessionId> to continue
 *                                    an existing Claude Code session instead of starting fresh
 */
function spawnCLI(prompt, cleanEnv, onChunk, onHeartbeat, sessionId) {
  const HEARTBEAT_MS   = 15_000;   // ping caller every 15 s while alive
  const INACTIVITY_MS  = 600_000;  // kill after 10 min of total silence

  const tmpFile = join(tmpdir(), `claude-bot-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt, 'utf8');

  const toUnix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const binPath  = toUnix(CLAUDE_BIN);
  const filePath = toUnix(tmpFile);
  const workDir  = toUnix(CLAUDE_WORK_DIR);

  const resumeFlag = sessionId ? `--resume "${sessionId}"` : `--add-dir "${workDir}"`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      'bash',
      ['-c', `cat "${filePath}" | "${binPath}" ${resumeFlag} --dangerously-skip-permissions --permission-mode bypassPermissions -p`],
      { cwd: CLAUDE_WORK_DIR, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let lastActivity = Date.now();

    child.stdout.on('data', (d) => {
      lastActivity = Date.now();
      stdout += d;
      if (onChunk) onChunk(d.toString());
    });
    child.stderr.on('data', (d) => { stderr += d; });

    const cleanup = () => { try { unlinkSync(tmpFile); } catch {} };

    // Heartbeat: fires every HEARTBEAT_MS while the process is alive.
    // Kills the process if it has been silent for INACTIVITY_MS.
    const heartbeat = setInterval(() => {
      const idleMs = Date.now() - lastActivity;
      if (idleMs >= INACTIVITY_MS) {
        clearInterval(heartbeat);
        child.kill();
        cleanup();
        reject(new Error(`Claude CLI timed out — no output for ${Math.round(idleMs / 1000)}s`));
        return;
      }
      if (onHeartbeat) onHeartbeat(idleMs);
    }, HEARTBEAT_MS);

    child.on('close', (code) => {
      clearInterval(heartbeat); cleanup();
      if (code !== 0) reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300)}`));
      else resolve(stdout.trim());
    });
    child.on('error', (err) => { clearInterval(heartbeat); cleanup(); reject(err); });
  });
}

function buildPrompt(messages, system) {
  const parts = [];
  if (system) parts.push(`System: ${system}\n`);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLast = i === messages.length - 1;
    const content = (isLast && m.role === 'user') ? m.content + AUTONOMOUS_NOTE : m.content;
    parts.push(`${m.role === 'user' ? 'Human' : 'Assistant'}: ${content}`);
  }
  return parts.join('\n\n');
}

const AUTONOMOUS_NOTE = '\n\n[Bot mode: execute autonomously, no confirmation needed, just act and report.]';

/**
 * Call Claude via the `claude -p` CLI subprocess.
 *
 * Session continuity (CLI-specific):
 *   Pass `sessionId` to resume an existing Claude Code session.  When resuming,
 *   only the latest user message is sent as the prompt — the CLI already holds
 *   full tool-use history for that session.  The new session ID is returned so
 *   callers can persist it for the next turn.
 *   Falls back to a full-history prompt if the session ID is stale/missing.
 *
 * @param {object}   opts
 * @param {Array}    opts.messages
 * @param {string}   [opts.system]
 * @param {function} [opts.onChunk]
 * @param {function} [opts.onHeartbeat]
 * @param {string}   [opts.sessionId]   - Claude Code session UUID to resume
 * @returns {Promise<{text, toolCalls, toolUseCount, sessionId}>}
 */
export async function callClaudeCLI({ messages, system, onChunk, onHeartbeat, sessionId }) {
  // Strip OAuth tokens — CLI must use ~/.claude/.credentials.json
  const cleanEnv = { ...process.env };
  delete cleanEnv.ANTHROPIC_BASE_URL;
  delete cleanEnv.GATEWAY_URL;
  if (cleanEnv.ANTHROPIC_API_KEY?.startsWith('sk-ant-oat')) delete cleanEnv.ANTHROPIC_API_KEY;
  delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;
  delete cleanEnv.ANTHROPIC_AUTH_TOKEN;

  const MAX_AUTO_CONFIRMS = 5;
  let currentSessionId = sessionId ?? null;
  let usingResume = !!currentSessionId;

  const makePrompt = (msgs, sys, overrideText) => {
    if (overrideText !== undefined) return overrideText;
    if (usingResume) {
      // Resume mode: send only the latest user message — CLI has the rest
      return msgs[msgs.length - 1].content + AUTONOMOUS_NOTE;
    }
    return buildPrompt(msgs, sys);
  };

  console.log(`[claude-cli] Starting CLI (${usingResume ? `resume ${currentSessionId.slice(0, 8)}…` : 'fresh'})`);

  const currentMessages = [...messages];

  for (let attempt = 0; attempt <= MAX_AUTO_CONFIRMS; attempt++) {
    const overrideText = attempt > 0 ? 'Y' : undefined; // auto-confirm iterations
    const prompt = makePrompt(currentMessages, system, overrideText);

    let text;
    try {
      text = await spawnCLI(
        prompt, cleanEnv,
        attempt === 0 ? onChunk     : null,
        attempt === 0 ? onHeartbeat : null,
        attempt === 0 ? currentSessionId : currentSessionId, // always resume once we have an ID
      );
    } catch (err) {
      if (usingResume && attempt === 0) {
        // Session likely expired — retry as a fresh call with full history
        console.warn(`[claude-cli] Resume failed (${err.message.slice(0, 80)}) — falling back to fresh start`);
        usingResume = false;
        currentSessionId = null;
        text = await spawnCLI(
          buildPrompt(currentMessages, system), cleanEnv,
          onChunk, onHeartbeat, null,
        );
      } else {
        throw err;
      }
    }

    // Capture the session ID created/updated by this subprocess
    currentSessionId = getNewestSessionId() ?? currentSessionId;

    if (!isConfirmationPrompt(text) || attempt === MAX_AUTO_CONFIRMS) {
      return { text, toolCalls: [], toolUseCount: 0, sessionId: currentSessionId };
    }

    console.log(`[claude-cli] Auto-confirming (attempt ${attempt + 1}): "${text.slice(-80)}"`);
    currentMessages.push({ role: 'assistant', content: text });
    currentMessages.push({ role: 'user', content: 'Y' });
  }

  throw new Error('Auto-confirm loop exhausted');
}

// ─── Request size guard ───────────────────────────────────────────────────────

const MAX_BODY_BYTES = 800_000; // 800 KB — stays under typical 1 MB gateway limits
const MAX_MSG_CHARS  =  8_000;  // per-message cap before we start dropping history

/**
 * Trim a messages array so the JSON body stays within maxBytes.
 *
 * Strategy:
 *   1. Truncate any individual message content that exceeds MAX_MSG_CHARS.
 *   2. If the body is still too large, drop the oldest non-system messages
 *      one at a time, always preserving the system message and the final
 *      user turn.
 */
function trimMessages(messages, maxBytes) {
  let result = messages.map((m) =>
    m.content && m.content.length > MAX_MSG_CHARS
      ? { ...m, content: m.content.slice(0, MAX_MSG_CHARS) + '\n…[truncated]' }
      : m
  );

  // First non-system, non-final index to drop from
  while (JSON.stringify(result).length > maxBytes && result.length > 2) {
    const dropIdx = result[0]?.role === 'system' ? 1 : 0;
    if (dropIdx >= result.length - 1) break; // can't drop the last message
    result = [...result.slice(0, dropIdx), ...result.slice(dropIdx + 1)];
  }

  return result;
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

      const trimmedMessages = trimMessages(fullMessages, MAX_BODY_BYTES);
      if (trimmedMessages.length < fullMessages.length) {
        console.warn(`[claude] Body too large — dropped ${fullMessages.length - trimmedMessages.length} message(s) from history`);
      }

      const body = JSON.stringify({
        messages: trimmedMessages,
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
        // Anthropic returns 429 for expired tokens (not 401), so check both cases
        const isAnthropicAuth = res.status === 401 || (res.status === 429 && errText.includes('invalid_grant'));
        const isExpiredToken  = errText.includes('invalid_grant') || errText.includes('expired') || errText.includes('token');
        if (!_retried && (isAnthropicAuth || (res.status === 401 && isExpiredToken))) {
          console.warn('[claude] Auth error — syncing tokens and restarting gateway');
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
