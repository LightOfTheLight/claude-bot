/**
 * Request trace store — in-memory ring buffer backed by SQLite.
 * Traces survive bot restarts: finalized traces are persisted to the `traces`
 * table and reloaded into memory on startup via initTraceStore().
 *
 * Steps (in order):
 *   identity → command_check → rate_limit → context_fetch →
 *   ai_call → tag_extraction → delivery → memory_persist
 */

import { getDb } from '../memory/db.js';

const MAX_TRACES  = 200; // in-memory ring
const DB_KEEP     = 500; // rows kept in DB (older ones pruned)

/** @type {Map<string, object>} traceId → trace */
const _traces = new Map();
/** @type {string[]} ordered ring of trace IDs (oldest first) */
const _order = [];

let _seq = 0;

// ─── Persistence helpers ──────────────────────────────────────────────────────

function _saveTrace(trace) {
  try {
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO traces (id, started_at, data) VALUES (?, ?, ?)'
    ).run(trace.id, trace.startedAt, JSON.stringify(trace));

    // Prune rows beyond DB_KEEP, oldest first
    db.prepare(`
      DELETE FROM traces WHERE id NOT IN (
        SELECT id FROM traces ORDER BY started_at DESC LIMIT ?
      )
    `).run(DB_KEEP);
  } catch {
    // DB not ready or write error — silently skip (trace still lives in memory)
  }
}

/**
 * Load the most recent MAX_TRACES finalized traces from SQLite into the
 * in-memory ring buffer. Call once after initDb() completes.
 */
export function initTraceStore() {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT data FROM traces ORDER BY started_at DESC LIMIT ?'
    ).all(MAX_TRACES);

    // Insert oldest-first into the ring so _order reflects chronological order
    for (const row of rows.reverse()) {
      try {
        const t = JSON.parse(row.data);
        _traces.set(t.id, t);
        _order.push(t.id);
      } catch {}
    }

    console.log(`[trace] Loaded ${rows.length} trace(s) from DB`);
  } catch (err) {
    console.warn('[trace] Failed to load traces from DB:', err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a new trace. Returns the traceId.
 */
export function createTrace(meta) {
  const id = `t${Date.now()}-${++_seq}`;
  const trace = {
    id,
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: null,
    status: 'running',
    platform: meta.platform ?? 'unknown',
    userId: meta.userId ?? 'unknown',
    channelId: meta.channelId ?? null,
    preview: (meta.preview ?? '').slice(0, 120),
    steps: [],
    error: null,
  };

  _traces.set(id, trace);
  _order.push(id);

  // Evict oldest from memory if over capacity
  while (_order.length > MAX_TRACES) {
    const evict = _order.shift();
    _traces.delete(evict);
  }

  return id;
}

/**
 * Record a completed pipeline step.
 */
export function recordStep(traceId, name, data) {
  const trace = _traces.get(traceId);
  if (!trace) return;
  trace.steps.push({
    name,
    status: data.status ?? 'ok',
    durationMs: data.durationMs ?? 0,
    startedAt: data.startedAt ?? null,
    meta: data.meta ?? {},
  });
}

/**
 * Finalize a trace and persist it to SQLite.
 */
export function finalizeTrace(traceId, result) {
  const trace = _traces.get(traceId);
  if (!trace) return;
  trace.finishedAt = Date.now();
  trace.durationMs = trace.finishedAt - trace.startedAt;
  trace.status = result.status ?? 'ok';
  if (result.error) trace.error = result.error;
  _saveTrace(trace);
}

/**
 * Return the most recent `limit` traces (newest first).
 */
export function getTraces(limit = 50) {
  const ids = _order.slice(-limit).reverse();
  return ids.map((id) => _traces.get(id)).filter(Boolean);
}

/**
 * Return a single trace by ID.
 */
export function getTrace(id) {
  return _traces.get(id) ?? null;
}

/** Summary counts for the health endpoint. */
export function getTraceSummary() {
  const all = [..._traces.values()];
  const last5min = Date.now() - 5 * 60_000;
  const recent = all.filter((t) => t.startedAt >= last5min);
  const withDur = recent.filter((t) => t.durationMs);
  return {
    total: all.length,
    recent5min: recent.length,
    errors: recent.filter((t) => t.status === 'error').length,
    rateLimited: recent.filter((t) => t.status === 'rate_limited').length,
    avgDurationMs: withDur.length
      ? Math.round(withDur.reduce((s, t) => s + t.durationMs, 0) / withDur.length)
      : 0,
  };
}
