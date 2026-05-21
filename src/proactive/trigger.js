import { getDb } from '../memory/db.js';
import { getThreshold } from './feedback.js';

const UNRESOLVED_THREAD_MIN_MESSAGES = 5;
const UNRESOLVED_THREAD_SILENCE_MS = 48 * 60 * 60 * 1000;
const LONG_SILENCE_MS = 72 * 60 * 60 * 1000;
const REPEATED_QUESTION_MIN = 3;
const RECENT_MESSAGES_LIMIT = 30;

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

export async function checkAll(userId) {
  const [unresolvedThread, repeatedQuestion, longSilence] = await Promise.all([
    checkUnresolvedThread(userId).catch(() => null),
    checkRepeatedQuestion(userId).catch(() => null),
    checkLongSilence(userId).catch(() => null),
  ]);

  const hits = [unresolvedThread, repeatedQuestion, longSilence].filter(Boolean);

  // Filter by threshold
  const filtered = [];
  for (const hit of hits) {
    const threshold = await getThreshold(hit.template);
    if (hit.confidence > threshold) filtered.push(hit);
  }

  return filtered;
}
