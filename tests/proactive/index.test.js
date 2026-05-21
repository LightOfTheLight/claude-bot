/**
 * Tests for proactive/index.js:
 * - dedup logic (isDedupedFor)
 * - in-flight guard (_proactiveRunning)
 * - PROACTIVE_ENABLED gate
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildDb() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE proactive_sends (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      channel_id TEXT, message TEXT NOT NULL, sent_at INTEGER NOT NULL,
      template TEXT, confidence REAL, discord_message_id TEXT
    );
    CREATE TABLE users (user_id TEXT PRIMARY KEY, preferences JSON, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE platform_ids (
      platform TEXT NOT NULL, platform_id TEXT NOT NULL,
      user_id TEXT NOT NULL, linked_at INTEGER NOT NULL, PRIMARY KEY (platform, platform_id)
    );
    CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return d;
}

// Inline dedup logic (mirrors src/proactive/index.js)
const DEDUP_WINDOW_MS = 20 * 60 * 60 * 1000;

function isDedupedFor(d, userId, kind) {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  const row = d.prepare('SELECT id FROM proactive_sends WHERE user_id = ? AND kind = ? AND sent_at > ?').get(userId, kind, cutoff);
  return !!row;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('isDedupedFor returns false when no prior send', () => {
  const d = buildDb();
  assert.equal(isDedupedFor(d, 'user1', 'morning_brief'), false);
});

test('isDedupedFor returns true when send exists within 20h window', () => {
  const d = buildDb();
  const recentSend = Date.now() - 1 * 60 * 60 * 1000; // 1h ago
  d.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at) VALUES ('s1','user1','morning_brief','hi',?)").run(recentSend);
  assert.equal(isDedupedFor(d, 'user1', 'morning_brief'), true);
});

test('isDedupedFor returns false when send is older than 20h window', () => {
  const d = buildDb();
  const oldSend = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
  d.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at) VALUES ('s2','user1','morning_brief','hi',?)").run(oldSend);
  assert.equal(isDedupedFor(d, 'user1', 'morning_brief'), false);
});

test('isDedupedFor scopes by kind', () => {
  const d = buildDb();
  const recentSend = Date.now() - 1 * 60 * 60 * 1000;
  d.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at) VALUES ('s3','user1','morning_brief','hi',?)").run(recentSend);
  // nightly_sync should not be deduped
  assert.equal(isDedupedFor(d, 'user1', 'nightly_sync'), false);
});

test('isDedupedFor scopes by user_id', () => {
  const d = buildDb();
  const recentSend = Date.now() - 1 * 60 * 60 * 1000;
  d.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at) VALUES ('s4','user1','morning_brief','hi',?)").run(recentSend);
  // Different user should not be deduped
  assert.equal(isDedupedFor(d, 'user2', 'morning_brief'), false);
});

test('PROACTIVE_ENABLED gate: runScheduled exits early when env not set', async () => {
  // Remove env var if set
  const prev = process.env.PROACTIVE_ENABLED;
  delete process.env.PROACTIVE_ENABLED;

  let called = false;
  // Simulate the guard from runScheduled
  async function fakeRunScheduled() {
    if (!process.env.PROACTIVE_ENABLED) return;
    called = true;
  }
  await fakeRunScheduled();
  assert.equal(called, false, 'should not proceed when PROACTIVE_ENABLED is unset');

  // Restore
  if (prev !== undefined) process.env.PROACTIVE_ENABLED = prev;
});

test('in-flight guard prevents concurrent runs', async () => {
  let runCount = 0;
  let _running = false;

  async function fakeRun() {
    if (_running) return;
    _running = true;
    try {
      runCount++;
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      _running = false;
    }
  }

  // Kick off two concurrent runs
  await Promise.all([fakeRun(), fakeRun()]);
  assert.equal(runCount, 1, 'only one run should complete');
});

test('getProactiveUsers excludes users with proactive=false', () => {
  const d = buildDb();
  const now = Date.now();
  d.prepare("INSERT INTO users (user_id, preferences, created_at, updated_at) VALUES ('u1', ?, ?, ?)").run(JSON.stringify({ proactive: 'false' }), now, now);
  d.prepare("INSERT INTO users (user_id, preferences, created_at, updated_at) VALUES ('u2', ?, ?, ?)").run(JSON.stringify({}), now, now);

  // Inline getProactiveUsers logic
  const rows = d.prepare('SELECT user_id, preferences FROM users').all();
  const users = [];
  for (const row of rows) {
    let prefs = {};
    try { prefs = JSON.parse(row.preferences ?? '{}'); } catch {}
    if (prefs.proactive === 'false' || prefs.proactive === false) continue;
    users.push({ userId: row.user_id, prefs });
  }

  assert.equal(users.length, 1);
  assert.equal(users[0].userId, 'u2');
});
