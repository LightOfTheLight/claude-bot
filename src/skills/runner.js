/**
 * Skill runner — injects SKILL.md content + memory context, calls gateway,
 * returns text + toolUseCount.
 */

import { callGateway } from '../core/claude.js';
import { getSkill } from '../router/skills-map.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const SKILL_SIZE_LIMIT = 64 * 1024; // 64 KB (Reviewer Concern #6 — also enforced in dreaming writer)
const tracer = trace.getTracer('claudebot', '2.0.0');

export async function runSkill(skillName, { messages, summary, learnings, userId }) {
  return tracer.startActiveSpan('skill.run', async (span) => {
    span.setAttribute('skill', skillName);
    try {
      const skill = getSkill(skillName);
      if (!skill) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'skill not found' });
        return { text: `Skill "${skillName}" not found.`, toolUseCount: 0 };
      }

      const skillContent = skill.content.slice(0, SKILL_SIZE_LIMIT);

      const systemParts = [
        `You are ${process.env.BOT_NAME ?? 'Claude'}, a helpful AI assistant.`,
        `Execute the following skill:\n\n${skillContent}`,
      ];
      if (summary) systemParts.push(`Conversation summary: ${summary}`);
      if (learnings?.length) {
        systemParts.push(`User insights: ${learnings.map((l) => `${l.key}: ${l.insight}`).join('; ')}`);
      }

      const result = await callGateway({
        messages,
        system: systemParts.join('\n\n'),
      });

      span.setAttribute('tool_use_count', result.toolUseCount);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
