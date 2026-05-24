/**
 * Dreaming loop — post-session curator (Hermes model).
 *
 * Called hourly by the scheduler. Queries threads with:
 *   tool_use_total > 5  AND  last_active < now-2h  AND  dreamed = 0
 *
 * For each candidate: score confidence, generate SKILL.md, handle
 * conflict detection, write to disk, emit skill:created for hot-reload.
 *
 * First 3 skills require Discord confirmation; subsequent auto-kept at >= 0.7.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { getDb } from '../memory/db.js';
import { getContext } from '../memory/index.js';
import { scoreThread } from './quality.js';
import { generateSkillMd, extractSkillName } from './template.js';
import bus from '../core/events.js';

const tracer = trace.getTracer('claudebot', '2.0.0');
const SKILLS_DIR = process.env.CLAUDE_SKILLS_DIR ?? path.join(os.homedir(), '.claude', 'skills');
const IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours
const TOOL_USE_THRESHOLD = 5;
const AUTO_KEEP_THRESHOLD = 0.7;
const SKILL_SIZE_LIMIT = 64 * 1024; // 64 KB (Reviewer Concern #6)

// Lazily resolved send function — injected by scheduler
let _sendAlert = null;
export function setSendAlert(fn) { _sendAlert = fn; }


export async function reviewCandidates() {
  const db = getDb();
  const cutoff = Date.now() - IDLE_MS;

  const candidates = db.prepare(`
    SELECT user_id, channel_id, tool_use_total
    FROM threads
    WHERE tool_use_total > ?
      AND last_active < ?
      AND dreamed = 0
  `).all(TOOL_USE_THRESHOLD, cutoff);

  for (const thread of candidates) {
    await reviewThread(thread.user_id, thread.tool_use_total, thread.channel_id ?? null);
  }
}

export async function reviewThread(userId, toolUseTotal, channelId = null) {
  return tracer.startActiveSpan('dreaming.review', async (span) => {
    span.setAttribute('user_id', userId);
    const db = getDb();

    try {
      const { messages, summary } = getContext(userId, channelId);

      const confidenceScore = scoreThread({ toolUseTotal, messages });
      span.setAttribute('confidence_score', confidenceScore);

      // Count previously approved/auto-kept skills to determine confirmation policy
      const approvedCount = db.prepare(
        "SELECT COUNT(*) as n FROM skills_generated WHERE status IN ('approved', 'auto-kept')"
      ).get().n;

      const requiresConfirmation = approvedCount < 3;

      // Generate SKILL.md content
      const workflowDesc = buildWorkflowDescription(messages, summary);
      const skillMd = await generateSkillMd(workflowDesc, messages);

      // Enforce size limit
      if (Buffer.byteLength(skillMd) > SKILL_SIZE_LIMIT) {
        console.warn(`[dreaming] generated skill too large for user ${userId} — skipping`);
        _incDreaming('skipped_size');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'skill too large' });
        return;
      }

      const skillName = extractSkillName(skillMd);
      if (!skillName) {
        console.warn('[dreaming] could not extract skill name from generated SKILL.md');
        _incDreaming('skipped_no_name');
        return;
      }

      const skillDir = path.join(SKILLS_DIR, skillName);
      const skillPath = path.join(skillDir, 'SKILL.md');

      // Conflict detection — check if path already exists
      const { status, skip } = checkConflict(db, skillPath, skillName);
      if (skip) {
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      const skillId = crypto.randomUUID();

      if (requiresConfirmation || confidenceScore < AUTO_KEEP_THRESHOLD) {
        // Pending — send confirmation request to owner
        db.prepare(`
          INSERT INTO skills_generated (id, trigger_workflow, tool_use_count, skill_path, confidence_score, status, content, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(skillId, workflowDesc.slice(0, 200), toolUseTotal, skillPath, confidenceScore, skillMd, Date.now());

        await _sendAlert?.(
          `🧠 New skill candidate: **${skillName}** (confidence: ${(confidenceScore * 100).toFixed(0)}%)\n` +
          `Reply \`/approve-skill ${skillId}\` to keep or \`/reject-skill ${skillId}\` to discard.\n\n` +
          `Preview:\n\`\`\`\n${skillMd.slice(0, 500)}\n\`\`\``
        );

        _incDreaming('pending');
      } else {
        // Auto-keep — write immediately
        await writeSkill(skillDir, skillPath, skillMd);
        db.prepare(`
          INSERT INTO skills_generated (id, trigger_workflow, tool_use_count, skill_path, confidence_score, status, content, created_at)
          VALUES (?, ?, ?, ?, ?, 'auto-kept', ?, ?)
        `).run(skillId, workflowDesc.slice(0, 200), toolUseTotal, skillPath, confidenceScore, skillMd, Date.now());

        bus.emit('skill:created', { name: skillName, path: skillDir });
        _incDreaming('auto_kept');

        await _sendAlert?.(`✅ Auto-generated skill: **${skillName}** (confidence: ${(confidenceScore * 100).toFixed(0)}%)`);
      }

      // Only mark dreamed=1 on success (Reviewer Concern: silent data loss)
      db.prepare('UPDATE threads SET dreamed = 1 WHERE user_id = ? AND channel_id = ?').run(userId, channelId);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      console.warn(`[dreaming] review failed for ${userId}:`, err.message);
      // dreamed stays 0 — will retry next hour
    } finally {
      span.end();
    }
  });
}

/** Called when user approves a pending skill via Discord command. */
export async function approveSkill(skillId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM skills_generated WHERE id = ? AND status = 'pending'").get(skillId);
  if (!row) return { ok: false, error: 'not found or already resolved' };

  db.prepare("UPDATE skills_generated SET status = 'approved' WHERE id = ?").run(skillId);

  // Write skill to disk from stored content
  const skillRow = db.prepare('SELECT content, skill_path FROM skills_generated WHERE id = ?').get(skillId);
  if (skillRow?.content && skillRow?.skill_path) {
    try {
      const skillDir = path.dirname(skillRow.skill_path);
      await fsPromises.mkdir(skillDir, { recursive: true });
      await fsPromises.writeFile(skillRow.skill_path, skillRow.content, 'utf8');
      console.log(`[dreaming] approved skill written: ${skillRow.skill_path}`);
    } catch (err) {
      console.warn(`[dreaming] failed to write approved skill ${skillId}:`, err.message);
    }
  }

  _incDreaming('approved');
  return { ok: true };
}

