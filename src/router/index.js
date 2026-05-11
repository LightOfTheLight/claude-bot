/**
 * Intent router — classifies incoming messages via a single gateway call.
 *
 * Output intents:
 *   skill_dispatch  { intent, skill }
 *   reminder        { intent, fire_at (ISO 8601), message }
 *   general         { intent }
 *   unknown         { intent }
 */

import { callGateway } from '../core/claude.js';
import { buildRoutingHints, loadSkillsMap } from './skills-map.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('claudebot', '2.0.0');

// Load skills on first import
loadSkillsMap();

const SYSTEM_PROMPT = `You are an intent classifier for a personal AI assistant.
Given a user message and available skills, output ONLY a JSON object — no markdown, no explanation.

Available skills:
{SKILLS}

Output format:
{ "intent": "skill_dispatch", "skill": "<skill_name>" }
{ "intent": "reminder", "fire_at": "<ISO 8601>", "message": "<reminder text>" }
{ "intent": "general" }
{ "intent": "unknown" }

Rules:
- Use skill_dispatch only when the message clearly matches a skill trigger
- For reminders, extract the exact time and message text; fire_at must be ISO 8601
- Default to general for conversational messages
- Use unknown only when the message is incomprehensible`;

export async function classifyIntent(userText, recentMessages = []) {
  return tracer.startActiveSpan('router.classify', async (span) => {
    try {
      const skills = buildRoutingHints();
      const system = SYSTEM_PROMPT.replace('{SKILLS}', skills || '(none loaded)');

      // Use only the last 3 messages for router context (keep prompt small)
      const context = recentMessages.slice(-3);
      const messages = [
        ...context,
        { role: 'user', content: `Classify this message: "${userText}"` },
      ];

      const { text } = await callGateway({ messages, system, maxTokens: 256 });

      const intent = parseIntent(text, userText);
      span.setAttribute('intent', intent.intent);
      span.setStatus({ code: SpanStatusCode.OK });
      return intent;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      // Fallback to general on any router failure
      return { intent: 'general' };
    } finally {
      span.end();
    }
  });
}

function parseIntent(raw, originalText) {
  // Strip possible markdown code fences
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { intent: 'general' };
  }

  if (!parsed?.intent) return { intent: 'general' };

  if (parsed.intent === 'reminder') {
    // Reviewer Concern #5: validate fire_at before trusting it
    const ts = Date.parse(parsed.fire_at);
    if (!Number.isFinite(ts) || ts <= Date.now()) {
      console.warn('[router] invalid fire_at from LLM:', parsed.fire_at);
      return { intent: 'general' };
    }
    return { intent: 'reminder', fire_at: parsed.fire_at, message: parsed.message ?? originalText };
  }

  if (parsed.intent === 'skill_dispatch' && parsed.skill) {
    return { intent: 'skill_dispatch', skill: parsed.skill };
  }

  return { intent: parsed.intent === 'unknown' ? 'unknown' : 'general' };
}
