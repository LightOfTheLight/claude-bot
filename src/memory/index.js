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
export function getContext(userId, channelId = null) {
  const db = getDb();
  const thread = db.prepare('SELECT * FROM threads WHERE user_id = ? AND channel_id IS ?').get(userId, channelId);
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
export function appendMessage(userId, { role, content, platform = null, channelId = null }) {
  const db = getDb();
  const now = Date.now();
  const msgUuid = crypto.randomUUID();

  // Dual-write to message_log (append-only, not scoped by channel)
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

  // Get or create the channel-scoped thread
  let thread = db.prepare('SELECT * FROM threads WHERE user_id = ? AND channel_id IS ?').get(userId, channelId);
  if (!thread) {
    const threadId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO threads (id, user_id, channel_id, messages, summary, learnings, created_at, updated_at)
      VALUES (?, ?, ?, '[]', NULL, '[]', ?, ?)
    `).run(threadId, userId, channelId, now, now);
    thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
  }

  let messages = [];
  try { messages = JSON.parse(thread.messages ?? '[]'); } catch {}

  messages.push({ role, content, platform, ts: now });
  if (messages.length > ROLLING_WINDOW) {
    messages = messages.slice(messages.length - ROLLING_WINDOW);
  }

  const newCount = (thread.message_count ?? 0) + 1;

  db.prepare(`
    UPDATE threads
    SET messages = ?, message_count = ?, last_active = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(messages), newCount, now, now, thread.id);

  // Trigger summarisation when window fills (async — don't block the response path)
  if (newCount > 0 && newCount % SUMMARY_TRIGGER === 0) {
    import('./summarize.js').then(({ maybeSummarize }) => maybeSummarize(userId, channelId)).catch(() => {});
  }

  return msgUuid;
}

/**
 * Increment tool_use_total for a user's thread (called by runner after gateway response).
 */
export function incrementToolUse(userId, count, channelId = null) {
  if (!count) return;
  const db = getDb();
  db.prepare(
    'UPDATE threads SET tool_use_total = tool_use_total + ?, updated_at = ? WHERE user_id = ? AND channel_id IS ?'
  ).run(count, Date.now(), userId, channelId);
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

/** Reset thread to blank slate (preserves identity). Scoped to the given channel. */
export function resetThread(userId, channelId = null) {
  getDb().prepare(`
    UPDATE threads
    SET messages = '[]', summary = NULL, learnings = '[]',
        message_count = 0, tool_use_total = 0, dreamed = 0,
        last_active = NULL, updated_at = ?
    WHERE user_id = ? AND channel_id IS ?
  `).run(Date.now(), userId, channelId);
}

// ─── User preferences ────────────────────────────────────────────────────────

export function getPreference(userId, key) {
  const db = getDb();
  const row = db.prepare('SELECT preferences FROM users WHERE user_id = ?').get(userId);
  if (!row) return null;
  try {
    const prefs = JSON.parse(row.preferences ?? '{}');
    return prefs[key] ?? null;
  } catch { return null; }
}

export function setPreference(userId, key, value) {
  const db = getDb();
  const row = db.prepare('SELECT preferences FROM users WHERE user_id = ?').get(userId);
  let prefs = {};
  try { prefs = JSON.parse(row?.preferences ?? '{}'); } catch {}
  if (value === null) {
    delete prefs[key];
  } else {
    prefs[key] = value;
  }
  db.prepare('UPDATE users SET preferences = ?, updated_at = ? WHERE user_id = ?')
    .run(JSON.stringify(prefs), Date.now(), userId);
}

export function getAllPreferences(userId) {
  const db = getDb();
  const row = db.prepare('SELECT preferences FROM users WHERE user_id = ?').get(userId);
  try { return JSON.parse(row?.preferences ?? '{}'); } catch { return {}; }
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

export function isActiveChannel(platform, channelId) {
  return !!getDb().prepare(
    'SELECT 1 FROM active_channels WHERE platform = ? AND channel_id = ?'
  ).get(platform, channelId);
}

// ─── Reminders ────────────────────────────────────────────────────────────────

/**
 * Return the platform-specific user ID (e.g. Discord snowflake) for a given
 * internal user_id + platform pair, or null if not found.
 */
export function getUserPlatformId(userId, platform) {
  const row = getDb().prepare(
    'SELECT platform_id FROM platform_ids WHERE user_id = ? AND platform = ?'
  ).get(userId, platform);
  return row?.platform_id ?? null;
}

// Valid recur values: 'hourly' | 'daily' | 'weekly' | 'monthly' | null (one-off)
export function createReminder(userId, { message, fireAt, platform, channelId, recur = null }) {
  getDb().prepare(
    'INSERT INTO reminders (id, user_id, message, fire_at, platform, channel_id, recur) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), userId, message, fireAt, platform ?? null, channelId ?? null, recur ?? null);
}

export function getDueReminders() {
  return getDb().prepare(
    'SELECT * FROM reminders WHERE fire_at <= ? AND fired = 0'
  ).all(Date.now());
}

/**
 * Mark a one-off reminder as fired, or advance a recurring reminder to its next fire_at.
 * Returns true if the reminder was rescheduled (recurring), false if permanently fired.
 */
export function markReminderFired(id) {
  const db = getDb();
  const row = db.prepare('SELECT recur FROM reminders WHERE id = ?').get(id);
  if (!row) return false;

  const nextFireAt = _nextFireAt(row.recur);
  if (nextFireAt) {
    db.prepare('UPDATE reminders SET fire_at = ? WHERE id = ?').run(nextFireAt, id);
    return true; // rescheduled
  }
  db.prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(id);
  return false;
}

/** Compute next fire_at from a recur string. Returns null for one-off / unknown. */
function _nextFireAt(recur) {
  const now = Date.now();
  switch (recur) {
    case 'hourly':  return now + 60 * 60 * 1000;
    case 'daily':   return now + 24 * 60 * 60 * 1000;
    case 'weekly':  return now + 7 * 24 * 60 * 60 * 1000;
    case 'monthly': return now + 30 * 24 * 60 * 60 * 1000;
    default:        return null;
  }
}

/** List all active (unfired) reminders for a user. */
export function listReminders(userId) {
  return getDb().prepare(
    'SELECT id, message, fire_at, recur, platform FROM reminders WHERE user_id = ? AND fired = 0 ORDER BY fire_at ASC'
  ).all(userId);
}

/** Cancel a reminder by ID, scoped to a user (prevents cross-user cancellation). */
export function cancelReminder(id, userId) {
  const result = getDb().prepare(
    'UPDATE reminders SET fired = 1 WHERE id = ? AND user_id = ?'
  ).run(id, userId);
  return result.changes > 0;
}

/**
 * Return all users opted in to proactive messaging.
 * Reads preferences JSON from users table and platform identities from platform_ids.
 * Returns [{ userId, prefs, platforms }]
 */
export function getProactiveUsers() {
  if (!process.env.PROACTIVE_ENABLED) return [];
  const db = getDb();
  const rows = db.prepare('SELECT user_id, preferences FROM users').all();
  const users = [];
  for (const row of rows) {
    let prefs = {};
    try { prefs = JSON.parse(row.preferences ?? '{}'); } catch {}
    // Skip users who have explicitly opted out
    if (prefs.proactive === 'false' || prefs.proactive === false) continue;
    const platformRows = db.prepare(
      'SELECT platform, platform_id FROM platform_ids WHERE user_id = ?'
    ).all(row.user_id);
    const platforms = {};
    for (const p of platformRows) platforms[p.platform] = p.platform_id;
    users.push({ userId: row.user_id, prefs, platforms });
  }
  return users;
}

/**
 * Return all users that have a digest_time preference set, along with their
 * platform identities for delivery routing.
 * Returns [{ userId, preferences, platforms: [{ platform, platformId }] }]
 */
export function getUsersWithDigest() {
  const db = getDb();
  const users = db.prepare(
    `SELECT user_id, preferences FROM users
     WHERE json_extract(preferences, '$.digest_time') IS NOT NULL`
  ).all();

  return users.map((u) => {
    const platforms = db.prepare(
      'SELECT platform, platform_id FROM platform_ids WHERE user_id = ?'
    ).all(u.user_id);
    let prefs = {};
    try { prefs = JSON.parse(u.preferences); } catch {}
    return { userId: u.user_id, prefs, platforms };
  });
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export function createWebhook(userId, name) {
  const db = getDb();
  // One active webhook per name per user
  const existing = db.prepare(
    "SELECT id FROM webhooks WHERE user_id = ? AND name = ? AND active = 1"
  ).get(userId, name);
  if (existing) return { ok: false, error: `Webhook "${name}" already exists. Delete it first.` };

  const id    = crypto.randomUUID();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  db.prepare(
    'INSERT INTO webhooks (id, user_id, name, token, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId, name, token, Date.now());

  return { ok: true, id, token };
}

export function listWebhooks(userId) {
  return getDb().prepare(
    'SELECT id, name, token, created_at, last_used FROM webhooks WHERE user_id = ? AND active = 1 ORDER BY created_at ASC'
  ).all(userId);
}

export function deleteWebhook(userId, name) {
  const result = getDb().prepare(
    'UPDATE webhooks SET active = 0 WHERE user_id = ? AND name = ? AND active = 1'
  ).run(userId, name);
  return result.changes > 0;
}

/** Validate an incoming webhook request. Returns the webhook row or null. */
export function getWebhookByToken(id, token) {
  const row = getDb().prepare(
    'SELECT * FROM webhooks WHERE id = ? AND token = ? AND active = 1'
  ).get(id, token);
  return row ?? null;
}

export function touchWebhook(id) {
  getDb().prepare('UPDATE webhooks SET last_used = ? WHERE id = ?').run(Date.now(), id);
}

// ─── Statistics ───────────────────────────────────────────────────────────────

/**
 * Return usage statistics for a single user.
 */
export function getUserStats(userId) {
  const db = getDb();

  // Total messages and first/last timestamps from message_log
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
           MIN(ts)  AS firstTs,
           MAX(ts)  AS lastTs
    FROM message_log WHERE user_id = ?
  `).get(userId);

  // Messages by role
  const byRole = db.prepare(`
    SELECT role, COUNT(*) AS n FROM message_log WHERE user_id = ? GROUP BY role
  `).all(userId);
  const userMsgs = byRole.find((r) => r.role === 'user')?.n ?? 0;
  const botMsgs  = byRole.find((r) => r.role === 'assistant')?.n ?? 0;

  // Messages in last 7 days and 30 days
  const now = Date.now();
  const week7  = db.prepare('SELECT COUNT(*) AS n FROM message_log WHERE user_id = ? AND ts >= ?').get(userId, now - 7  * 86400_000).n;
  const week30 = db.prepare('SELECT COUNT(*) AS n FROM message_log WHERE user_id = ? AND ts >= ?').get(userId, now - 30 * 86400_000).n;

  // Unique active days (calendar days with at least one message)
  const activeDays = db.prepare(`
    SELECT COUNT(DISTINCT date(ts / 1000, 'unixepoch')) AS n
    FROM message_log WHERE user_id = ?
  `).get(userId).n;

  // Tool use total from threads table
  const toolUseTotal = db.prepare(
    'SELECT tool_use_total FROM threads WHERE user_id = ?'
  ).get(userId)?.tool_use_total ?? 0;

  // Active reminders
  const activeReminders = db.prepare(
    'SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND fired = 0'
  ).get(userId).n;

  return {
    total: totals.total ?? 0,
    userMsgs,
    botMsgs,
    week7,
    week30,
    activeDays,
    toolUseTotal,
    activeReminders,
    firstTs: totals.firstTs ?? null,
    lastTs:  totals.lastTs  ?? null,
  };
}

/**
 * Return bot-wide statistics (owner-only).
 */
export function getGlobalStats() {
  const db = getDb();
  const now = Date.now();

  const totalUsers    = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const totalMessages = db.prepare('SELECT COUNT(*) AS n FROM message_log').get().n;

  const active7  = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS n FROM message_log WHERE ts >= ?
  `).get(now - 7  * 86400_000).n;
  const active30 = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS n FROM message_log WHERE ts >= ?
  `).get(now - 30 * 86400_000).n;

  const totalReminders = db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n;
  const activeReminders = db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE fired = 0').get().n;

  const totalToolUses = db.prepare(
    'SELECT SUM(tool_use_total) AS n FROM threads'
  ).get().n ?? 0;

  // Top 5 most active users by message count
  const topUsers = db.prepare(`
    SELECT user_id, COUNT(*) AS n FROM message_log GROUP BY user_id ORDER BY n DESC LIMIT 5
  `).all();

  return {
    totalUsers, totalMessages, active7, active30,
    totalReminders, activeReminders, totalToolUses, topUsers,
  };
}

// ─── Conversation export ──────────────────────────────────────────────────────

/**
 * Fetch all messages for a user from message_log, oldest first.
 * Returns raw rows: { role, content, ts, platform }
 */
export function exportMessages(userId) {
  return getDb().prepare(
    'SELECT role, content, ts, platform FROM message_log WHERE user_id = ? ORDER BY ts ASC'
  ).all(userId);
}

// ─── Message search ───────────────────────────────────────────────────────────

/**
 * Search a user's message history for `query`.
 * Uses FTS5 if available, falls back to LIKE.
 *
 * @param {string} userId
 * @param {string} query
 * @param {{ role?: 'user'|'assistant', limit?: number }} opts
 * @returns {{ role, content, ts, snippet }[]}
 */
export function searchMessages(userId, query, { role = null, limit = 5 } = {}) {
  const db = getDb();

  // Check if FTS table exists
  const hasFts = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='message_fts'"
  ).get();

  let rows;
  if (hasFts) {
    // FTS5 path — use snippet() for highlighted extracts
    const roleFilter = role ? `AND ml.role = '${role === 'user' ? 'user' : 'assistant'}'` : '';
    rows = db.prepare(`
      SELECT ml.role, ml.content, ml.ts,
             snippet(message_fts, 0, '**', '**', '…', 20) AS snippet
      FROM message_fts
      JOIN message_log ml ON ml.id = message_fts.rowid
      WHERE message_fts MATCH ?
        AND ml.user_id = ?
        ${roleFilter}
      ORDER BY ml.ts DESC
      LIMIT ?
    `).all(query, userId, limit);
  } else {
    // LIKE fallback
    const roleFilter = role ? `AND role = '${role === 'user' ? 'user' : 'assistant'}'` : '';
    rows = db.prepare(`
      SELECT role, content, ts
      FROM message_log
      WHERE user_id = ?
        AND content LIKE ?
        ${roleFilter}
      ORDER BY ts DESC
      LIMIT ?
    `).all(userId, `%${query}%`, limit);

    // Build a simple snippet: 100 chars around the first match
    rows = rows.map((r) => {
      const idx = r.content.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, idx - 50);
      const end = Math.min(r.content.length, idx + 50 + query.length);
      const snippet = (start > 0 ? '…' : '') + r.content.slice(start, end) + (end < r.content.length ? '…' : '');
      return { ...r, snippet };
    });
  }

  return rows;
}

/**
 * Return unfired reminders for a user due within the next `windowMs` milliseconds.
 */
export function getUpcomingReminders(userId, windowMs = 7 * 24 * 60 * 60 * 1000) {
  const now = Date.now();
  return getDb().prepare(
    `SELECT * FROM reminders
     WHERE user_id = ? AND fired = 0 AND fire_at >= ? AND fire_at <= ?
     ORDER BY fire_at ASC`
  ).all(userId, now, now + windowMs);
}

// ─── Skill invocations ────────────────────────────────────────────────────────

export function recordSkillInvocation(userId, skillName) {
  getDb().prepare(
    'INSERT INTO skill_invocations (id, user_id, skill_name, invoked_at) VALUES (?, ?, ?, ?)'
  ).run(crypto.randomUUID(), userId, skillName, Date.now());
}
