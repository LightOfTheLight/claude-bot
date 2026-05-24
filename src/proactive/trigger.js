import { spawnSync } from 'child_process';
import { getDb } from '../memory/db.js';
import { getThreshold } from './feedback.js';

const UNRESOLVED_THREAD_MIN_MESSAGES = 5;
const UNRESOLVED_THREAD_SILENCE_MS = 48 * 60 * 60 * 1000;
const LONG_SILENCE_MS = 72 * 60 * 60 * 1000;
const REPEATED_QUESTION_MIN = 3;
const RECENT_MESSAGES_LIMIT = 30;
const BROKEN_STREAK_MIN_DAYS = 5;                 // skill must have been used this many consecutive days
const BROKEN_STREAK_SILENCE_MS = 24 * 60 * 60 * 1000; // silence window that triggers the alert
const INTENT_CHECK_WINDOW_MS = 60 * 60 * 1000;   // max 1 Claude CLI call per user per hour
const INTENT_MESSAGES_LIMIT = 20;                 // last N user messages fed to intent extractor
const INTENT_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000; // only surface intents mentioned in last 3 days
const THREAD_FOLLOWUP_SILENCE_MIN_MS = 2 * 60 * 60 * 1000;  // thread silent at least 2h
const THREAD_FOLLOWUP_SILENCE_MAX_MS = 24 * 60 * 60 * 1000; // but not more than 24h (too stale)
const THREAD_FOLLOWUP_CHECK_WINDOW_MS = 60 * 60 * 1000;     // max 1 LLM call per user per hour
const THREAD_FOLLOWUP_MESSAGES = 10;                         // last N messages to assess completion

function getStopwords() {
  return new Set(['how', 'what', 'why', 'when', 'where', 'who', 'is', 'are', 'was', 'the', 'my', 'your', 'a', 'an', 'i', 'me', 'it', 'do', 'does', 'can', 'could', 'would', 'should', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'this', 'that', 'have', 'has', 'not', 'be', 'been']);
}

function extractKeywords(text) {
  const stopwords = getStopwords();
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));
}

async function checkUnresolvedThread(userId) {
  const db = getDb();
  const cutoff = Date.now() - UNRESOLVED_THREAD_SILENCE_MS;
  const threads = db.prepare(`
    SELECT t.id, t.summary, t.message_count, t.last_active
    FROM threads t
    WHERE t.user_id = ? AND t.message_count > ? AND t.last_active < ? AND t.last_active > 0
    ORDER BY t.last_active DESC
    LIMIT 1
  `).all(userId, UNRESOLVED_THREAD_MIN_MESSAGES, cutoff);

  if (!threads.length) return null;
  const thread = threads[0];
  return {
    template: 'UNRESOLVED_THREAD',
    confidence: 0.8,
    message: `You have an unresolved thread from ${Math.round((Date.now() - thread.last_active) / 3600000)}h ago with ${thread.message_count} messages. ${thread.summary ? 'Summary: ' + thread.summary : ''}`.trim(),
    context: thread.summary || `Thread with ${thread.message_count} messages, silent for ${Math.round((Date.now() - thread.last_active) / 3600000)}h`,
  };
}

async function checkRepeatedQuestion(userId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT content FROM message_log WHERE user_id = ? AND role = 'user' ORDER BY ts DESC LIMIT ?
  `).all(userId, RECENT_MESSAGES_LIMIT);

  if (!rows.length) return null;

  const freq = {};
  for (const row of rows) {
    for (const kw of extractKeywords(row.content || '')) {
      freq[kw] = (freq[kw] || 0) + 1;
    }
  }

  const repeated = Object.entries(freq).filter(([, count]) => count >= REPEATED_QUESTION_MIN).sort((a, b) => b[1] - a[1]);
  if (!repeated.length) return null;

  const [topKw, topCount] = repeated[0];
  return {
    template: 'REPEATED_QUESTION',
    confidence: Math.min(0.9, 0.5 + topCount * 0.1),
    message: `You've asked about "${topKw}" ${topCount} times recently without a satisfying resolution.`,
    context: `Keyword "${topKw}" appears ${topCount} times in last ${RECENT_MESSAGES_LIMIT} messages`,
  };
}

async function checkLongSilence(userId) {
  const db = getDb();
  const cutoff = Date.now() - LONG_SILENCE_MS;
  const row = db.prepare(`
    SELECT MAX(ts) as last_active FROM message_log WHERE user_id = ?
  `).get(userId);

  if (!row || !row.last_active || row.last_active > cutoff) return null;

  const hoursAgo = Math.round((Date.now() - row.last_active) / 3600000);
  return {
    template: 'LONG_SILENCE',
    confidence: 0.75,
    message: `You haven't been active for ${hoursAgo} hours. Everything okay?`,
    context: `No messages from user in ${hoursAgo}h`,
  };
}

