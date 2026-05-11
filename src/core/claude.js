/**
 * AI gateway HTTP client — replaces the old claude CLI subprocess.
 *
 * Gateway: POST localhost:4242/v1/chat  (OpenAI-compatible SSE)
 *          GET  localhost:4242/health
 *
 * SSE response format: OpenAI chat.completion.chunk events.
 * Tool use is detected via delta.tool_calls[].id (new tool call start).
 */

import { trace, SpanStatusCode, context, propagation } from '@opentelemetry/api';

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
export async function callGateway(opts) {
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
