import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? './data/claudebot.db';

// Schema versions
const SCHEMA_V1 = 1; // core tables
const SCHEMA_V2 = 2; // message_log (append-only, Week 3)
const TARGET_VERSION = SCHEMA_V2;

let _db = null;

export function getDb() {
  if (!_db) throw new Error('DB not initialised — call initDb() first');
  return _db;
}

export async function initDb() {
  // Ensure data directory exists
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);

  // WAL mode: safe for hot-copy backups, better write concurrency
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  const version = _db.pragma('user_version', { simple: true });

  if (version < SCHEMA_V1) {
    await migrateV1(_db);
  }
  if (version < SCHEMA_V2) {
    await migrateV2(_db);
  }

  return _db;
}

// ─── V1: core tables ─────────────────────────────────────────────────────────

function migrateV1(db) {
  // Backup not needed for fresh install (no data yet)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id    TEXT PRIMARY KEY,
      preferences JSON,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(user_id),
      messages      JSON NOT NULL DEFAULT '[]',
      summary       TEXT,
      learnings     JSON NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      tool_use_total INTEGER NOT NULL DEFAULT 0,
      last_active   INTEGER,
      dreamed       INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_ids (
      platform    TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      user_id     TEXT NOT NULL REFERENCES users(user_id),
      linked_at   INTEGER NOT NULL,
      PRIMARY KEY (platform, platform_id)
    );

    CREATE TABLE IF NOT EXISTS link_tokens (
      token         TEXT PRIMARY KEY,
      from_user_id  TEXT NOT NULL,
      from_platform TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      used          INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS skills_generated (
      id               TEXT PRIMARY KEY,
      trigger_workflow TEXT,
      tool_use_count   INTEGER,
      skill_path       TEXT,
      confidence_score REAL,
      status           TEXT NOT NULL DEFAULT 'pending',
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id       TEXT PRIMARY KEY,
      user_id  TEXT NOT NULL,
      message  TEXT,
      fire_at  INTEGER NOT NULL,
      platform TEXT,
      fired    INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_threads_dreaming
      ON threads(last_active, dreamed)
      WHERE dreamed = 0;

    CREATE INDEX IF NOT EXISTS idx_reminders_schedule
      ON reminders(fire_at, fired)
      WHERE fired = 0;
  `);

  db.pragma('user_version = 1');
  console.log('[db] schema v1 applied');
}

// ─── V2: append-only message log ─────────────────────────────────────────────

function migrateV2(db) {
  // Backup before migrating (has live data at this point)
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, `${DB_PATH}.v1.bak`);
    console.log('[db] backup written to claudebot.db.v1.bak');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL REFERENCES users(user_id),
      msg_uuid    TEXT    NOT NULL UNIQUE,
      parent_uuid TEXT,
      role        TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      platform    TEXT,
      ts          INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_message_log_user
      ON message_log(user_id, id);

    ALTER TABLE threads ADD COLUMN messages_migrated INTEGER NOT NULL DEFAULT 0;
  `);

  // Backfill: convert existing threads.messages JSON arrays into message_log rows
  const threads = db.prepare(
    "SELECT user_id, messages FROM threads WHERE messages != '[]' AND messages_migrated = 0"
  ).all();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO message_log (user_id, msg_uuid, parent_uuid, role, content, platform, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const markMigrated = db.prepare(
    'UPDATE threads SET messages_migrated = 1 WHERE user_id = ?'
  );

  const backfill = db.transaction((thread) => {
    let msgs;
    try { msgs = JSON.parse(thread.messages); } catch { msgs = []; }
    let prevUuid = null;
    for (const m of msgs) {
      const uuid = crypto.randomUUID();
      insert.run(thread.user_id, uuid, prevUuid, m.role, m.content, m.platform ?? null, m.ts ?? Date.now());
      prevUuid = uuid;
    }
    markMigrated.run(thread.user_id);
  });

  for (const thread of threads) backfill(thread);

  db.pragma('user_version = 2');
  console.log(`[db] schema v2 applied — backfilled ${threads.length} thread(s) into message_log`);
}
