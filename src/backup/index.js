/**
 * Database backup — uses better-sqlite3's built-in .backup() for hot,
 * consistent copies that work safely with WAL mode and concurrent reads/writes.
 *
 * Backup location: DB_PATH directory / backups / claudebot-YYYY-MM-DD-HH.db
 * Retention: keeps last KEEP_COUNT backups, deletes older ones.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../memory/db.js';
import { setBotState, getBotState } from '../memory/index.js';

const DB_PATH     = process.env.DB_PATH ?? './data/claudebot.db';
const BACKUP_DIR  = path.join(path.dirname(DB_PATH), 'backups');
const KEEP_COUNT  = parseInt(process.env.BACKUP_KEEP ?? '14', 10);

/**
 * Run a backup now.
 * Returns { ok, path, sizeBytes, durationMs, error? }.
 */
export async function runBackup() {
  const start = Date.now();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString()
    .replace('T', '-')
    .replace(/:/g, '')
    .slice(0, 15); // "2026-05-19-0830"
  const dest = path.join(BACKUP_DIR, `claudebot-${stamp}.db`);

  try {
    const db = getDb();
    await db.backup(dest);

    const sizeBytes = fs.statSync(dest).size;
    const durationMs = Date.now() - start;

    setBotState('lastBackupAt', String(Date.now()));
    setBotState('lastBackupPath', dest);

    _pruneOldBackups();

    console.log(`[backup] Written ${dest} (${_humanSize(sizeBytes)}, ${durationMs}ms)`);
    return { ok: true, path: dest, sizeBytes, durationMs };
  } catch (err) {
    console.error('[backup] Failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/** Return info about the most recent backup, or null if none yet. */
export function getLastBackupInfo() {
  const at   = getBotState('lastBackupAt');
  const file = getBotState('lastBackupPath');
  if (!at) return null;
  const ts = parseInt(at, 10);
  const exists = file && fs.existsSync(file);
  return { ts, file, exists };
}

/** List all backup files sorted newest → oldest. */
export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('claudebot-') && f.endsWith('.db'))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      const { size, mtimeMs } = fs.statSync(full);
      return { file: full, name: f, sizeBytes: size, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _pruneOldBackups() {
  const backups = listBackups();
  if (backups.length <= KEEP_COUNT) return;
  const toDelete = backups.slice(KEEP_COUNT);
  for (const { file, name } of toDelete) {
    try {
      fs.unlinkSync(file);
      console.log(`[backup] Pruned old backup: ${name}`);
    } catch {}
  }
}

function _humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}
