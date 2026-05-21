import { getDb } from '../memory/db.js';
import { randomUUID } from 'crypto';

const FLOOR = 0.3;
const CEIL = 0.95;
const INITIAL = 0.7;

export async function getThreshold(template) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM bot_state WHERE key = ?').get(`proactive_threshold_${template}`);
  return row ? parseFloat(row.value) : INITIAL;
}

export async function updateThreshold(template, ratingNorm) {
  const db = getDb();
  const old = await getThreshold(template);
  const next = Math.max(FLOOR, Math.min(CEIL, 0.8 * old + 0.2 * ratingNorm));
  db.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)').run(`proactive_threshold_${template}`, String(next));
}

export async function handleReaction(messageId, emoji, userId) {
  const db = getDb();
  const send = db.prepare('SELECT id, user_id, template FROM proactive_sends WHERE discord_message_id = ?').get(messageId);
  if (!send) return false;

  const rating = emoji === '👍' ? 1 : emoji === '👎' ? -1 : null;
  if (rating === null) return false;

  const ratingNorm = rating === 1 ? 1.0 : 0.0;

  db.prepare('INSERT INTO proactive_feedback (id, send_id, user_id, rating, created_at) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(), send.id, userId, rating, Date.now()
  );

  if (send.template) await updateThreshold(send.template, ratingNorm);
  return true;
}
