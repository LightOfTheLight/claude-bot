import { getDb } from './db.js';

const ROLLING_WINDOW = 50;
const SUMMARY_TRIGGER = 100;

// ─── Identity ─────────────────────────────────────────────────────────────────

/**
 * Look up or create a user by platform + platformId.
 * Returns the stable user_id UUID.
 */
export function getOrCreateUser(platform, platformId) {
  const db = getDb();
  const now = Date.now();

  const existing = db.prepare(
    'SELECT user_id FROM platform_ids WHERE platform = ? AND platform_id = ?'
  ).get(platform, platformId);

  if (existing) return existing.user_id;

  // New user — create users row + platform_ids row + empty thread
  const userId = crypto.randomUUID();

  db.transaction(() => {
    db.prepare(
      'INSERT INTO users (user_id, preferences, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(userId, '{}', now, now);

    db.prepare(
      'INSERT INTO platform_ids (platform, platform_id, user_id, linked_at) VALUES (?, ?, ?, ?)'
    ).run(platform, platformId, userId, now);

    db.prepare(`
      INSERT INTO threads (id, user_id, messages, summary, learnings, created_at, updated_at)
      VALUES (?, ?, '[]', NULL, '[]', ?, ?)
    `).run(userId, userId, now, now);
  })();

  return userId;
}

/**
 * Link a second platform identity to an existing user via a one-time token.
 * Returns { ok, error? }.
 */
export function consumeLinkToken(token, targetPlatform, targetPlatformId) {
  const db = getDb();
  const now = Date.now();

  const row = db.prepare(
    'SELECT * FROM link_tokens WHERE token = ? AND used = 0 AND expires_at > ?'
  ).get(token, now);

  if (!row) return { ok: false, error: 'invalid or expired token' };

  // Check if target platform_id is already linked (to a different user)
  const existing = db.prepare(
    'SELECT user_id FROM platform_ids WHERE platform = ? AND platform_id = ?'
  ).get(targetPlatform, targetPlatformId);

  if (existing && existing.user_id !== row.from_user_id) {
    return { ok: false, error: 'already linked to a different user' };
  }

  db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO platform_ids (platform, platform_id, user_id, linked_at) VALUES (?, ?, ?, ?)'
    ).run(targetPlatform, targetPlatformId, row.from_user_id, now);
    db.prepare('UPDATE link_tokens SET used = 1 WHERE token = ?').run(token);
  })();

  return { ok: true };
}

/**
 * Generate a one-time link token for cross-platform identity merging.
 */