async function checkBrokenStreak(userId) {
  const db = getDb();

  // Find distinct skill names this user has ever invoked
  const skills = db.prepare(
    'SELECT DISTINCT skill_name FROM skill_invocations WHERE user_id = ? ORDER BY skill_name'
  ).all(userId).map(r => r.skill_name);

  if (!skills.length) return null;

  const now = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  for (const skillName of skills) {
    // Get all invocation timestamps for this skill, oldest first
    const rows = db.prepare(
      'SELECT invoked_at FROM skill_invocations WHERE user_id = ? AND skill_name = ? ORDER BY invoked_at ASC'
    ).all(userId, skillName);

    if (rows.length < BROKEN_STREAK_MIN_DAYS) continue;

    // Bucket into calendar dates (UTC day string "2026-05-21")
    const daySet = new Set(
      rows.map(r => new Date(r.invoked_at).toISOString().slice(0, 10))
    );
    const days = [...daySet].sort();

    // Find the longest run of consecutive calendar days
    let streak = 1;
    let maxStreak = 1;
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1]).getTime();
      const curr = new Date(days[i]).getTime();
      if (curr - prev === MS_PER_DAY) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 1;
      }
    }

    if (maxStreak < BROKEN_STREAK_MIN_DAYS) continue;

    // Check if the streak ended — last invocation was > 24h ago
    const lastInvokedAt = rows[rows.length - 1].invoked_at;
    if (now - lastInvokedAt < BROKEN_STREAK_SILENCE_MS) continue;

    const daysAgo = Math.round((now - lastInvokedAt) / MS_PER_DAY);
    return {
      template: 'BROKEN_STREAK',
      confidence: Math.min(0.95, 0.7 + (maxStreak - BROKEN_STREAK_MIN_DAYS) * 0.05),
      message: `You used **${skillName}** daily for ${maxStreak} days but haven't touched it in ${daysAgo} day${daysAgo !== 1 ? 's' : ''}. Fallen off the habit?`,
      context: `Skill "${skillName}" had a ${maxStreak}-day streak, last used ${daysAgo}d ago`,
    };
  }

  return null;
}

async function checkUnresolvedIntent(userId) {
  const db = getDb();

  // Per-user rate limit: at most one Claude CLI call per hour
  const rlKey = `proactive_intent_check:${userId}`;
  const lastCheck = parseInt(db.prepare('SELECT value FROM bot_state WHERE key = ?').get(rlKey)?.value ?? '0', 10);
  if (Date.now() - lastCheck < INTENT_CHECK_WINDOW_MS) return null;

  // Fetch recent user messages within the lookback window
  const cutoff = Date.now() - INTENT_LOOKBACK_MS;
  const rows = db.prepare(
    `SELECT content, ts FROM message_log WHERE user_id = ? AND role = 'user' AND ts > ? ORDER BY ts DESC LIMIT ?`
  ).all(userId, cutoff, INTENT_MESSAGES_LIMIT);

  if (rows.length < 3) return null; // not enough signal

  const transcript = rows
    .slice()
    .reverse()
    .map(r => `[${new Date(r.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}] ${r.content}`)
    .join('\n');

  const prompt = `You are analyzing a user's recent messages to find unresolved intents — things they mentioned wanting to do, figure out, or follow up on, but never completed.

Messages (oldest first):
${transcript}

Output ONLY a JSON object. No explanation, no markdown.
If you find a clear unresolved intent: { "found": true, "intent": "<short description, max 12 words>", "confidence": <0.0-1.0> }
If nothing stands out: { "found": false }

Rules:
- Only flag something if it was mentioned but clearly never resolved in this message history
- confidence > 0.75 means you're quite sure it's unresolved
- Do not flag things that were resolved or dropped intentionally`;

  // Record the attempt time before calling Claude (prevents burst on slow calls)
  db.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)').run(rlKey, String(Date.now()));

  const result = spawnSync('claude', ['-p', prompt, '--max-tokens', '120'], {
    encoding: 'utf8',
    timeout: 20000,
  });

  if (result.status !== 0 || !result.stdout?.trim()) return null;

  let parsed;
  try {
    const cleaned = result.stdout.trim().replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed?.found || typeof parsed.intent !== 'string' || !parsed.intent.trim()) return null;

  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.8;

  return {
    template: 'UNRESOLVED_INTENT',
    confidence,
    message: `You mentioned wanting to "${parsed.intent.trim()}" — still on your radar?`,
    context: `Unresolved intent detected in last ${rows.length} messages: "${parsed.intent.trim()}"`,
  };
}