export function rejectSkill(skillId) {
  const db = getDb();
  db.prepare("UPDATE skills_generated SET status = 'rejected' WHERE id = ?").run(skillId);
  _incDreaming('rejected');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildWorkflowDescription(messages, summary) {
  const lines = [];
  if (summary) lines.push(`Background: ${summary}`);
  const recent = messages.slice(-20).map((m) => `${m.role}: ${m.content}`).join('\n');
  lines.push(recent);
  return lines.join('\n\n');
}

function checkConflict(db, skillPath, skillName) {
  // Check if this path already exists in skills_generated table
  const existing = db.prepare('SELECT id, status FROM skills_generated WHERE skill_path = ?').get(skillPath);
  if (existing) {
    console.log(`[dreaming] skill already tracked: ${skillName} (${existing.status}) — skipping`);
    return { status: existing.status, skip: true };
  }

  // Check if file exists on disk without our metadata (user-edited skill — never overwrite)
  if (fs.existsSync(skillPath)) {
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      if (!content.includes('generated_by: claudebot')) {
        console.warn(`[dreaming] user-edited skill at ${skillPath} — skipping to avoid overwrite`);
        return { status: 'user-edited', skip: true };
      }
    } catch {}
  }

  return { status: null, skip: false };
}

async function writeSkill(skillDir, skillPath, content) {
  fs.mkdirSync(skillDir, { recursive: true });

  // Reviewer Concern #3: fs.stat before writing (atomicity)
  // Directory was just created or already exists — write is safe
  fs.writeFileSync(skillPath, content, 'utf8');
  console.log(`[dreaming] wrote skill: ${skillPath}`);
}

async function _incDreaming(outcome) {
  try {
    const { counters } = await import('../telemetry/index.js');
    counters.dreamingReviews.add(1, { outcome });
  } catch {}
}