export function createLinkToken(fromUserId, fromPlatform) {
  const db = getDb();
  const token = Math.random().toString(36).slice(2, 8).toUpperCase(); // 6-char token
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min TTL

  db.prepare(
    'INSERT INTO link_tokens (token, from_user_id, from_platform, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, fromUserId, fromPlatform, expiresAt);

  return token;
}

// ─── Thread context ───────────────────────────────────────────────────────────

/**
 * Returns { messages, summary, learnings } for context injection.
 * messages: last ROLLING_WINDOW entries in chronological order.
 */
export function getContext(userId) {
  const db = getDb();
  const thread = db.prepare('SELECT * FROM threads WHERE user_id = ?').get(userId);
  if (!thread) return { messages: [], summary: null, learnings: [] };

  let messages = [];
  try { messages = JSON.parse(thread.messages); } catch {}

  let learnings = [];
  try { learnings = JSON.parse(thread.learnings); } catch {}

  return { messages, summary: thread.summary ?? null, learnings };
}

/**
 * Append a message to the thread rolling window.
 * Dual-writes to message_log (v2) when the table exists.
 * Returns msg_uuid for callers that need fork cursors.
 */
export function appendMessage(userId, { role, content, platform = null }) {
  const db = getDb();
  const now = Date.now();
  const msgUuid = crypto.randomUUID();

  // Dual-write to message_log if v2 schema is present
  const hasLog = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='message_log'"
  ).get();

  if (hasLog) {
    const prev = db.prepare(
      'SELECT msg_uuid FROM message_log WHERE user_id = ? ORDER BY id DESC LIMIT 1'
    ).get(userId);

    db.prepare(`
      INSERT INTO message_log (user_id, msg_uuid, parent_uuid, role, content, platform, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, msgUuid, prev?.msg_uuid ?? null, role, content, platform, now);
  }

  // Rebuild rolling window in threads.messages
  const thread = db.prepare('SELECT messages, message_count FROM threads WHERE user_id = ?').get(userId);
  let messages = [];
  try { messages = JSON.parse(thread?.messages ?? '[]'); } catch {}

  messages.push({ role, content, platform, ts: now });
  if (messages.length > ROLLING_WINDOW) {
    messages = messages.slice(messages.length - ROLLING_WINDOW);
  }

  const newCount = (thread?.message_count ?? 0) + 1;

  db.prepare(`
    UPDATE threads
    SET messages = ?, message_count = ?, last_active = ?, updated_at = ?
    WHERE user_id = ?
  `).run(JSON.stringify(messages), newCount, now, now, userId);

  // Trigger summarisation when window fills (async — don't block the response path)
  if (newCount > 0 && newCount % SUMMARY_TRIGGER === 0) {
    import('./summarize.js').then(({ maybeSummarize }) => maybeSummarize(userId)).catch(() => {});
  }

  return msgUuid;
}

/**
 * Increment tool_use_total for a user's thread (called by runner after gateway response).
 */
export function incrementToolUse(userId, count) {
  if (!count) return;
  const db = getDb();
  db.prepare(
    'UPDATE threads SET tool_use_total = tool_use_total + ?, updated_at = ? WHERE user_id = ?'
  ).run(count, Date.now(), userId);
}

// ─── Rollback helpers ─────────────────────────────────────────────────────────

/** Remove the last n messages from the rolling window (destructive in v1). */
export function trimMessages(userId, n) {
  const db = getDb();
  const thread = db.prepare('SELECT messages FROM threads WHERE user_id = ?').get(userId);
  if (!thread) return;
  let msgs = [];
  try { msgs = JSON.parse(thread.messages); } catch {}
  const trimmed = msgs.slice(0, Math.max(0, msgs.length - n));
  db.prepare('UPDATE threads SET messages = ?, updated_at = ? WHERE user_id = ?')
    .run(JSON.stringify(trimmed), Date.now(), userId);
}

/** Clear the LLM summary so the next context injection falls back to raw messages. */
export function clearSummary(userId) {
  getDb().prepare('UPDATE threads SET summary = NULL, updated_at = ? WHERE user_id = ?')
    .run(Date.now(), userId);
}

/** Remove a specific learning entry by key. */
export function removeLearning(userId, key) {
  const db = getDb();
  const thread = db.prepare('SELECT learnings FROM threads WHERE user_id = ?').get(userId);
  if (!thread) return;
  let learnings = [];
  try { learnings = JSON.parse(thread.learnings); } catch {}
  const filtered = learnings.filter((l) => l.key !== key);
  db.prepare('UPDATE threads SET learnings = ?, updated_at = ? WHERE user_id = ?')
    .run(JSON.stringify(filtered), Date.now(), userId);
}

/** List all learning keys for a user. */
export function listLearnings(userId) {
  const db = getDb();
  const thread = db.prepare('SELECT learnings FROM threads WHERE user_id = ?').get(userId);
  if (!thread) return [];
  try { return JSON.parse(thread.learnings); } catch { return []; }
}

/** Reset thread to blank slate (preserves identity). */
export function resetThread(userId) {
  getDb().prepare(`
    UPDATE threads
    SET messages = '[]', summary = NULL, learnings = '[]',
        message_count = 0, tool_use_total = 0, dreamed = 0,
        last_active = NULL, updated_at = ?
    WHERE user_id = ?
  `).run(Date.now(), userId);
}

// ─── Bot state ────────────────────────────────────────────────────────────────

export function setBotState(key, value) {
  getDb().prepare(
    'INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)'
  ).run(key, String(value));
}

export function getBotState(key) {
  const row = getDb().prepare('SELECT value FROM bot_state WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function trackChannel(platform, channelId, guildId = null) {
  getDb().prepare(`
    INSERT INTO active_channels (platform, channel_id, guild_id, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(platform, channel_id) DO UPDATE SET last_seen = excluded.last_seen, guild_id = excluded.guild_id
  `).run(platform, channelId, guildId, Date.now());
}

export function getActiveChannels(platform) {
  return getDb().prepare(
    'SELECT channel_id, guild_id FROM active_channels WHERE platform = ?'
  ).all(platform);
}

// ─── Reminders ────────────────────────────────────────────────────────────────

export function createReminder(userId, { message, fireAt, platform }) {
  getDb().prepare(
    'INSERT INTO reminders (id, user_id, message, fire_at, platform) VALUES (?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), userId, message, fireAt, platform ?? null);
}

export function getDueReminders() {
  return getDb().prepare(
    'SELECT * FROM reminders WHERE fire_at <= ? AND fired = 0'
  ).all(Date.now());
}

export function markReminderFired(id) {
  getDb().prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(id);
}
