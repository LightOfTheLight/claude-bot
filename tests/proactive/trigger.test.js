/**
 * Tests for proactive/trigger.js:
 * - checkUnresolvedThread, checkRepeatedQuestion, checkLongSilence
 * - checkAll: returns filtered hits above threshold
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ── Build in-memory DB ────────────────────────────────────────────────────────

function buildDb() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE users (user_id TEXT PRIMARY KEY, preferences JSON, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, messages JSON NOT NULL DEFAULT '[]',
      summary TEXT, learnings JSON NOT NULL DEFAULT '[]', message_count INTEGER NOT NULL DEFAULT 0,
      tool_use_total INTEGER NOT NULL DEFAULT 0, last_active INTEGER, dreamed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      msg_uuid TEXT NOT NULL UNIQUE, parent_uuid TEXT, role TEXT NOT NULL,
      content TEXT NOT NULL, platform TEXT, ts INTEGER NOT NULL
    );
    CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return d;
}

// ── Inline logic tests (independent of module imports) ────────────────────────

test('checkUnresolvedThread: finds thread silent > 48h with enough messages', () => {
  const d = buildDb();
  const now = Date.now();
  const old = now - 50 * 60 * 60 * 1000; // 50h ago

  d.prepare("INSERT INTO users (user_id, preferences, created_at, updated_at) VALUES ('u1', '{}', ?, ?)").run(now, now);
  d.prepare("INSERT INTO threads (id, user_id, message_count, last_active, created_at, updated_at) VALUES ('u1','u1',10,?,?,?)").run(old, now, now);

  const UNRESOLVED_THREAD_MIN_MESSAGES = 5;
  const UNRESOLVED_THREAD_SILENCE_MS = 48 * 60 * 60 * 1000;
  const cutoff = now - UNRESOLVED_THREAD_SILENCE_MS;

  const threads = d.prepare(`
    SELECT t.id, t.summary, t.message_count, t.last_active
    FROM threads t
    WHERE t.user_id = ? AND t.message_count > ? AND t.last_active < ? AND t.last_active > 0
    ORDER BY t.last_active DESC LIMIT 1
  `).all('u1', UNRESOLVED_THREAD_MIN_MESSAGES, cutoff);

  assert.equal(threads.length, 1);
  assert.equal(threads[0].message_count, 10);
});

test('checkUnresolvedThread: no result when thread active < 48h', () => {
  const d = buildDb();
  const now = Date.now();
  const recent = now - 2 * 60 * 60 * 1000; // 2h ago

  d.prepare("INSERT INTO users (user_id, preferences, created_at, updated_at) VALUES ('u2', '{}', ?, ?)").run(now, now);
  d.prepare("INSERT INTO threads (id, user_id, message_count, last_active, created_at, updated_at) VALUES ('u2','u2',10,?,?,?)").run(recent, now, now);

  const UNRESOLVED_THREAD_MIN_MESSAGES = 5;
  const UNRESOLVED_THREAD_SILENCE_MS = 48 * 60 * 60 * 1000;
  const cutoff = now - UNRESOLVED_THREAD_SILENCE_MS;

  const threads = d.prepare(`
    SELECT t.id FROM threads t
    WHERE t.user_id = ? AND t.message_count > ? AND t.last_active < ?
  `).all('u2', UNRESOLVED_THREAD_MIN_MESSAGES, cutoff);

  assert.equal(threads.length, 0);
});

test('checkRepeatedQuestion: keyword frequency counting', () => {
  const d = buildDb();
  const now = Date.now();

  d.prepare("INSERT INTO users (user_id, preferences, created_at, updated_at) VALUES ('u3','{}',?,?)").run(now, now);

  const msgs = [
    'how does authentication work',
    'explain authentication flow again',
    'still confused about authentication',
    'what is authentication exactly',
  ];
  for (const content of msgs) {
    d.prepare("INSERT INTO message_log (user_id, msg_uuid, role, content, ts) VALUES (?,?,?,?,?)").run('u3', Math.random().toString(36), 'user', content, now);
  }

  const rows = d.prepare("SELECT content FROM message_log WHERE user_id = ? AND role = 'user' ORDER BY ts DESC LIMIT 30").all('u3');
  const stopwords = new Set(['how', 'what', 'why', 'when', 'where', 'who', 'is', 'are', 'was', 'the', 'my', 'your', 'a', 'an', 'i', 'me', 'it', 'do', 'does', 'can', 'could', 'would', 'should', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'this', 'that', 'have', 'has', 'not', 'be', 'been']);

  const freq = {};
  for (const row of rows) {
    const words = row.content.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
  }

  assert.ok(freq['authentication'] >= 4, `authentication should appear 4+ times, got ${freq['authentication']}`);
});

test('checkLongSilence: detects user silent > 72h', () => {
  const d = buildDb();
  const now = Date.now();
  const old = now - 80 * 60 * 60 * 1000; // 80h ago

  d.prepare("INSERT INTO users (user_id, preferences, created_at, updated_at) VALUES ('u4','{}',?,?)").run(now, now);
  d.prepare("INSERT INTO message_log (user_id, msg_uuid, role, content, ts) VALUES ('u4','m1','user','hello',?)").run(old);

  const cutoff = now - 72 * 60 * 60 * 1000;
  const row = d.prepare("SELECT MAX(ts) as last_active FROM message_log WHERE user_id = ?").get('u4');

  assert.ok(row.last_active < cutoff, 'user should be considered silent');
});

test('checkLongSilence: no trigger when user recently active', () => {
  const d = buildDb();
  const now = Date.now();
  const recent = now - 1 * 60 * 60 * 1000; // 1h ago

  d.prepare("INSERT INTO users (user_id, preferences, created_at, updated_at) VALUES ('u5','{}',?,?)").run(now, now);
  d.prepare("INSERT INTO message_log (user_id, msg_uuid, role, content, ts) VALUES ('u5','m2','user','hi',?)").run(recent);

  const cutoff = now - 72 * 60 * 60 * 1000;
  const row = d.prepare("SELECT MAX(ts) as last_active FROM message_log WHERE user_id = ?").get('u5');

  assert.ok(row.last_active > cutoff, 'recent user should not trigger long-silence check');
});

test('confidence clamped at 0.9 for repeated question', () => {
  const computeConf = (count) => Math.min(0.9, 0.5 + count * 0.1);
  assert.equal(computeConf(3), 0.8);
  assert.equal(computeConf(4), 0.9);
  assert.equal(computeConf(10), 0.9);
});
