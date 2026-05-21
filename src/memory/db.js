import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? './data/claudebot.db';

// Schema versions
const SCHEMA_V1 = 1; // core tables
const SCHEMA_V2 = 2; // message_log (append-only, Week 3)
const SCHEMA_V3 = 3; // bot_state, active_channels (catch-up on restart)
const SCHEMA_V4 = 4; // reminders: add channel_id for delivery routing
const SCHEMA_V5 = 5; // reminders: add recur for recurring reminders
const SCHEMA_V6 = 6; // message_log FTS5 virtual table for full-text search
const SCHEMA_V7 = 7; // webhooks table
const SCHEMA_V8 = 8; // traces table for persistent request trace storage
const SCHEMA_V9 = 9;  // proactive_sends, proactive_feedback, skills_generated.content
const SCHEMA_V10 = 10; // skill_invocations
const TARGET_VERSION = SCHEMA_V10;

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
  if (version < SCHEMA_V3) {
    migrateV3(_db);
  }
  if (version < SCHEMA_V4) {
    migrateV4(_db);
  }
  if (version < SCHEMA_V5) {
    migrateV5(_db);
  }
  if (version < SCHEMA_V6) {
    migrateV6(_db);
  }
  if (version < SCHEMA_V7) {
    migrateV7(_db);
  }
  if (version < SCHEMA_V8) {
    migrateV8(_db);
  }
  if (version < SCHEMA_V9) {
    migrateV9(_db);
  }
  if (version < SCHEMA_V10) {
    migrateV10(_db);
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

// ─── V3: bot_state + active_channels ─────────────────────────────────────────

function migrateV3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_channels (
      platform   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      guild_id   TEXT,
      last_seen  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (platform, channel_id)
    );
  `);

  db.pragma('user_version = 3');
  console.log('[db] schema v3 applied — bot_state, active_channels');
}

// ─── V4: reminder delivery routing ───────────────────────────────────────────

function migrateV4(db) {
  db.exec(`
    ALTER TABLE reminders ADD COLUMN channel_id TEXT;
  `);
  db.pragma('user_version = 4');
  console.log('[db] schema v4 applied — reminders.channel_id');
}

// ─── V5: recurring reminders ─────────────────────────────────────────────────

function migrateV5(db) {
  db.exec(`
    ALTER TABLE reminders ADD COLUMN recur TEXT;
  `);
  db.pragma('user_version = 5');
  console.log('[db] schema v5 applied — reminders.recur');
}

// ─── V6: full-text search on message_log ─────────────────────────────────────

function migrateV6(db) {
  // FTS5 virtual table — content= makes it a content table (no data duplication)
  // tokenize=porter enables stemming (search "run" matches "running", "ran")
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts
      USING fts5(content, content=message_log, content_rowid=id, tokenize='porter unicode61');

      -- Triggers to keep FTS index in sync with message_log
      CREATE TRIGGER IF NOT EXISTS message_log_ai AFTER INSERT ON message_log BEGIN
        INSERT INTO message_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS message_log_ad AFTER DELETE ON message_log BEGIN
        INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS message_log_au AFTER UPDATE ON message_log BEGIN
        INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO message_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    // Backfill existing messages into FTS index
    db.exec(`INSERT INTO message_fts(rowid, content) SELECT id, content FROM message_log`);
    console.log('[db] schema v6 applied — message_fts FTS5 (porter stemmer)');
  } catch (err) {
    // FTS5 not compiled in — log warning, search will fall back to LIKE
    console.warn('[db] schema v6: FTS5 unavailable, skipping virtual table:', err.message);
  }
  db.pragma('user_version = 6');
}

// ─── V7: webhooks ─────────────────────────────────────────────────────────────

function migrateV7(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(user_id),
      name       TEXT NOT NULL,
      token      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used  INTEGER,
      active     INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_webhooks_user
      ON webhooks(user_id, active);
  `);
  db.pragma('user_version = 7');
  console.log('[db] schema v7 applied — webhooks');
}

// ─── V8: request traces ───────────────────────────────────────────────────────

function migrateV8(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      id         TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      data       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_traces_started_at
      ON traces(started_at DESC);
  `);
  db.pragma('user_version = 8');
  console.log('[db] schema v8 applied — traces');
}

// ─── V9: proactive layer ──────────────────────────────────────────────────────

function migrateV9(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_sends (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      kind                TEXT NOT NULL,
      channel_id          TEXT,
      message             TEXT NOT NULL,
      sent_at             INTEGER NOT NULL,
      template            TEXT,
      confidence          REAL,
      discord_message_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_sends_dedup ON proactive_sends(user_id, kind, sent_at);
    CREATE INDEX IF NOT EXISTS idx_proactive_sends_discord_msg ON proactive_sends(discord_message_id);
    CREATE TABLE IF NOT EXISTS proactive_feedback (
      id          TEXT PRIMARY KEY,
      send_id     TEXT NOT NULL REFERENCES proactive_sends(id),
      user_id     TEXT NOT NULL,
      rating      INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
  `);

  // ALTER TABLE may fail if column already exists (e.g. fresh DB with pre-V9 schema)
  const cols = db.prepare("PRAGMA table_info(skills_generated)").all();
  const hasContent = cols.some((c) => c.name === 'content');
  if (!hasContent) {
    try {
      db.exec('ALTER TABLE skills_generated ADD COLUMN content TEXT;');
    } catch (err) {
      console.warn('[db] V9: could not add skills_generated.content:', err.message);
    }
  }

  db.pragma('user_version = 9');
  console.log('[db] schema v9 applied — proactive_sends, proactive_feedback, skills_generated.content');
}

// ─── V10: skill invocations ───────────────────────────────────────────────────

function migrateV10(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_invocations (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(user_id),
      skill_name TEXT NOT NULL,
      invoked_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_invocations_user_skill
      ON skill_invocations(user_id, skill_name, invoked_at);
  `);
  db.pragma('user_version = 10');
  console.log('[db] schema v10 applied — skill_invocations');
}