async function checkActiveThreadFollowup(userId) {
  const db = getDb();
  const now = Date.now();

  // Find threads silent between 2h and 24h
  const thread = db.prepare(`
    SELECT t.id, t.last_active, t.message_count, t.channel_id
    FROM threads t
    WHERE t.user_id = ?
      AND t.last_active < ? AND t.last_active > ?
    ORDER BY t.last_active DESC
    LIMIT 1
  `).get(userId, now - THREAD_FOLLOWUP_SILENCE_MIN_MS, now - THREAD_FOLLOWUP_SILENCE_MAX_MS);

  if (!thread) return null;

  // Per-user rate limit: at most one LLM call per hour
  const rlKey = `proactive_thread_followup:${userId}`;
  const lastCheck = parseInt(db.prepare('SELECT value FROM bot_state WHERE key = ?').get(rlKey)?.value ?? '0', 10);
  if (now - lastCheck < THREAD_FOLLOWUP_CHECK_WINDOW_MS) return null;

  // Fetch last N messages from that thread
  const rows = db.prepare(`
    SELECT role, content, ts FROM message_log
    WHERE user_id = ? AND channel_id = ?
    ORDER BY ts DESC LIMIT ?
  `).all(userId, thread.channel_id, THREAD_FOLLOWUP_MESSAGES);

  if (rows.length < 2) return null;

  const transcript = rows
    .slice()
    .reverse()
    .map(r => `[${r.role}]: ${(r.content ?? '').slice(0, 300)}`)
    .join('\n');

  const prompt = `You are reviewing a conversation to determine if it ended naturally or was interrupted mid-task.

Conversation (oldest first):
${transcript}

Output ONLY a JSON object. No explanation, no markdown.
If the thread appears incomplete or interrupted:
{ "complete": false, "topic": "<1 short phrase describing what was being worked on, max 8 words>", "next_step": "<what should happen next, max 10 words>", "confidence": <0.0-1.0> }
If the thread appears naturally complete:
{ "complete": true }

Rules:
- "incomplete" means: the bot listed steps and stopped, the bot asked a question and got no reply, the user asked to do something and it was only partially done, or the bot ended with "shall I...", "want me to...", "next we'll..."
- "complete" means: user said thanks/ok/done, bot gave a final summary, or the exchange reached a natural conclusion
- confidence > 0.75 means you are quite sure it is incomplete`;

  db.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)').run(rlKey, String(now));

  const result = spawnSync('claude', ['-p', prompt, '--max-tokens', '150'], {
    encoding: 'utf8',
    timeout: 20000,
  });

  if (result.status !== 0 || !result.stdout?.trim()) return null;

  let parsed;
  try {
    const cleaned = result.stdout.trim().replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (parsed?.complete !== false) return null;
  if (!parsed.topic || typeof parsed.topic !== 'string') return null;

  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.75;

  const hoursAgo = Math.round((now - thread.last_active) / 3600000);
  return {
    template: 'ACTIVE_THREAD_FOLLOWUP',
    confidence,
    message: `We were working on **${parsed.topic.trim()}** ${hoursAgo}h ago — ${parsed.next_step?.trim() ?? 'want to pick it up?'}`,
    context: `Thread incomplete: "${parsed.topic.trim()}" — next step: "${parsed.next_step?.trim()}"`,
  };
}

export async function checkAll(userId) {
  const [unresolvedThread, repeatedQuestion, longSilence, unresolvedIntent, brokenStreak, activeThreadFollowup] = await Promise.all([
    checkUnresolvedThread(userId).catch(() => null),
    checkRepeatedQuestion(userId).catch(() => null),
    checkLongSilence(userId).catch(() => null),
    checkUnresolvedIntent(userId).catch(() => null),
    checkBrokenStreak(userId).catch(() => null),
    checkActiveThreadFollowup(userId).catch(() => null),
  ]);

  const hits = [unresolvedThread, repeatedQuestion, longSilence, unresolvedIntent, brokenStreak, activeThreadFollowup].filter(Boolean);

  // Filter by threshold
  const filtered = [];
  for (const hit of hits) {
    const threshold = await getThreshold(hit.template);
    if (hit.confidence > threshold) filtered.push(hit);
  }

  return filtered;
}
