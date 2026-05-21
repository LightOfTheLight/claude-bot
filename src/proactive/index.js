import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { getDb } from '../memory/db.js';
import { getRecentMessages, getProactiveUsers } from '../memory/index.js';
import { buildBriefPrompt, buildConcernPrompt } from './templates.js';
import { checkAll } from './trigger.js';
import { shouldSpawnSubAgent, runSubAgent } from './subagent.js';

const DEDUP_WINDOW_MS = 20 * 60 * 60 * 1000; // 20h
const MAX_CONCURRENT = 3;
const CONTEXT_TOKEN_CAP = 4000;

let _proactiveRunning = false;

function estimateTokens(text) {
  return Math.floor(text.length / 4);
}

function isWeekendFor(tz) {
  const day = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: tz || 'UTC' });
  return day === 'Sat' || day === 'Sun';
}

function getCurrentHourFor(tz) {
  return parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz || 'UTC' }), 10);
}

function isDedupedFor(userId, kind) {
  const db = getDb();
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  const row = db.prepare('SELECT id FROM proactive_sends WHERE user_id = ? AND kind = ? AND sent_at > ?').get(userId, kind, cutoff);
  return !!row;
}

function callClaude(prompt, context) {
  let fullPrompt = prompt;
  if (context) {
    let ctx = context;
    while (estimateTokens(fullPrompt + '\n\nContext:\n' + ctx) > CONTEXT_TOKEN_CAP && ctx.length > 100) {
      ctx = ctx.slice(0, Math.floor(ctx.length * 0.8));
    }
    fullPrompt = fullPrompt + '\n\nContext:\n' + ctx;
  }
  const result = spawnSync('claude', ['-p', fullPrompt, '--max-tokens', '500'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  return result.stdout.trim();
}

async function sendConcernHit(hit, userId, prefs, platformSenders, sendOwnerAlert) {
  const tz = prefs?.timezone || process.env.TZ || 'UTC';
  const isWeekend = isWeekendFor(tz);
  const prompt = buildConcernPrompt(userId, hit.template, hit.context || hit.message, isWeekend);
  const recentMsgs = getRecentMessages(userId, 10);
  const contextText = recentMsgs.map(m => `${m.role}: ${m.content}`).join('\n');
  const message = callClaude(prompt, contextText);
  if (!message) return;

  const channelId = prefs?.proactive_channel_id || process.env.PROACTIVE_CHANNEL_ID;
  let discordMessageId = null;

  if (channelId && platformSenders?.discord?.sendToChannel) {
    discordMessageId = await platformSenders.discord.sendToChannel(channelId, message);
  } else if (prefs?.discord_user_id && platformSenders?.discord?.sendDM) {
    discordMessageId = await platformSenders.discord.sendDM(prefs.discord_user_id, message);
  }

  if (!discordMessageId) return;

  const db = getDb();
  db.prepare('INSERT INTO proactive_sends (id, user_id, kind, channel_id, message, sent_at, template, confidence, discord_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    randomUUID(), userId, `trigger_${hit.template}`, channelId || null, message, Date.now(), hit.template, hit.confidence, discordMessageId
  );

  // Spawn a specialist follow-up sub-agent for high-confidence actionable hits.
  // Intentionally not awaited — runs async so the per-minute cron is not blocked.
  if (shouldSpawnSubAgent(hit)) {
    runSubAgent(hit, userId, prefs, contextText, platformSenders, sendOwnerAlert)
      .catch((err) => console.error('[proactive] subagent error:', err));
  }
}

async function _runForUser(user, kind, platformSenders, sendOwnerAlert) {
  const { userId, prefs } = user;
  if (isDedupedFor(userId, kind)) return;

  const tz = prefs?.timezone || process.env.TZ || 'UTC';
  const isWeekend = isWeekendFor(tz);

  const recentMsgs = getRecentMessages(userId, 20);
  const contextText = recentMsgs.map(m => `${m.role}: ${m.content}`).join('\n');

  const prompt = buildBriefPrompt(userId, kind, isWeekend);
  const message = callClaude(prompt, contextText);
  if (!message) return;

  const channelId = prefs?.proactive_channel_id || process.env.PROACTIVE_CHANNEL_ID;
  let discordMessageId = null;

  if (channelId && platformSenders?.discord?.sendToChannel) {
    discordMessageId = await platformSenders.discord.sendToChannel(channelId, message);
  } else if (prefs?.discord_user_id && platformSenders?.discord?.sendDM) {
    discordMessageId = await platformSenders.discord.sendDM(prefs.discord_user_id, message);
  }

  if (!discordMessageId) return;

  const db = getDb();
  db.prepare('INSERT INTO proactive_sends (id, user_id, kind, channel_id, message, sent_at, discord_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    randomUUID(), userId, kind, channelId || null, message, Date.now(), discordMessageId
  );
}

async function runWithSemaphore(tasks, max) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(task).catch(err => console.error('[proactive] task error:', err));
    results.push(p);
    if (max <= tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= max) await Promise.race(executing);
    }
  }
  return Promise.allSettled(results);
}

export async function runScheduled(platformSenders, sendOwnerAlert) {
  if (!process.env.PROACTIVE_ENABLED) return;
  if (_proactiveRunning) return;
  _proactiveRunning = true;

  try {
    const users = getProactiveUsers();
    if (!users.length) return;

    const tasks = [];
    for (const user of users) {
      const tz = user.prefs?.timezone || process.env.TZ || 'UTC';
      const hour = getCurrentHourFor(tz);
      const morningHour = parseInt(process.env.PROACTIVE_MORNING_HOUR || '7', 10);
      const nightHour = parseInt(process.env.PROACTIVE_NIGHT_HOUR || '21', 10);

      if (hour === morningHour) {
        tasks.push(() => _runForUser(user, 'morning_brief', platformSenders, sendOwnerAlert));
      } else if (hour === nightHour) {
        tasks.push(() => _runForUser(user, 'nightly_sync', platformSenders, sendOwnerAlert));
      }
    }

    if (tasks.length) await runWithSemaphore(tasks, MAX_CONCURRENT);
  } catch (err) {
    console.error('[proactive] runScheduled error:', err);
  } finally {
    _proactiveRunning = false;
  }
}

export async function runConcernChecks(userId, prefs, platformSenders, sendOwnerAlert) {
  if (!process.env.PROACTIVE_ENABLED) return;
  try {
    const hits = await checkAll(userId);
    if (!hits.length) return;
    const top = hits.sort((a, b) => b.confidence - a.confidence)[0];
    await sendConcernHit(top, userId, prefs, platformSenders, sendOwnerAlert);
  } catch (err) {
    console.error(`[proactive] concern check error for ${userId}:`, err);
  }
}
