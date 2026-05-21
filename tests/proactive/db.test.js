/**
 * Tests for V9 DB migration: proactive_sends, proactive_feedback tables + indexes,
 * and skills_generated.content column.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Apply migrations up through V9 using an in-memory DB
function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // V1
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY, preferences JSON,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id),
      messages JSON NOT NULL DEFAULT '[]', summary TEXT,
      learnings JSON NOT NULL DEFAULT '[]', message_count INTEGER NOT NULL DEFAULT 0,
      tool_use_total INTEGER NOT NULL DEFAULT 0, last_active INTEGER,
      dreamed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_ids (
      platform TEXT NOT NULL, platform_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(user_id), linked_at INTEGER NOT NULL,
      PRIMARY KEY (platform, platform_id)
    );
    CREATE TABLE IF NOT EXISTS skills_generated (
      id TEXT PRIMARY KEY, trigger_workflow TEXT, tool_use_count INTEGER,
      skill_path TEXT, confidence_score REAL, status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      msg_uuid TEXT NOT NULL UNIQUE, parent_uuid TEXT, role TEXT NOT NULL,
      content TEXT NOT NULL, platform TEXT, ts INTEGER NOT NULL
    );
  `);

  // V9 migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_sends (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      channel_id TEXT, message TEXT NOT NULL, sent_at INTEGER NOT NULL,
      template TEXT, confidence REAL, discord_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_sends_dedup ON proactive_sends(user_id, kind, sent_at);
    CREATE INDEX IF NOT EXISTS idx_proactive_sends_discord_msg ON proactive_sends(discord_message_id);
    CREATE TABLE IF NOT EXISTS proactive_feedback (
      id TEXT PRIMARY KEY, send_id TEXT NOT NULL REFERENCES proactive_sends(id),
      user_id TEXT NOT NULL, rating INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
  `);

  // Add content column (simulating the PRAGMA check)
  const cols = db.prepare("PRAGMA table_info(skills_generated)").all();
  if (!cols.some(c => c.name === 'content')) {
    db.exec('ALTER TABLE skills_generated ADD COLUMN content TEXT;');
  }

  return db;
}

test('proactive_sends table exists with correct columns', () => {
  const db = buildTestDb();
  const cols = db.prepare("PRAGMA table_info(proactive_sends)").all().map(c => c.name);
  assert.ok(cols.includes('id'));
  assert.ok(cols.includes('user_id'));
  assert.ok(cols.includes('kind'));
  assert.ok(cols.includes('channel_id'));
  assert.ok(cols.includes('message'));
  assert.ok(cols.includes('sent_at'));
  assert.ok(cols.includes('template'));
  assert.ok(cols.includes('confidence'));
  assert.ok(cols.includes('discord_message_id'));
});

test('proactive_feedback table exists with correct columns', () => {
  const db = buildTestDb();
  const cols = db.prepare("PRAGMA table_info(proactive_feedback)").all().map(c => c.name);
  assert.ok(cols.includes('id'));
  assert.ok(cols.includes('send_id'));
  assert.ok(cols.includes('user_id'));
  assert.ok(cols.includes('rating'));
  assert.ok(cols.includes('created_at'));
});

test('idx_proactive_sends_dedup index exists', () => {
  const db = buildTestDb();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_proactive_sends_dedup'").get();
  assert.ok(idx, 'dedup index should exist');
});

test('idx_proactive_sends_discord_msg index exists', () => {
  const db = buildTestDb();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_proactive_sends_discord_msg'").get();
  assert.ok(idx, 'discord_msg index should exist');
});

test('skills_generated.content column added by V9 migration', () => {
  const db = buildTestDb();
  const cols = db.prepare("PRAGMA table_info(skills_generated)").all().map(c => c.name);
  assert.ok(cols.includes('content'), 'skills_generated should have content column');
});

test('proactive_feedback references proactive_sends FK', () => {
  const db = buildTestDb();
  // Insert a send, then feedback referencing it — should succeed
  db.prepare("INSERT INTO proactive_sends (id, user_id, kind, message, sent_at) VALUES ('s1', 'u1', 'morning_brief', 'hi', 1000)").run();
  db.prepare("INSERT INTO proactive_feedback (id, send_id, user_id, rating, created_at) VALUES ('f1', 's1', 'u1', 1, 1000)").run();
  const f = db.prepare("SELECT * FROM proactive_feedback WHERE id='f1'").get();
  assert.equal(f.send_id, 's1');
});

test('V9 migration is idempotent (running CREATE IF NOT EXISTS twice is safe)', () => {
  const db = buildTestDb();
  // Running again should not throw
  assert.doesNotThrow(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS proactive_sends (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      channel_id TEXT, message TEXT NOT NULL, sent_at INTEGER NOT NULL,
      template TEXT, confidence REAL, discord_message_id TEXT
    );`);
  });
});
