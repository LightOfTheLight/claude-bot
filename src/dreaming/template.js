/**
 * SKILL.md template for auto-generated skills.
 *
 * The dreaming loop calls generateSkillMd() with a description of the
 * workflow to codify, then writes the result to ~/.claude/skills/<name>/SKILL.md.
 */

import { callGateway } from '../core/claude.js';

const SYSTEM_PROMPT = `You are generating a gstack skill file (SKILL.md) for a personal AI assistant.
A skill file documents a repeatable workflow so it can be invoked by name next time.

Output ONLY a valid SKILL.md — no explanation, no markdown code fence.
The file must start with YAML frontmatter between --- markers.

Required frontmatter fields:
  name: (slug, lowercase, hyphens — e.g. "ship-branch")
  description: (one sentence describing what the skill does)
  generated_by: claudebot
  triggers:
    - (2-4 natural language phrases that would invoke this skill)

After the frontmatter, write the skill body:
- Step-by-step instructions the bot should follow
- Any commands or templates needed
- Keep it under 2000 words`;

export async function generateSkillMd(workflowDescription, messages) {
  const userPrompt = `Generate a SKILL.md for this workflow:\n\n${workflowDescription}\n\nRecent conversation context:\n${
    messages
      .slice(-10)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')
  }`;

  const { text } = await callGateway({
    messages: [{ role: 'user', content: userPrompt }],
    system: SYSTEM_PROMPT,
    maxTokens: 2048,
  });

  return text;
}

export function extractSkillName(skillMd) {
  const match = skillMd.match(/^name:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
