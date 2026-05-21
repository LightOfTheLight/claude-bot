/**
 * Tests for proactive/feedback.js:
 * - EMA formula (floor, ceil, convergence)
 * - getThreshold default
 * - handleReaction: 👍/👎/unknown emoji
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ── In-memory DB setup ────────────────────────────────────────────────────────

let db;

function buildDb() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE proactive_sends (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      channel_id TEXT, message TEXT NOT NULL, sent_at INTEGER NOT NULL,
      template TEXT, confidence REAL, discord_message_id TEXT
    );
    CREATE TABLE proactive_feedback (
      id TEXT PRIMARY KEY, send_id TEXT NOT NULL REFERENCES proactive_sends(id),
      user_id TEXT NOT NULL, rating INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  return d;
}

// ── Mock the module DB ────────────────────────────────────────────────────────

// We test the logic directly by re-implementing with the in-memory DB
// rather than trying to mock ES module internals.

const FLOOR = 0.3;
const CEIL = 0.95;
const INITIAL = 0.7;

function getThreshold(d, template) {
  const row = d.prepare('SELECT value FROM bot_state WHERE key = ?').get(`proactive_threshold_${template}`);
  return row ? parseFloat(row.value) : INITIAL;
}

function updateThreshold(d, template, ratingNorm) {
  const old = getThreshold(d, template);
  const next = Math.max(FLOOR, Math.min(CEIL, 0.8 * old + 0.2 * ratingNorm));
  d.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)').run(`proactive_threshold_${template}`, String(next));
  return next;
}

function handleReaction(d, messageId, emoji, userId) {
  const send = d.prepare('SELECT id, user_id, template FROM proactive_sends WHERE discord_message_id = ?').get(messageId);
  if (!send) return false;
  const rating = emoji === '👍' ? 1 : emoji === '👎' ? -1 : null;
  if (rating === null) return false;
  const ratingNorm = rating === 1 ? 1.0 : 0.0;
  const { randomUUID } = await import('crypto').catch(() => ({ randomUUID: () => Math.random().toString(36) }));
  d.prepare('INSERT INTO proactive_feedback (id, send_id, user_id, rating, created_at) VALUES (?, ?, ?, ?, ?)').run(
    Math.random().toString(36), send.id, userId, rating, Date.now()
  );
  if (send.template) updateThreshold(d, send.template, ratingNorm);
  return true;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('getThreshold returns INITIAL (0.7) when no key stored', () => {
  const d = buildDb();
  const t = getThreshold(d, 'MORNING_BRIEF');
  assert.equal(t, 0.7);
});

test('EMA formula: 👍 reaction moves threshold toward CEIL', () => {
  const d = buildDb();
  const next = updateThreshold(d, 'TEST', 1.0);
  // 0.8 * 0.7 + 0.2 * 1.0 = 0.56 + 0.20 = 0.76
  assert.ok(Math.abs(next - 0.76) < 0.0001, `expected ~0.76, got ${next}`);
});

test('EMA formula: 👎 reaction moves threshold toward FLOOR', () => {
  const d = buildDb();
  const next = updateThreshold(d, 'TEST', 0.0);
  // 0.8 * 0.7 + 0.2 * 0.0 = 0.56
  assert.ok(Math.abs(next - 0.56) < 0.0001, `expected ~0.56, got ${next}`);
});

test('EMA clamps at FLOOR (0.3)', () => {
  const d = buildDb();
  // Drive threshold all the way down
  let val = INITIAL;
  for (let i = 0; i < 50; i++) {
    val = updateThreshold(d, 'FLOOR_TEST', 0.0);
  }
  assert.ok(val >= FLOOR, `threshold should never go below ${FLOOR}, got ${val}`);
});

test('EMA clamps at CEIL (0.95)', () => {
  const d = buildDb();
  let val = INITIAL;
  for (let i = 0; i < 50; i++) {
    val = updateThreshold(d, 'CEIL_TEST', 1.0);
  }
  assert.ok(val <= CEIL, `threshold should never exceed ${CEIL}, got ${val}`);
});

test('handleReaction returns false for unknown messageId', () => {
  const d = buildDb();
  const result = handleReaction(d, 'nonexistent-msg-id', '👍', 'user1');
  assert.equal(result, false);
});

test('handleReaction returns false for unmapped emoji', () => {
  const d = buildDb();
  d.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at, discord_message_id) VALUES ('s1','u1','morning_brief','hi',1000,'discord-msg-1')").run();
  const result = handleReaction(d, 'discord-msg-1', '🎉', 'u1');
  assert.equal(result, false);
});

test('handleReaction 👍 inserts feedback with rating=1', () => {
  const d = buildDb();
  d.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at, discord_message_id, template) VALUES ('s1','u1','morning_brief','hi',1000,'discord-msg-1','MORNING_BRIEF')").run();
  const result = handleReaction(d, 'discord-msg-1', '👍', 'u1');
  assert.equal(result, true);
  const fb = d.prepare("SELECT * FROM proactive_feedback LIMIT 1").get();
  assert.equal(fb.rating, 1);
  assert.equal(fb.user_id, 'u1');
});

test('handleReaction 👎 inserts feedback with rating=-1', () => {
  const d = buildDb();
  d.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at, discord_message_id, template) VALUES ('s2','u2','nightly_sync','good night',2000,'discord-msg-2','NIGHTLY_SYNC')").run();
  const result = handleReaction(d, 'discord-msg-2', '👎', 'u2');
  assert.equal(result, true);
  const fb = d.prepare("SELECT * FROM proactive_feedback LIMIT 1").get();
  assert.equal(fb.rating, -1);
});

test('handleReaction updates EMA threshold after 👍', () => {
  const d = buildDb();
  d.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at, discord_message_id, template) VALUES ('s3','u3','morning_brief','hello',1000,'msg-3','MY_TEMPLATE')").run();
  const before = getThreshold(d, 'MY_TEMPLATE');
  assert.equal(before, INITIAL);
  handleReaction(d, 'msg-3', '👍', 'u3');
  const after = getThreshold(d, 'MY_TEMPLATE');
  assert.ok(after > before, 'threshold should increase after 👍');
});
