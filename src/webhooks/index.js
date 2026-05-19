/**
 * Webhook receiver — POST /hook/:webhookId
 *
 * External services authenticate with: Authorization: Bearer <token>
 * Body (JSON): { message: string, title?: string }
 *
 * Delivery priority (Discord):
 *   1. User's most recently active Discord channel
 *   2. Discord DM via platform_id
 *   3. Owner alert fallback
 */

import { getWebhookByToken, touchWebhook, getActiveChannels, getUserPlatformId } from '../memory/index.js';

// Simple in-memory rate limiter: 20 calls per minute per webhook
const _rlMap = new Map(); // webhookId → [timestamp, ...]
const HOOK_LIMIT = 20;
const HOOK_WINDOW = 60_000;

function _isRateLimited(webhookId) {
  const now = Date.now();
  const times = (_rlMap.get(webhookId) ?? []).filter((t) => now - t < HOOK_WINDOW);
  if (times.length >= HOOK_LIMIT) return true;
  times.push(now);
  _rlMap.set(webhookId, times);
  return false;
}

export function registerWebhookRoutes(app, { platformSenders = {}, sendOwnerAlert }) {
  app.post('/hook/:webhookId', async (req, res) => {
    const { webhookId } = req.params;

    // Auth: Bearer token
    const authHeader = req.headers['authorization'] ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

    const hook = getWebhookByToken(webhookId, token);
    if (!hook) return res.status(403).json({ error: 'Invalid webhook ID or token' });

    if (_isRateLimited(webhookId)) {
      return res.status(429).json({ error: 'Rate limit exceeded (20/min per webhook)' });
    }

    const { message, title } = req.body ?? {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Body must include { message: string }' });
    }

    const text = title
      ? `🔔 **${title.slice(0, 100)}**\n${message.slice(0, 1900)}`
      : `🔔 ${message.slice(0, 1900)}`;

    touchWebhook(webhookId);

    // Deliver
    const delivered = await _deliver(hook.user_id, text, platformSenders, sendOwnerAlert);

    console.log(`[webhook] ${hook.name} (${webhookId.slice(0, 8)}) fired — delivered=${delivered}`);
    res.json({ ok: true, delivered });
  });
}

async function _deliver(userId, text, platformSenders, sendOwnerAlert) {
  const discordSender = platformSenders['discord'];
  if (discordSender) {
    // 1. Most-recently-seen Discord channel for this user
    const channels = getActiveChannels('discord');
    // active_channels doesn't store user_id, so try DM first if no channel known
    // Try DM via platform_id
    const platformId = getUserPlatformId(userId, 'discord');
    if (platformId && discordSender.sendDM) {
      const ok = await discordSender.sendDM(platformId, text).catch(() => false);
      if (ok) return true;
    }

    // 2. Last active channel as fallback (broadcasts to most recent active channel)
    if (channels.length && discordSender.sendToChannel) {
      // Sort by last_seen descending and find a channel likely belonging to this user
      // (active_channels doesn't store user_id, so just use the most recent)
      const sorted = [...channels].sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));
      for (const { channel_id } of sorted.slice(0, 3)) {
        const ok = await discordSender.sendToChannel(channel_id, text).catch(() => false);
        if (ok) return true;
      }
    }
  }

  // 3. Owner fallback
  await sendOwnerAlert(`[Webhook → user ${userId.slice(0, 8)}]\n${text}`);
  return false;
}
