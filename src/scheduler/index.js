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
import {
  getDueReminders, markReminderFired, getUserPlatformId,
  getUsersWithDigest, getUpcomingReminders,
  getBotState, setBotState,
} from '../memory/index.js';
import { checkGatewayHealth } from '../core/claude.js';

const tracer = trace.getTracer('claudebot', '2.0.0');

export function startScheduler({ sendOwnerAlert, platformSenders = {} }) {
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

  // ── Reminders every minute ─────────────────────────────────────────────────
  cron.schedule('* * * * *', async () => {
    const due = getDueReminders();
    for (const reminder of due) {
      await tracer.startActiveSpan('reminder.fire', async (span) => {
        const platform = reminder.platform ?? 'unknown';
        span.setAttribute('platform', platform);
        try {
          const delivered = await _routeReminder(reminder, platformSenders, sendOwnerAlert);
          markReminderFired(reminder.id);
          _incReminderFired(platform);
          span.setAttribute('delivered', delivered);
          span.setStatus({ code: SpanStatusCode.OK });
          console.log(`[scheduler] Reminder fired (${platform}, delivered=${delivered}): "${reminder.message?.slice(0, 60)}"`);
        } catch (err) {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
          console.error('[scheduler] Reminder delivery failed:', err.message);
        } finally {
          span.end();
        }
      });
    }
  });

  // ── Proactive OAuth token refresh every 30 minutes ────────────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { syncAndRestart } = await import('../core/gateway-manager.js');
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');

      const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (!fs.existsSync(credsPath)) return;

      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const expiresAt = creds?.claudeAiOauth?.expiresAt;
      if (!expiresAt) return;

      const msUntilExpiry = expiresAt - Date.now();
      if (msUntilExpiry < 35 * 60 * 1000) { // within 35 minutes
        console.log(`[scheduler] OAuth token expires in ${Math.round(msUntilExpiry / 60000)}min — refreshing gateway`);
        await syncAndRestart();
        console.log('[scheduler] Gateway token refreshed');
      }
    } catch (err) {
      console.warn('[scheduler] Token refresh check failed:', err.message);
    }
  });

  // ── Dreaming curator every hour ─────────────────────────────────────────────
  cron.schedule('30 * * * *', async () => {
    try {
      const dreaming = await import('../dreaming/index.js');
      dreaming.setSendAlert(sendOwnerAlert);
      dreaming.setPlatformSenders(platformSenders, sendOwnerAlert);
      await dreaming.reviewCandidates();
    } catch {
      // Dreaming module not yet present — skip silently
    }
  });

  // ── Proactive briefs every minute (hour-gated inside runScheduled) ───────────
  cron.schedule('* * * * *', async () => {
    try {
      const proactive = await import('../proactive/index.js');
      await proactive.runScheduled(platformSenders, sendOwnerAlert);
    } catch (err) {
      // Proactive module not present or env disabled — skip silently
      if (process.env.PROACTIVE_ENABLED) {
        console.warn('[scheduler] Proactive run failed:', err.message);
      }
    }
  });

  // ── Database backup every 6 hours ────────────────────────────────────────────
  cron.schedule('0 */6 * * *', async () => {
    try {
      const { runBackup } = await import('../backup/index.js');
      const result = await runBackup();
      if (!result.ok) {
        await sendOwnerAlert(`⚠️ Database backup failed: ${result.error}`);
      }
    } catch (err) {
      console.warn('[scheduler] Backup job error:', err.message);
      await sendOwnerAlert(`⚠️ Database backup job threw: ${err.message}`);
    }
  });

  // ── Daily digest every minute (checks per-user digest_time preference) ───────
  cron.schedule('* * * * *', async () => {
    try {
      await _runDigests(platformSenders, sendOwnerAlert);
    } catch (err) {
      console.warn('[scheduler] Digest run failed:', err.message);
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

/**
 * Route a reminder to the right destination.
 *
 * Delivery priority:
 *   1. reminder.channel_id  — send to the exact channel where it was set
 *   2. user's platform DM   — look up platform_id and DM them directly
 *   3. owner fallback        — sendOwnerAlert (last resort)
 *
 * Returns true if delivered via a user-specific route, false if fell back to owner.
 */
async function _routeReminder(reminder, platformSenders, sendOwnerAlert) {
  const text = `🔔 Reminder: ${reminder.message}`;
  const platform = reminder.platform;
  const sender = platform ? platformSenders[platform] : null;

  // 1. Specific channel (where the reminder was created)
  if (sender?.sendToChannel && reminder.channel_id) {
    const ok = await sender.sendToChannel(reminder.channel_id, text);
    if (ok) return true;
  }

  // 2. DM the user directly via their platform ID
  if (sender?.sendDM && reminder.user_id) {
    const platformUserId = getUserPlatformId(reminder.user_id, platform);
    if (platformUserId) {
      const ok = await sender.sendDM(platformUserId, text);
      if (ok) return true;
    }
  }

  // 3. Owner fallback
  await sendOwnerAlert(text);
  return false;
}

// ─── Daily digest ─────────────────────────────────────────────────────────────

/**
 * For each user with digest_time set, check if now (in their timezone) matches
 * their configured HH:MM. If so, and if not already sent today, send the digest.
 */
async function _runDigests(platformSenders, sendOwnerAlert) {
  const users = getUsersWithDigest();

  for (const { userId, prefs, platforms } of users) {
    const tz = prefs.timezone ?? 'UTC';
    const digestTime = prefs.digest_time; // e.g. "09:00"
    if (!digestTime) continue;

    // Current HH:MM in user's timezone
    const now = new Date();
    let currentHHMM;
    try {
      currentHHMM = now.toLocaleString('en-US', {
        timeZone: tz,
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).replace(',', '').trim(); // "09:00"
    } catch {
      continue; // invalid timezone — skip
    }

    if (currentHHMM !== digestTime) continue;

    // Dedup: only send once per calendar day in user's timezone
    const todayKey = now.toLocaleDateString('en-CA', { timeZone: tz }); // "2026-05-19"
    const sentKey = `digest:${userId}:${todayKey}`;
    if (getBotState(sentKey) === '1') continue;

    // Build the digest message
    const message = _buildDigestMessage(userId, tz, prefs);

    // Deliver via DM on each known platform (prefer discord)
    let delivered = false;
    const orderedPlatforms = [...platforms].sort((a) => (a.platform === 'discord' ? -1 : 1));
    for (const { platform, platform_id: platformId } of orderedPlatforms) {
      const sender = platformSenders[platform];
      if (sender?.sendDM) {
        const ok = await sender.sendDM(platformId, message).catch(() => false);
        if (ok) { delivered = true; break; }
      }
    }
    if (!delivered) await sendOwnerAlert(`[Digest for ${userId}]\n${message}`);

    setBotState(sentKey, '1');
    console.log(`[scheduler] Digest sent to ${userId} (${tz}, delivered=${delivered})`);
  }
}

function _buildDigestMessage(userId, tz, prefs) {
  const upcoming = getUpcomingReminders(userId, 7 * 24 * 60 * 60 * 1000);

  const todayEnd = _endOfDayMs(tz);
  const todayItems = upcoming.filter((r) => r.fire_at <= todayEnd);
  const laterItems = upcoming.filter((r) => r.fire_at > todayEnd);

  const greeting = _greeting(tz);
  const lines = [`${greeting}`];

  if (todayItems.length) {
    lines.push('\n**Today:**');
    for (const r of todayItems) {
      const time = _formatTime(r.fire_at, tz);
      const recur = r.recur && r.recur !== 'none' ? ` *(${r.recur})*` : '';
      lines.push(`• ${time} — ${r.message}${recur}`);
    }
  }

  if (laterItems.length) {
    lines.push('\n**Coming up (next 7 days):**');
    for (const r of laterItems) {
      const when = _formatDateTime(r.fire_at, tz);
      const recur = r.recur && r.recur !== 'none' ? ` *(${r.recur})*` : '';
      lines.push(`• ${when} — ${r.message}${recur}`);
    }
  }

  if (!todayItems.length && !laterItems.length) {
    lines.push('\nNo reminders coming up. Enjoy a clear schedule!');
  }

  return lines.join('\n');
}

function _greeting(tz) {
  const hour = parseInt(
    new Date().toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false }),
    10
  );
  if (hour < 12) return '🌅 Good morning!';
  if (hour < 17) return '☀️ Good afternoon!';
  return '🌙 Good evening!';
}

function _endOfDayMs(tz) {
  // Midnight tonight in the user's timezone
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // "2026-05-19"
  return new Date(`${dateStr}T23:59:59.999`).getTime() +
    (now.getTimezoneOffset() * 60_000) +
    _tzOffsetMs(tz, now);
}

function _tzOffsetMs(tz, date) {
  // Compute the offset of tz vs UTC at a given date
  const utc = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const local = date.toLocaleString('en-US', { timeZone: tz });
  return new Date(local) - new Date(utc);
}

function _formatTime(ms, tz) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function _formatDateTime(ms, tz) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}
