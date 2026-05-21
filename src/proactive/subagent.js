/**
 * Sub-agent spawner for the proactive dispatcher.
 *
 * When a concern hit qualifies (high confidence + eligible template), a specialist
 * Claude CLI subprocess is spawned asynchronously. It produces a concrete,
 * action-oriented follow-up and posts it to the same channel/DM as the original
 * concern notice — without blocking the per-minute cron.
 *
 * Opt-in: set PROACTIVE_SUBAGENT_ENABLED=true in .env.
 * Eligible templates (default): UNRESOLVED_INTENT, UNRESOLVED_THREAD
 * Minimum confidence (default): 0.85
 * Timeout: 2 minutes per sub-agent call
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { getDb } from '../memory/db.js';

const SUBAGENT_TIMEOUT_MS = 2 * 60 * 1000;
const SUBAGENT_MAX_TOKENS = '1500';

const DEFAULT_TEMPLATES = new Set(['UNRESOLVED_INTENT', 'UNRESOLVED_THREAD']);
const DEFAULT_MIN_CONFIDENCE = 0.85;

function getEligibleTemplates() {
  const env = process.env.SUBAGENT_TEMPLATES;
  if (env) return new Set(env.split(',').map((t) => t.trim().toUpperCase()));
  return DEFAULT_TEMPLATES;
}

function getMinConfidence() {
  const val = parseFloat(process.env.SUBAGENT_MIN_CONFIDENCE ?? '');
  return Number.isFinite(val) ? val : DEFAULT_MIN_CONFIDENCE;
}

/**
 * Returns true if this hit should trigger a sub-agent follow-up.
 */
export function shouldSpawnSubAgent(hit) {
  if (!process.env.PROACTIVE_SUBAGENT_ENABLED) return false;
  return getEligibleTemplates().has(hit.template) && hit.confidence >= getMinConfidence();
}

function buildSubAgentPrompt(userId, hit, contextText) {
  const taskDescriptions = {
    UNRESOLVED_INTENT: [
      `The user mentioned wanting to ${hit.context} but never followed through.`,
      `Your job: provide a concrete, actionable first step or mini-plan that directly moves this forward.`,
      `Be specific — give bullet points, commands, or a short checklist where appropriate.`,
    ].join(' '),

    UNRESOLVED_THREAD: [
      `The user had an active conversation that went silent. ${hit.context}.`,
      `Your job: summarize where things stood and propose the clearest next action to resolve it.`,
    ].join(' '),
  };

  const task = taskDescriptions[hit.template]
    ?? `Address this concern with a concrete, actionable response: ${hit.context}`;

  return `You are a specialist AI agent doing a follow-up action for user ${userId}.

${task}

Conversation context (most recent first):
${contextText}

Instructions:
- Do NOT just restate the concern — take action on it
- Be specific and direct (max 3 short paragraphs or a bulleted list)
- If you can draft a plan, first step, or checklist, do it
- No pleasantries or preamble
Prefix your response with: 🤖 Follow-up:`;
}

function spawnAsync(prompt) {
  return new Promise((resolve) => {
    const chunks = [];
    const proc = spawn('claude', ['-p', prompt, '--max-tokens', SUBAGENT_MAX_TOKENS], {
      shell: false,
    });

    proc.stdout.on('data', (d) => chunks.push(d.toString()));
    proc.stderr.on('data', () => {}); // swallow stderr — errors surfaced via exit code

    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    proc.on('close', (code) => {
      finish(code === 0 && chunks.length ? chunks.join('').trim() : null);
    });
    proc.on('error', () => finish(null));

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      finish(null);
    }, SUBAGENT_TIMEOUT_MS);
  });
}

/**
 * Runs the sub-agent asynchronously and posts the result as a follow-up message.
 * Call without await — this is intentionally fire-and-forget from the cron perspective.
 *
 * @param {object} hit            - Concern hit from checkAll()
 * @param {string} userId
 * @param {object} prefs          - User preferences
 * @param {string} contextText    - Pre-built context string (reuse from sendConcernHit)
 * @param {object} platformSenders
 * @param {Function} sendOwnerAlert
 */
export async function runSubAgent(hit, userId, prefs, contextText, platformSenders, sendOwnerAlert) {
  const prompt = buildSubAgentPrompt(userId, hit, contextText);

  console.log(`[subagent] spawning for user=${userId} template=${hit.template} confidence=${hit.confidence}`);

  const result = await spawnAsync(prompt);
  if (!result) {
    console.warn(`[subagent] no output for user=${userId} template=${hit.template}`);
    return;
  }

  // Deliver via the same channel/DM as the concern notice
  const channelId = prefs?.proactive_channel_id || process.env.PROACTIVE_CHANNEL_ID;
  let discordMessageId = null;

  if (channelId && platformSenders?.discord?.sendToChannel) {
    discordMessageId = await platformSenders.discord.sendToChannel(channelId, result);
  } else if (prefs?.discord_user_id && platformSenders?.discord?.sendDM) {
    discordMessageId = await platformSenders.discord.sendDM(prefs.discord_user_id, result);
  }

  if (!discordMessageId) return;

  // Record the sub-agent send so it appears in the dashboard and is deduped normally
  const db = getDb();
  db.prepare(
    `INSERT INTO proactive_sends
       (id, user_id, kind, channel_id, message, sent_at, template, confidence, discord_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    userId,
    `subagent_${hit.template}`,
    channelId ?? null,
    result,
    Date.now(),
    hit.template,
    hit.confidence,
    discordMessageId,
  );

  console.log(`[subagent] follow-up sent for user=${userId} template=${hit.template}`);
}
