/**
 * Dashboard HTTP routes.
 *
 *   GET  /dashboard          — serve the single-page UI
 *   GET  /api/traces         — list recent traces (newest first)
 *   GET  /api/traces/:id     — single trace with full step detail
 *   GET  /api/health         — trace summary + uptime
 *
 * Protected by DASHBOARD_TOKEN env var (if set) via ?token= or Authorization: Bearer header.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTraces, getTrace, getTraceSummary } from '../trace/index.js';
import { getDb } from '../memory/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, 'dashboard.html'), 'utf8');
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';

function auth(req, res) {
  if (!TOKEN) return true; // unprotected if no token configured
  const header = req.headers.authorization ?? '';
  const query  = req.query.token ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : query;
  if (provided === TOKEN) return true;
  res.status(401).json({ error: 'Unauthorized — set ?token=<DASHBOARD_TOKEN>' });
  return false;
}

export function registerDashboardRoutes(app) {
  // Serve the SPA
  app.get('/dashboard', (req, res) => {
    if (!auth(req, res)) return;
    res.setHeader('Content-Type', 'text/html');
    res.send(HTML);
  });

  // List traces
  app.get('/api/traces', (req, res) => {
    if (!auth(req, res)) return;
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
    const platform = req.query.platform ?? null;
    let traces = getTraces(limit);
    if (platform) traces = traces.filter((t) => t.platform === platform);
    res.json(traces);
  });

  // Single trace detail
  app.get('/api/traces/:id', (req, res) => {
    if (!auth(req, res)) return;
    const t = getTrace(req.params.id);
    if (!t) return res.status(404).json({ error: 'Trace not found' });
    res.json(t);
  });

  // Health / summary
  app.get('/api/health', (req, res) => {
    if (!auth(req, res)) return;
    const summary = getTraceSummary();
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      ...summary,
    });
  });

  // Dreaming stats + skill candidates
  app.get('/api/dreaming', (req, res) => {
    if (!auth(req, res)) return;
    try {
      const db = getDb();

      const skills = db.prepare(
        'SELECT * FROM skills_generated ORDER BY created_at DESC LIMIT 100'
      ).all();

      const IDLE_MS = 2 * 60 * 60 * 1000;
      const cutoff  = Date.now() - IDLE_MS;

      const threads = db.prepare(`
        SELECT user_id, tool_use_total, last_active, dreamed
        FROM threads
        ORDER BY tool_use_total DESC
        LIMIT 50
      `).all();

      // Annotate each thread with its dreaming state
      const candidates = threads.map((t) => ({
        userId:        t.user_id,
        toolUseTotal:  t.tool_use_total,
        lastActive:    t.last_active,
        dreamed:       t.dreamed === 1,
        readyToDream:  t.dreamed === 0 && t.tool_use_total > 5 && t.last_active < cutoff,
        waitingIdle:   t.dreamed === 0 && t.tool_use_total > 5 && t.last_active >= cutoff,
        needsMoreUse:  t.dreamed === 0 && t.tool_use_total <= 5,
      }));

      const stats = {
        total:       skills.length,
        pending:     skills.filter((s) => s.status === 'pending').length,
        approved:    skills.filter((s) => s.status === 'approved').length,
        autoKept:    skills.filter((s) => s.status === 'auto-kept').length,
        rejected:    skills.filter((s) => s.status === 'rejected').length,
        readyNow:    candidates.filter((c) => c.readyToDream).length,
        waitingIdle: candidates.filter((c) => c.waitingIdle).length,
        dreamed:     candidates.filter((c) => c.dreamed).length,
      };

      res.json({ skills, candidates, stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Proactive sends + feedback
  app.get('/api/proactive', (req, res) => {
    if (!auth(req, res)) return;
    try {
      const db = getDb();

      const sends = db.prepare(
        'SELECT * FROM proactive_sends ORDER BY sent_at DESC LIMIT 100'
      ).all();

      const feedback = db.prepare(
        'SELECT * FROM proactive_feedback ORDER BY created_at DESC LIMIT 100'
      ).all();

      // Compute next fire times for morning_brief and nightly_sync (UTC, next occurrence)
      const morningHour = parseInt(process.env.PROACTIVE_MORNING_HOUR || '7', 10);
      const nightHour   = parseInt(process.env.PROACTIVE_NIGHT_HOUR   || '21', 10);

      function nextFireISO(targetHour) {
        const now = new Date();
        const next = new Date(now);
        next.setUTCMinutes(0, 0, 0);
        next.setUTCHours(targetHour);
        if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
        return next.toISOString();
      }

      // EMA thresholds per template from bot_state
      const TEMPLATES = ['UNRESOLVED_THREAD', 'REPEATED_QUESTION', 'LONG_SILENCE', 'UNRESOLVED_INTENT', 'BROKEN_STREAK'];
      const thresholds = TEMPLATES.map((template) => {
        const row = db.prepare('SELECT value FROM bot_state WHERE key = ?').get(`proactive_threshold_${template}`);
        const threshold = row ? parseFloat(row.value) : 0.7;
        const feedbackCount = db.prepare(
          `SELECT COUNT(*) as n FROM proactive_feedback pf
           JOIN proactive_sends ps ON ps.id = pf.send_id
           WHERE ps.template = ?`
        ).get(template)?.n ?? 0;
        return { template, threshold, feedbackCount };
      });

      res.json({
        sends,
        feedback,
        thresholds,
        nextFires: {
          morning_brief: nextFireISO(morningHour),
          nightly_sync:  nextFireISO(nightHour),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Triggers list
  app.get('/api/triggers', (req, res) => {
    if (!auth(req, res)) return;
    try {
      const db = getDb();
      const triggers = db.prepare(`
        SELECT t.*, u.user_id as owner_user_id
        FROM triggers t
        LEFT JOIN users u ON u.user_id = t.user_id
        ORDER BY t.created_at DESC
      `).all();
      res.json({ triggers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[dashboard] Routes registered: GET /dashboard  GET /api/traces  GET /api/dreaming  GET /api/proactive  GET /api/triggers  GET /api/health');
}
