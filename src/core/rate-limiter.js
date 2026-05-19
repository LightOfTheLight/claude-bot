/**
 * Per-user sliding-window rate limiter.
 *
 * Config (via env vars, all optional):
 *   RATE_LIMIT_PER_WINDOW  — max messages per window (default: 15)
 *   RATE_LIMIT_WINDOW_SEC  — window size in seconds    (default: 60)
 *   RATE_LIMIT_COOLDOWN_SEC — min gap between messages (default: 2)
 *   RATE_LIMIT_MAX_BURST   — ceiling for /set rate_limit override (default: 60)
 *
 * State is in-memory; resets on restart (intentional — gives users a fresh
 * quota after a bot bounce without needing DB writes on every message).
 */

const WINDOW_MS   = (parseInt(process.env.RATE_LIMIT_WINDOW_SEC,  10) || 60) * 1000;
const DEFAULT_MAX = parseInt(process.env.RATE_LIMIT_PER_WINDOW,   10) || 15;
const COOLDOWN_MS = (parseInt(process.env.RATE_LIMIT_COOLDOWN_SEC, 10) || 2) * 1000;
const BURST_CAP   = parseInt(process.env.RATE_LIMIT_MAX_BURST,    10) || 60;

export const RATE_CONFIG = { WINDOW_MS, DEFAULT_MAX, COOLDOWN_MS, BURST_CAP };

// userId → { timestamps: number[], lastTs: number }
const _state = new Map();

/**
 * Check whether a user is allowed to send a message right now.
 *
 * @param {string} userId      — internal UUID
 * @param {number} userMax     — per-user override from preferences (or DEFAULT_MAX)
 * @returns {{ allowed: boolean, retryAfterMs?: number, reason?: string }}
 */
export function checkRateLimit(userId, userMax = DEFAULT_MAX) {
  const max = Math.min(userMax, BURST_CAP);
  const now = Date.now();

  if (!_state.has(userId)) {
    _state.set(userId, { timestamps: [], lastTs: 0 });
  }
  const state = _state.get(userId);

  // Enforce minimum cooldown between consecutive messages
  const sinceLastMs = now - state.lastTs;
  if (state.lastTs > 0 && sinceLastMs < COOLDOWN_MS) {
    const retryAfterMs = COOLDOWN_MS - sinceLastMs;
    return { allowed: false, retryAfterMs, reason: 'cooldown' };
  }

  // Slide the window: drop timestamps older than WINDOW_MS
  state.timestamps = state.timestamps.filter((t) => now - t < WINDOW_MS);

  if (state.timestamps.length >= max) {
    // Oldest timestamp tells us when a slot opens up
    const oldestInWindow = state.timestamps[0];
    const retryAfterMs = WINDOW_MS - (now - oldestInWindow);
    return { allowed: false, retryAfterMs, reason: 'window' };
  }

  // Allowed — record this message
  state.timestamps.push(now);
  state.lastTs = now;
  return { allowed: true };
}

/** Current usage snapshot for a user (for /status display). */
export function getRateLimitStatus(userId, userMax = DEFAULT_MAX) {
  const max = Math.min(userMax, BURST_CAP);
  const now = Date.now();
  const state = _state.get(userId);
  if (!state) return { used: 0, max, windowSec: WINDOW_MS / 1000 };
  const used = state.timestamps.filter((t) => now - t < WINDOW_MS).length;
  return { used, max, windowSec: WINDOW_MS / 1000 };
}

/** Clear rate limit state for a user (used after /reset-context or by owner). */
export function clearRateLimit(userId) {
  _state.delete(userId);
}
