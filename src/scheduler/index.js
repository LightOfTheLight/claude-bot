/**
 * Scheduler — node-cron jobs:
 *   every 10 min : gateway health check + owner DM on failure
 *   every hour   : fire due reminders
 *   every hour   : dreaming curator (post-session skill generation)
 *
 * Observable gauge: bot_active_threads registered here (needs DB access).
 */

import cron from 'node-cron';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { getDb } from '../memory/db.js';
import { getDueReminders, markReminderFired } from '../memory/index.js';
import { checkGatewayHealth } from '../core/claude.js';

const tracer = trace.getTracer('claudebot', '2.0.0');

export function startScheduler({ sendOwnerAlert }) {
  // Wire bot_active_threads gauge (DB query, safe to do here after initDb())
  _registerActiveThreadsGauge();

  // ── Gateway health every 10 minutes ────────────────────────────────────────
  cron.schedule('*/10 * * * *', async () => {
    await tracer.startActiveSpan('gateway.health_check', async (span) => {
      try {
        const healthy = await checkGatewayHealth(1); // single attempt in scheduled check
        if (!healthy) {
          console.warn('[scheduler] Gateway health check failed');
          _incGatewayFailure('unreachable');
          await sendOwnerAlert('⚠️ AI Gateway is unreachable — manual check needed on port 4242.');
        }
        span.setStatus({ code: healthy ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      } catch (err) {
        span.recordException(err);
      } finally {
        span.end();
      }
    });
  });

  // ── Reminders every hour ────────────────────────────────────────────────────
  cron.schedule('0 * * * *', async () => {
    const due = getDueReminders();
    for (const reminder of due) {
      await tracer.startActiveSpan('reminder.fire', async (span) => {
        span.setAttribute('platform', reminder.platform ?? 'unknown');
        try {
          await sendOwnerAlert(`🔔 Reminder: ${reminder.message}`);
          // TODO Phase 2: route to correct platform via platform_ids lookup
          markReminderFired(reminder.id);
          _incReminderFired(reminder.platform ?? 'unknown');
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
        } finally {
          span.end();
        }
      });
    }
  });

  // ── Dreaming curator every hour ─────────────────────────────────────────────
  cron.schedule('30 * * * *', async () => {
    try {
      const dreaming = await import('../dreaming/index.js');
      dreaming.setSendAlert(sendOwnerAlert);
      await dreaming.reviewCandidates();
    } catch {
      // Dreaming module not yet present — skip silently
    }
  });

  console.log('[scheduler] jobs registered');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _registerActiveThreadsGauge() {
  try {
    const { gauges } = await import('../telemetry/index.js');
    gauges.activeThreads.addCallback((result) => {
      try {
        const db = getDb();
        const row = db.prepare(
          'SELECT COUNT(*) as n FROM threads WHERE last_active > ?'
        ).get(Date.now() - 24 * 60 * 60 * 1000);
        result.observe(row?.n ?? 0);
      } catch {}
    });
  } catch {
    // Telemetry not initialised — skip
  }
}

async function _incGatewayFailure(reason) {
  try {
    const { counters } = await import('../telemetry/index.js');
    counters.gatewayFailures.add(1, { reason });
  } catch {}
}

async function _incReminderFired(platform) {
  try {
    const { counters } = await import('../telemetry/index.js');
    counters.remindersFired.add(1, { platform });
  } catch {}
}
