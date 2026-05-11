/**
 * skills-map.js — auto-discovers ~/.claude/skills/ at startup and hot-reloads
 * when a new skill is written by the dreaming loop.
 *
 * Parses SKILL.md frontmatter (name, triggers, voice-triggers) to build an
 * in-memory routing map used by the intent router.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import bus from '../core/events.js';

const SKILLS_DIR = process.env.CLAUDE_SKILLS_DIR ?? path.join(os.homedir(), '.claude', 'skills');

// name → { name, triggers: string[], skillPath: string, content: string }
const skillsMap = new Map();

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    return yaml.load(match[1]);
  } catch {
    return null;
  }
}

function loadSkill(skillDir) {
  const skillPath = path.join(skillDir, 'SKILL.md');

  // Reviewer Concern #3: check file exists before reading
  try { fs.statSync(skillPath); } catch { return; }

  const content = fs.readFileSync(skillPath, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm?.name) return;

  const triggers = [
    ...(fm.triggers ?? []),
    ...(fm['voice-triggers'] ?? []),
  ].map((t) => String(t).toLowerCase());

  skillsMap.set(fm.name, { name: fm.name, triggers, skillPath, content });
}

export function loadSkillsMap() {
  skillsMap.clear();
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log('[skills-map] skills dir not found:', SKILLS_DIR);
    return;
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    loadSkill(path.join(SKILLS_DIR, entry.name));
  }
  console.log(`[skills-map] loaded ${skillsMap.size} skill(s)`);
}

// Hot-reload: dreaming loop emits 'skill:created' after writing a new SKILL.md
bus.on('skill:created', ({ name, path: skillDir }) => {
  loadSkill(skillDir);
  console.log(`[skills-map] hot-reloaded skill: ${name}`);
});

export function getSkill(name) {
  return skillsMap.get(name) ?? null;
}

export function getAllSkills() {
  return [...skillsMap.values()];
}

/**
 * Build a compact routing hints string for injection into the router prompt.
 * Format: "skill_name: trigger1, trigger2"
 */
export function buildRoutingHints() {
  return [...skillsMap.entries()]
    .map(([name, s]) => `${name}: ${s.triggers.slice(0, 3).join(', ')}`)
    .join('\n');
}
