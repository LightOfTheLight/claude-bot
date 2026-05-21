import { Client, Events, GatewayIntentBits, Partials, AttachmentBuilder, InteractionType } from 'discord.js';
import * as proactiveFeedback from '../proactive/feedback.js';
import { registerSlashCommands } from '../discord/register.js';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { statSync } from 'node:fs';
import { getAuthUrl, hasGDriveAuth, isOversized, uploadToDrive, setUserFolder } from '../media/gdrive.js';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isAudio, transcribeAudio } from '../media/transcribe.js';
import { isImage, describeImage } from '../media/vision.js';
import { spawn } from 'node:child_process';
import { checkRateLimit, getRateLimitStatus, clearRateLimit, RATE_CONFIG } from '../core/rate-limiter.js';
import { createTrace, recordStep, finalizeTrace } from '../trace/index.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  getOrCreateUser,
  getContext,
  appendMessage,
  incrementToolUse,
  trimMessages,
  clearSummary,
  removeLearning,
  listLearnings,
  resetThread,
  createLinkToken,
  consumeLinkToken,
  setBotState,
  getBotState,
  trackChannel,
  getActiveChannels,
  isActiveChannel,
  createReminder,
  listReminders,
  cancelReminder,
  getPreference,
  setPreference,
  getAllPreferences,
  searchMessages,
  exportMessages,
  getUserStats,
  getGlobalStats,
  createWebhook,
  listWebhooks,
  deleteWebhook,
} from '../memory/index.js';
import { getDb } from '../memory/db.js';
import { recordSkillInvocation } from '../memory/index.js';

const tracer = trace.getTracer('claudebot', '2.0.0');
const BOT_NAME = process.env.BOT_NAME ?? 'Claude';
const OWNER_ID = process.env.DISCORD_OWNER_ID ?? '';
const ALLOWED_PROVIDERS = new Set(
  (process.env.ALLOWED_PROVIDERS ?? 'cli,anthropic,openai,gemini').split(',').map((p) => p.trim())
);
const USE_CLI     = ALLOWED_PROVIDERS.has('cli');
const USE_GATEWAY = ALLOWED_PROVIDERS.has('anthropic') || ALLOWED_PROVIDERS.has('openai') || ALLOWED_PROVIDERS.has('gemini');

// Set in start() — allows handleCommand to use the client for broadcast
let _client = null;


// ─── Attachment downloader ────────────────────────────────────────────────────

const ATTACH_DIR = join(tmpdir(), 'claude-bot-attachments');

/**
 * Download Discord attachment to a local temp file so the CLI can read it.
 * Returns the local file path, or null on failure.
 */
async function downloadAttachment(attachment) {
  try {
    mkdirSync(ATTACH_DIR, { recursive: true });
    const safeName = attachment.name.replace(/[^\w.-]/g, '_');
    const dest = join(ATTACH_DIR, `${attachment.id}_${safeName}`);
    const res = await fetch(attachment.url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Convert a collection of Discord attachments into text lines for the prompt.
 *
 * - Audio files: transcribed via Whisper (if OPENAI_API_KEY set)
 * - Image files: described via Claude Haiku vision (if ANTHROPIC_API_KEY set)
 * - Other files: local path passed to the CLI as before
 */
async function attachmentsToText(attachments) {
  const lines = [];
  for (const att of attachments.values()) {
    const ct = att.contentType ?? '';

    // ── Voice / audio ──────────────────────────────────────────────────────────
    if (isAudio(ct, att.name)) {
      const localPath = await downloadAttachment(att);
      if (localPath) {
        const transcript = await transcribeAudio(localPath, att.name);
        if (transcript) {
          lines.push(`[Voice message transcript: "${transcript}"]`);
        } else {
          // Whisper not configured — pass path so CLI can attempt its own handling
          lines.push(
            `[Voice message (audio file): ${localPath} — OPENAI_API_KEY not set, transcription unavailable]`
          );
        }
      } else {
        lines.push(`[Voice message: download failed — ${att.url}]`);
      }
      continue;
    }

    // ── Image ──────────────────────────────────────────────────────────────────
    if (isImage(ct, att.name)) {
      const localPath = await downloadAttachment(att);
      if (localPath) {
        const description = await describeImage(localPath, ct);
        if (description) {
          lines.push(`[Image description: ${description}]\n[Image file path: ${localPath}]`);
        } else {
          // Vision not configured — pass path; Claude CLI may still handle it
          lines.push(
            `[Image attached: ${localPath} (${att.name}, ${ct || 'unknown type'}) — ANTHROPIC_API_KEY not set, pre-analysis unavailable]`
          );
        }
      } else {
        lines.push(`[Image: download failed — ${att.url}]`);
      }
      continue;
    }

    // ── Other files (PDFs, code files, etc.) ──────────────────────────────────
    const localPath = await downloadAttachment(att);
    if (localPath) {
      lines.push(`[Attached file saved locally: ${localPath} (original name: ${att.name}, type: ${ct || 'unknown'})]`);
    } else {
      lines.push(`[Attachment: ${att.name} — ${att.url}]`);
    }
  }
  return lines.join('\n');
}

// ─── Built-in commands ────────────────────────────────────────────────────────

/** Returns true if the message was a built-in command (handled internally). */
async function handleCommand(text, userId, platformId, platform, reply, channelId = null) {
  const lower = text.trim().toLowerCase();

  if (lower.startsWith('/forget ')) {
    const n = parseInt(lower.slice(8).trim(), 10);
    if (!Number.isFinite(n) || n < 1) {
      await reply('Usage: `/forget <n>` — removes last n message pairs');
      return true;
    }
    trimMessages(userId, n * 2); // n pairs = 2n messages
    await reply(`Removed last ${n} message pair(s) from context.`);
    return true;
  }

  if (lower === '/reset-context') {
    await reply('To confirm, run `/reset-context confirm`.');
    return true;
  }

  if (lower === '/reset-context confirm') {
    resetThread(userId, channelId);
    setBotState(`cli_session:${userId}`, '');
    clearRateLimit(userId);
    await reply('Context reset. Starting fresh.');
    return true;
  }

  if (lower === '/learnings') {
    const learnings = listLearnings(userId);
    if (!learnings.length) {
      await reply('No learnings recorded yet.');
    } else {
      const lines = learnings.map((l) => `• \`${l.key}\`: ${l.insight} (confidence: ${l.confidence})`);
      await reply(`**Your learnings:**\n${lines.join('\n')}`);
    }
    return true;
  }

  if (lower.startsWith('/forget-learning ')) {
    const key = text.slice('/forget-learning '.length).trim();
    removeLearning(userId, key);
    await reply(`Removed learning: \`${key}\``);
    return true;
  }

  if (lower === '/clear-summary') {
    clearSummary(userId);
    await reply('Summary cleared. Context will be rebuilt from recent messages.');
    return true;
  }

  if (lower === '/status') {
    const uptimeSec = Math.floor(process.uptime());
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;

    const { messages: hist, summary } = getContext(userId);
    const msgCount = hist.length;
    const cliSessionId = getBotState(`cli_session:${userId}`);

    const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:4242';
    let gatewayStatus = '❓ unknown';
    try {
      const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(2000) });
      gatewayStatus = res.ok ? '✅ healthy' : `⚠️ ${res.status}`;
    } catch {
      gatewayStatus = '❌ unreachable';
    }

    const providers = [];
    if (USE_CLI)     providers.push('CLI');
    if (USE_GATEWAY) providers.push('gateway');

    const isOwner = OWNER_ID && platformId === OWNER_ID;
    const userMax = parseInt(getPreference(userId, 'rate_limit') ?? RATE_CONFIG.DEFAULT_MAX, 10);
    const rlStatus = isOwner ? null : getRateLimitStatus(userId, userMax);

    const lines = [
      `**Bot Status**`,
      `⏱ Uptime: ${uptimeStr}`,
      `🤖 Providers: ${providers.join(', ') || 'none'}`,
      `🌐 Gateway: ${gatewayStatus}`,
      `💬 Your context: ${msgCount} message${msgCount !== 1 ? 's' : ''}${summary ? ' + summary' : ''}`,
      cliSessionId ? `🔗 CLI session: \`${cliSessionId.slice(0, 8)}…\`` : `🔗 CLI session: none`,
      isOwner
        ? `🚦 Rate limit: exempt (owner)`
        : `🚦 Rate limit: ${rlStatus.used}/${rlStatus.max} messages used in last ${rlStatus.windowSec}s window`,
    ];

    if (isOwner) {
      try {
        const { getLastBackupInfo } = await import('../backup/index.js');
        const backup = getLastBackupInfo();
        if (backup) {
          const ago = _timeAgo(Date.now() - backup.ts);
          lines.push(`💾 Last backup: ${ago} ago${backup.exists ? '' : ' *(file missing)*'}`);
        } else {
          lines.push(`💾 Last backup: none yet`);
        }
      } catch {}
    }

    await reply(lines.join('\n'));
    return true;
  }

  if (lower.startsWith('/approve-skill ')) {
    const skillId = text.slice('/approve-skill '.length).trim();
    const { approveSkill } = await import('../dreaming/index.js').catch(() => ({}));
    if (!approveSkill) { await reply('Dreaming module not available.'); return true; }
    const result = await approveSkill(skillId);
    await reply(result.ok ? `✅ Skill approved.` : `Error: ${result.error}`);
    return true;
  }

  if (lower.startsWith('/reject-skill ')) {
    const skillId = text.slice('/reject-skill '.length).trim();
    const { rejectSkill } = await import('../dreaming/index.js').catch(() => ({}));
    if (!rejectSkill) { await reply('Dreaming module not available.'); return true; }
    rejectSkill(skillId);
    await reply('Skill rejected.');
    return true;
  }

  if (lower === '/link') {
    const token = createLinkToken(userId, platform);
    await reply(`Your link token: **\`${token}\`** (expires in 10 min)\nSend \`/link ${token}\` from your other platform.`);
    return true;
  }

  if (lower.startsWith('/link ') && lower.length === '/link '.length + 6) {
    const token = text.slice('/link '.length).trim().toUpperCase();
    const result = consumeLinkToken(token, platform, userId);
    if (result.ok) {
      await reply('Platforms linked! Your conversation history is now shared across both.');
    } else {
      await reply(`Link failed: ${result.error}`);
    }
    return true;
  }

  if (lower === '/stats' || lower === '/stats global') {
    const isOwner = OWNER_ID && platformId === OWNER_ID;
    const wantsGlobal = lower === '/stats global';

    if (wantsGlobal && !isOwner) {
      await reply('⛔ Global stats are only available to the bot owner.');
      return true;
    }

    if (wantsGlobal) {
      const g = getGlobalStats();
      const uptimeSec = Math.floor(process.uptime());
      const h = Math.floor(uptimeSec / 3600), m = Math.floor((uptimeSec % 3600) / 60), s = uptimeSec % 60;
      const uptimeStr = h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;

      const lines = [
        `**📊 Global Stats**`,
        ``,
        `👥 **Users:** ${g.totalUsers.toLocaleString()} total`,
        `   Active last 7d: ${g.active7} · last 30d: ${g.active30}`,
        `💬 **Messages:** ${g.totalMessages.toLocaleString()} total`,
        `🛠 **Tool uses:** ${Number(g.totalToolUses).toLocaleString()}`,
        `🔔 **Reminders:** ${g.activeReminders} active / ${g.totalReminders} total`,
        `⏱ **Uptime:** ${uptimeStr}`,
      ];

      if (g.topUsers.length) {
        lines.push(``, `**Top users (by messages):**`);
        g.topUsers.forEach((u, i) => {
          lines.push(`  ${i + 1}. \`${u.user_id.slice(0, 8)}…\` — ${u.n.toLocaleString()} msgs`);
        });
      }

      await reply(lines.join('\n'));
      return true;
    }

    // Personal stats
    const s = getUserStats(userId);
    const tz = getPreference(userId, 'timezone') ?? 'UTC';

    const firstSeen = s.firstTs
      ? new Date(s.firstTs).toLocaleDateString('en-US', { timeZone: tz, dateStyle: 'medium' })
      : 'N/A';
    const lastSeen = s.lastTs
      ? new Date(s.lastTs).toLocaleDateString('en-US', { timeZone: tz, dateStyle: 'medium' })
      : 'N/A';

    const avgPerDay = s.activeDays > 0
      ? (s.userMsgs / s.activeDays).toFixed(1)
      : '0';

    const userMax = parseInt(getPreference(userId, 'rate_limit') ?? RATE_CONFIG.DEFAULT_MAX, 10);
    const rl = isOwner ? null : getRateLimitStatus(userId, userMax);

    const lines = [
      `**📊 Your Stats**`,
      ``,
      `💬 **Messages sent:** ${s.userMsgs.toLocaleString()} (${s.week7} this week · ${s.week30} this month)`,
      `🤖 **Bot replies:** ${s.botMsgs.toLocaleString()}`,
      `🛠 **Tool uses triggered:** ${s.toolUseTotal.toLocaleString()}`,
      `📅 **Active days:** ${s.activeDays} · avg ${avgPerDay} msgs/day`,
      `📆 **First message:** ${firstSeen}`,
      `🔔 **Active reminders:** ${s.activeReminders}`,
      isOwner
        ? `🚦 **Rate limit:** exempt (owner)`
        : `🚦 **Rate limit:** ${rl.used}/${rl.max} used this window`,
    ];

    await reply(lines.join('\n'));
    return true;
  }

  if (lower === '/export' || lower === '/export json' || lower === '/export md' || lower === '/export markdown') {
    const fmt = lower.includes('json') ? 'json' : 'md';
    const rows = exportMessages(userId);

    if (!rows.length) {
      await reply('No conversation history to export yet.');
      return true;
    }

    const tz = getPreference(userId, 'timezone') ?? 'UTC';
    const exportedAt = new Date().toLocaleString('en-US', {
      timeZone: tz, dateStyle: 'long', timeStyle: 'short',
    });

    let fileContent, fileName;

    if (fmt === 'json') {
      fileContent = JSON.stringify({
        exportedAt: new Date().toISOString(),
        timezone: tz,
        totalMessages: rows.length,
        messages: rows.map((r) => ({
          role: r.role,
          platform: r.platform,
          timestamp: new Date(r.ts).toISOString(),
          content: r.content,
        })),
      }, null, 2);
      fileName = `conversation-${Date.now()}.json`;
    } else {
      const header = [
        `# Conversation Export`,
        `**Exported:** ${exportedAt}${tz !== 'UTC' ? ` (${tz})` : ''}`,
        `**Total messages:** ${rows.length}`,
        `\n---\n`,
      ].join('\n');

      const body = rows.map((r) => {
        const when = new Date(r.ts).toLocaleString('en-US', {
          timeZone: tz, dateStyle: 'medium', timeStyle: 'short',
        });
        const speaker = r.role === 'user' ? '### 🧑 You' : `### 🤖 ${BOT_NAME}`;
        const platform = r.platform ? ` *(${r.platform})*` : '';
        return `${speaker}${platform} — ${when}\n\n${r.content}`;
      }).join('\n\n---\n\n');

      fileContent = header + body;
      fileName = `conversation-${Date.now()}.md`;
    }

    const tmpPath = join(tmpdir(), fileName);
    try {
      writeFileSync(tmpPath, fileContent, 'utf8');
      await reply({
        content: `📄 Your conversation export — ${rows.length} messages (${fmt.toUpperCase()})`,
        files: [new AttachmentBuilder(tmpPath, { name: fileName })],
      });
    } finally {
      unlinkSync(tmpPath);
    }
    return true;
  }

  if (lower === '/pins') {
    const pins = getPreference(userId, 'pins') ?? {};
    const entries = Object.entries(pins);
    if (!entries.length) {
      await reply('No pinned notes. Add one with `/pin <key> <content>`.');
      return true;
    }
    const lines = entries.map(([k, v]) => `• **${k}**: ${v}`);
    await reply(`**📌 Pinned notes (${entries.length}):**\n${lines.join('\n')}`);
    return true;
  }

  if (lower.startsWith('/pin ')) {
    const rest = text.slice('/pin '.length).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      await reply('Usage: `/pin <key> <content>` — e.g. `/pin role Senior backend engineer at Acme Corp`');
      return true;
    }
    const key = rest.slice(0, spaceIdx).trim().toLowerCase();
    const content = rest.slice(spaceIdx + 1).trim();
    if (!key || !content) {
      await reply('Both key and content are required.');
      return true;
    }
    if (key.length > 40) {
      await reply('Key must be 40 characters or fewer.');
      return true;
    }
    const pins = getPreference(userId, 'pins') ?? {};
    const isUpdate = key in pins;
    pins[key] = content;
    setPreference(userId, 'pins', pins);
    await reply(`📌 ${isUpdate ? 'Updated' : 'Pinned'}: **${key}**\n> ${content}`);
    return true;
  }

  if (lower.startsWith('/unpin ')) {
    const key = text.slice('/unpin '.length).trim().toLowerCase();
    const pins = getPreference(userId, 'pins') ?? {};
    if (!(key in pins)) {
      await reply(`No pin found for **${key}**. Use \`/pins\` to list yours.`);
      return true;
    }
    delete pins[key];
    setPreference(userId, 'pins', Object.keys(pins).length ? pins : null);
    await reply(`🗑 Unpinned: **${key}**`);
    return true;
  }

  if (lower.startsWith('/search ')) {
    const raw = text.slice('/search '.length).trim();
    if (!raw) {
      await reply('Usage: `/search <query>` — optionally add `from:me` or `from:bot` to filter by role.');
      return true;
    }

    // Parse optional role filter
    let role = null;
    let query = raw;
    if (/\bfrom:me\b/i.test(raw)) {
      role = 'user';
      query = raw.replace(/\bfrom:me\b/i, '').trim();
    } else if (/\bfrom:bot\b/i.test(raw)) {
      role = 'assistant';
      query = raw.replace(/\bfrom:bot\b/i, '').trim();
    }

    if (!query) {
      await reply('Please provide a search term alongside the filter.');
      return true;
    }

    let results;
    try {
      results = searchMessages(userId, query, { role, limit: 5 });
    } catch (err) {
      await reply(`Search failed: ${err.message.slice(0, 100)}`);
      return true;
    }

    if (!results.length) {
      const roleLabel = role ? ` in your ${role === 'user' ? 'messages' : 'bot responses'}` : '';
      await reply(`No results for **${query}**${roleLabel}.`);
      return true;
    }

    const tz = getPreference(userId, 'timezone') ?? 'UTC';
    const lines = results.map((r, i) => {
      const when = new Date(r.ts).toLocaleString('en-US', {
        timeZone: tz, month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
      });
      const who = r.role === 'user' ? '🧑' : '🤖';
      return `**${i + 1}.** ${who} ${when}\n> ${(r.snippet ?? r.content).slice(0, 200)}`;
    });

    const roleLabel = role ? ` (${role === 'user' ? 'your messages' : 'bot responses'})` : '';
    await sendReply(reply, `**Search: "${query}"**${roleLabel} — ${results.length} result(s)\n\n${lines.join('\n\n')}`);
    return true;
  }

  if (lower === '/preferences') {
    const prefs = getAllPreferences(userId);
    const keys = Object.keys(prefs);
    if (!keys.length) {
      await reply('No preferences set. Use `/set <key> <value>` to configure (e.g. `/set timezone America/New_York`).');
      return true;
    }
    const lines = keys.map((k) => `• **${k}**: ${prefs[k]}`);
    await reply(`**Your preferences:**\n${lines.join('\n')}`);
    return true;
  }

  if (lower.startsWith('/set ')) {
    const parts = text.slice('/set '.length).trim().split(/\s+/);
    const key = parts[0]?.toLowerCase();
    const value = parts.slice(1).join(' ').trim();
    if (!key || !value) {
      await reply('Usage: `/set <key> <value>` — e.g. `/set timezone America/New_York`');
      return true;
    }
    if (key === 'timezone') {
      try {
        Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
      } catch {
        await reply(`❌ Unknown timezone \`${value}\`. Use IANA format, e.g. \`America/New_York\`, \`Europe/London\`, \`Asia/Singapore\`.`);
        return true;
      }
    }
    if (key === 'rate_limit') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1) {
        await reply(`❌ \`rate_limit\` must be a positive number.`);
        return true;
      }
      if (n > RATE_CONFIG.BURST_CAP) {
        await reply(`❌ \`rate_limit\` cannot exceed the server cap of ${RATE_CONFIG.BURST_CAP}.`);
        return true;
      }
    }
    setPreference(userId, key, value);
    await reply(`✅ Set **${key}** = \`${value}\``);
    return true;
  }

  if (lower.startsWith('/unset ')) {
    const key = text.slice('/unset '.length).trim().toLowerCase();
    setPreference(userId, key, null);
    await reply(`Removed preference: **${key}**`);
    return true;
  }

  if (lower === '/reminders') {
    const rows = listReminders(userId);
    if (!rows.length) {
      await reply('No active reminders.');
      return true;
    }
    const tz = getPreference(userId, 'timezone') ?? 'UTC';
    const lines = rows.map((r, i) => {
      let when;
      try {
        when = new Date(r.fire_at).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
        if (tz !== 'UTC') when += ` (${tz})`;
        else when += ' UTC';
      } catch {
        when = new Date(r.fire_at).toISOString();
      }
      const recur = r.recur ? ` *(${r.recur})*` : '';
      return `**${i + 1}.** \`${r.id.slice(0, 8)}\` — ${when}${recur}\n   ${r.message}`;
    });
    await reply(`**Your reminders:**\n${lines.join('\n')}`);
    return true;
  }

  if (lower.startsWith('/cancel-reminder ')) {
    const shortId = text.slice('/cancel-reminder '.length).trim();
    // Match against first 8 chars of UUID
    const rows = listReminders(userId);
    const match = rows.find((r) => r.id.startsWith(shortId) || r.id === shortId);
    if (!match) {
      await reply(`No active reminder found matching \`${shortId}\`. Use \`/reminders\` to list yours.`);
      return true;
    }
    cancelReminder(match.id, userId);
    await reply(`Cancelled reminder: "${match.message.slice(0, 80)}"`);
    return true;
  }

  if (lower.startsWith('/webhook')) {
    const WEBHOOK_BASE = (process.env.WEBHOOK_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');
    const sub = text.slice('/webhook'.length).trim();
    const subLower = sub.toLowerCase();

    if (subLower === 'list' || subLower === '') {
      const hooks = listWebhooks(userId);
      if (!hooks.length) {
        await reply('No webhooks configured. Create one with `/webhook create <name>`.');
        return true;
      }
      const lines = hooks.map((h) => {
        const created = new Date(h.created_at).toLocaleDateString('en-US', { dateStyle: 'medium' });
        const lastUsed = h.last_used
          ? new Date(h.last_used).toLocaleDateString('en-US', { dateStyle: 'medium' })
          : 'never';
        return `• **${h.name}** — created ${created}, last used ${lastUsed}\n  URL: \`${WEBHOOK_BASE}/hook/${h.id}\``;
      });
      await reply(`**Your webhooks:**\n${lines.join('\n')}`);
      return true;
    }

    if (subLower.startsWith('create ')) {
      const name = sub.slice('create '.length).trim();
      if (!name || name.length > 40) {
        await reply('Webhook name must be 1–40 characters.');
        return true;
      }
      const result = createWebhook(userId, name);
      if (!result.ok) {
        await reply(`❌ ${result.error}`);
        return true;
      }
      const url = `${WEBHOOK_BASE}/hook/${result.id}`;
      await reply(
        `✅ Webhook **${name}** created!\n\n` +
        `**URL:** \`${url}\`\n` +
        `**Token:** \`${result.token}\`\n\n` +
        `Send a POST request:\n` +
        `\`\`\`\ncurl -X POST ${url} \\\n` +
        `  -H "Authorization: Bearer ${result.token}" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -d '{"title":"Alert","message":"Something happened!"}'\n\`\`\``
      );
      return true;
    }

    if (subLower.startsWith('delete ')) {
      const name = sub.slice('delete '.length).trim();
      const deleted = deleteWebhook(userId, name);
      if (deleted) {
        await reply(`Webhook **${name}** deleted.`);
      } else {
        await reply(`No active webhook named **${name}** found.`);
      }
      return true;
    }

    await reply(
      '**Webhook commands:**\n' +
      '• `/webhook create <name>` — create a new webhook\n' +
      '• `/webhook list` — show your webhooks\n' +
      '• `/webhook delete <name>` — remove a webhook'
    );
    return true;
  }

  if (lower === '/backup') {
    if (!OWNER_ID || platformId !== OWNER_ID) {
      await reply('⛔ Only the bot owner can trigger backups.');
      return true;
    }
    await reply('💾 Running backup…');
    try {
      const { runBackup, listBackups } = await import('../backup/index.js');
      const result = await runBackup();
      if (result.ok) {
        const backups = listBackups();
        const sizeKB = (result.sizeBytes / 1024).toFixed(1);
        await reply(`✅ Backup complete: \`${result.path}\` (${sizeKB}KB, ${result.durationMs}ms)\n${backups.length} backup(s) stored.`);
      } else {
        await reply(`❌ Backup failed: ${result.error}`);
      }
    } catch (err) {
      await reply(`❌ Backup error: ${err.message}`);
    }
    return true;
  }

  if (lower.startsWith('/broadcast')) {
    if (!OWNER_ID || platformId !== OWNER_ID) {
      await reply('⛔ Only the bot owner can broadcast.');
      return true;
    }

    // Parse mode: "/broadcast dm <msg>" or "/broadcast <msg>"
    let mode = 'channels';
    let message = text.slice('/broadcast'.length).trim();
    if (message.toLowerCase().startsWith('dm ')) {
      mode = 'dm';
      message = message.slice(3).trim();
    } else if (message.toLowerCase().startsWith('channel ') || message.toLowerCase().startsWith('channels ')) {
      message = message.replace(/^channels?\s+/i, '').trim();
    }

    if (!message) {
      await reply('Usage: `/broadcast <message>` or `/broadcast dm <message>`');
      return true;
    }

    if (!_client) {
      await reply('Discord client not ready.');
      return true;
    }

    const tag = `📣 **Broadcast from owner:**\n${message}`;
    let sent = 0, failed = 0;

    if (mode === 'channels') {
      const channels = getActiveChannels('discord');
      await reply(`Broadcasting to ${channels.length} channel(s)…`);
      for (const { channel_id } of channels) {
        try {
          const ch = await _client.channels.fetch(channel_id).catch(() => null);
          if (ch?.isTextBased()) { await ch.send(tag); sent++; }
          else failed++;
        } catch { failed++; }
      }
      await reply(`📣 Done: ${sent} delivered, ${failed} failed.`);

    } else {
      // DM all users with a known Discord platform_id
      const rows = getDb().prepare(
        "SELECT DISTINCT platform_id FROM platform_ids WHERE platform = 'discord'"
      ).all();
      await reply(`Broadcasting DMs to ${rows.length} user(s)…`);
      for (const { platform_id } of rows) {
        try {
          const user = await _client.users.fetch(platform_id).catch(() => null);
          if (user) { await user.send(tag); sent++; }
          else failed++;
        } catch { failed++; }
      }
      await reply(`📣 Done: ${sent} delivered, ${failed} failed.`);
    }
    return true;
  }

  if (lower === '/restart') {
    if (!OWNER_ID || platformId !== OWNER_ID) {
      await reply('⛔ Only the bot owner can restart.');
      return true;
    }
    await reply('🔄 Restarting bot… be back in a few seconds.');
    // Spawn a detached shell that waits 2s (for this process to exit) then restarts
    const child = spawn(
      'bash',
      ['-c', `sleep 2 && node src/index.js >> data/bot.log 2>&1`],
      { detached: true, stdio: 'ignore', cwd: process.cwd() }
    );
    child.unref();
    setTimeout(() => process.exit(0), 800);
    return true;
  }

  return false; // not a built-in command
}

// ─── Message pipeline ─────────────────────────────────────────────────────────

async function handleMessage(text, platformId, platform, reply, sendTyping, { skipCommands = false, channelId = null, messageId = null, channelName = null } = {}) {
  return tracer.startActiveSpan('bot.message.receive', async (span) => {
    span.setAttribute('platform', platform);

    // Create a pipeline trace for the dashboard
    const traceId = createTrace({ platform, userId: platformId, preview: text, channelId, messageId });

    try {
      // ── Step 1: Identity ──────────────────────────────────────────────────────
      const t0 = Date.now();
      const userId = getOrCreateUser(platform, platformId);
      recordStep(traceId, 'identity', {
        status: 'ok', durationMs: Date.now() - t0,
        meta: { userId, platformId, platform, messageId, channelId },
      });

      // ── Step 2: Command check ────────────────────────────────────────────────
      if (!skipCommands) {
        const t1 = Date.now();
        const handled = await handleCommand(text, userId, platformId, platform, reply, channelId);
        recordStep(traceId, 'command_check', {
          status: handled ? 'skip' : 'ok', durationMs: Date.now() - t1,
          meta: { handled, cmd: handled ? text.slice(0, 60) : null },
        });
        if (handled) {
          finalizeTrace(traceId, { status: 'command' });
          span.end();
          return;
        }
      }

      // ── Step 3: Rate limit ───────────────────────────────────────────────────
      const isOwner = OWNER_ID && platformId === OWNER_ID;
      {
        const t2 = Date.now();
        const userMax = parseInt(getPreference(userId, 'rate_limit') ?? RATE_CONFIG.DEFAULT_MAX, 10);
        let rlResult = { allowed: true, reason: 'exempt' };
        if (!isOwner) {
          rlResult = checkRateLimit(userId, userMax);
        }
        const rlStatus = (!isOwner) ? getRateLimitStatus(userId, userMax) : null;
        recordStep(traceId, 'rate_limit', {
          status: rlResult.allowed ? 'ok' : 'block', durationMs: Date.now() - t2,
          meta: {
            allowed: rlResult.allowed,
            reason: rlResult.reason,
            owner: isOwner,
            used: rlStatus?.used ?? 0,
            max: userMax,
            windowSec: Math.round(RATE_CONFIG.WINDOW_MS / 1000),
            retryAfterMs: rlResult.retryAfterMs ?? null,
          },
        });
        if (!rlResult.allowed) {
          const waitSec = Math.ceil(rlResult.retryAfterMs / 1000);
          const msg = rlResult.reason === 'cooldown'
            ? `⏱ Too fast — please wait ${waitSec}s before sending another message.`
            : `⏱ Rate limit reached (${userMax} messages / ${RATE_CONFIG.WINDOW_MS / 1000}s). Try again in ${waitSec}s.`;
          await reply(msg).catch(() => {});
          span.setAttribute('rate_limited', true);
          finalizeTrace(traceId, { status: 'rate_limited' });
          span.end();
          return;
        }
      }

      // ── Step 4: Context fetch ────────────────────────────────────────────────
      const t3 = Date.now();
      const { messages: history, summary, learnings } = getContext(userId, channelId);
      const timezone = getPreference(userId, 'timezone') ?? 'UTC';
      const pins     = getPreference(userId, 'pins') ?? {};
      recordStep(traceId, 'context_fetch', {
        status: 'ok', durationMs: Date.now() - t3,
        meta: {
          historyLen: history.length,
          hasSummary: !!summary,
          summarySnippet: summary ? summary.slice(0, 200) : null,
          learningsCount: learnings?.length ?? 0,
          learningsList: learnings?.length ? learnings.map(l => `${l.key}: ${l.insight}`).join(' | ') : null,
          timezone,
          pinsCount: Object.keys(pins).length,
          pinKeys: Object.keys(pins).join(', ') || null,
          // Full history for dashboard drill-down (truncate each message to 1000 chars)
          history: history.map(m => ({ role: m.role, content: m.content?.slice(0, 1000) ?? '' })),
        },
      });

      await sendTyping();

      // ── Step 4b: Intent routing (skill dispatch / reminder) ──────────────────
      // Only runs when gateway is available — falls through to AI call otherwise.
      let _routedSkill = null;
      if (USE_GATEWAY) {
        try {
          const { classifyIntent } = await import('../router/index.js');
          const intent = await classifyIntent(text, history.slice(-3));

          if (intent.intent === 'reminder') {
            const fireAt = Date.parse(intent.fire_at);
            if (Number.isFinite(fireAt) && fireAt > Date.now()) {
              createReminder(userId, {
                message: intent.message,
                fireAt,
                platform: 'discord',
                channelId: reply._msg?.channel?.id ?? null,
                recur: null,
              });
              responseText = `🔔 Reminder set for ${new Date(fireAt).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' })}: "${intent.message}"`;
              await sendReply(reply, responseText);
              appendMessage(userId, { role: 'user', content: text, platform, channelId });
              appendMessage(userId, { role: 'assistant', content: responseText, platform, channelId });
              recordStep(traceId, 'ai_call', { status: 'ok', durationMs: 0, meta: { provider: 'router:reminder' } });
              recordStep(traceId, 'tag_extraction', { status: 'ok', durationMs: 0, meta: {} });
              recordStep(traceId, 'delivery', { status: 'ok', durationMs: 0, meta: { chars: responseText.length } });
              recordStep(traceId, 'memory_persist', { status: 'ok', durationMs: 0, meta: {} });
              finalizeTrace(traceId, { status: 'ok' });
              span.end();
              return;
            }
          }

          if (intent.intent === 'skill_dispatch' && intent.skill) {
            _routedSkill = intent.skill;
          }
        } catch {
          // Router unavailable — fall through to normal AI call
        }
      }

      // ── Step 5: AI call ──────────────────────────────────────────────────────
      const { callGateway, callClaudeCLI } = await import('../core/claude.js');
      const system = buildSystem(summary, learnings, timezone, pins);
      const msgs = [...history, { role: 'user', content: text }];
      let responseText;
      let toolUseCount = 0;
      let provider = 'none';

      const typingInterval = setInterval(() => sendTyping().catch(() => {}), 8000);

      const t4 = Date.now();
      try {
        if (USE_CLI) {
          provider = 'cli';
          let liveMsg = null;
          let accumulated = '';
          let lastEdit = 0;
          let hasContent = false;

          const cliSessionKey = `cli_session:${userId}`;
          const savedSessionId = getBotState(cliSessionKey) || undefined;

          const result = await callClaudeCLI({
            messages: msgs,
            system,
            sessionId: savedSessionId,
            onChunk: async (chunk) => {
              accumulated += chunk;
              hasContent = true;
              const now = Date.now();
              if (now - lastEdit > 1200) {
                lastEdit = now;
                const preview = accumulated.slice(-1900) + '▌';
                try {
                  if (!liveMsg) liveMsg = await reply(preview);
                  else await liveMsg.edit(preview);
                } catch {}
              }
            },
            onHeartbeat: async (idleMs) => {
              if (hasContent) return;
              const secs = Math.round(idleMs / 1000);
              const indicator = `⏳ Still working… (${secs}s)`;
              try {
                if (!liveMsg) liveMsg = await reply(indicator);
                else await liveMsg.edit(indicator);
              } catch {}
            },
          });

          if (result.sessionId) setBotState(cliSessionKey, result.sessionId);

          // ── Step 6: Tag extraction ─────────────────────────────────────────────
          const t5 = Date.now();
          const reactEmojis = [];
          const filePaths = [];
          const reminderTags = [];
          const cleanText = result.text
            .replace(/\[REACT:([^\]]+)\]/g, (_, e) => { reactEmojis.push(e.trim()); return ''; })
            .replace(/\[FILE:([^\]]+)\]/g,  (_, p) => { filePaths.push(p.trim());  return ''; })
            .replace(/\[REMINDER:([^:\]]+):([^:\]]+):([^\]]+)\]/g, (_, ts, recur, msg) => {
              reminderTags.push({ ts: ts.trim(), recur: recur.trim(), msg: msg.trim() });
              return '';
            })
            .replace(/\[REMINDER:([^:\]]+):([^\]]+)\]/g, (_, ts, msg) => {
              reminderTags.push({ ts: ts.trim(), recur: 'none', msg: msg.trim() });
              return '';
            })
            .trim();
          recordStep(traceId, 'tag_extraction', {
            status: 'ok', durationMs: Date.now() - t5,
            meta: {
              reactionsCount: reactEmojis.length,
              reactions: reactEmojis.join(', ') || null,
              filesCount: filePaths.length,
              files: filePaths.join(', ') || null,
              remindersCount: reminderTags.length,
              reminders: reminderTags.length ? reminderTags.map(r => `${r.ts} (${r.recur}): ${r.msg}`).join(' | ') : null,
            },
          });

          // ── Step 7: Delivery ───────────────────────────────────────────────────
          const t6 = Date.now();
          // Split files: oversized → Google Drive link, rest → Discord attachment
          const driveLinks = [];
          const discordFiles = [];
          for (const p of filePaths.filter((p) => existsSync(p))) {
            if (isOversized(p) && hasGDriveAuth(userId)) {
              try {
                const link = await uploadToDrive(userId, p, channelName);
                driveLinks.push(`📎 [${basename(p)}](${link}) *(uploaded to your Google Drive)*`);
              } catch (err) {
                console.error('[gdrive] upload failed:', err.message);
                discordFiles.push(new AttachmentBuilder(p, { name: basename(p) }));
              }
            } else if (isOversized(p)) {
              // No Drive auth — warn the user
              driveLinks.push(`⚠️ \`${basename(p)}\` is over 25 MB. Run \`/auth_gdrive\` to connect your Google Drive for large file uploads.`);
            } else {
              discordFiles.push(new AttachmentBuilder(p, { name: basename(p) }));
            }
          }
          const attachments = discordFiles;
          const driveText = driveLinks.length ? '\n' + driveLinks.join('\n') : '';
          const fullText = (cleanText || '') + driveText;

          if (attachments.length) {
            if (liveMsg) await liveMsg.delete().catch(() => {});
            await reply({ content: fullText || null, files: attachments });
          } else if (fullText) {
            if (liveMsg) {
              if (fullText.length <= 2000) await liveMsg.edit(fullText).catch(() => {});
              else { await liveMsg.delete().catch(() => {}); await sendReply(reply, fullText); }
            } else {
              await sendReply(reply, fullText);
            }
          } else if (liveMsg) {
            await liveMsg.delete().catch(() => {});
          }

          for (const emoji of reactEmojis) await reactToMessage(reply, emoji);
          recordStep(traceId, 'delivery', {
            status: 'ok', durationMs: Date.now() - t6,
            meta: { chars: cleanText?.length ?? 0, filesCount: attachments.length, reactionsCount: reactEmojis.length },
          });

          // Schedule reminders
          for (const { ts, msg, recur } of reminderTags) {
            const fireAt = new Date(ts).getTime();
            if (!isNaN(fireAt) && fireAt > Date.now()) {
              try {
                const recurValue = ['hourly', 'daily', 'weekly', 'monthly'].includes(recur) ? recur : null;
                createReminder(userId, {
                  message: msg,
                  fireAt,
                  platform: 'discord',
                  channelId: reply._msg?.channel?.id ?? null,
                  recur: recurValue,
                });
                const recurLabel = recurValue ? ` (${recurValue})` : '';
                console.log(`[Discord] reminder scheduled${recurLabel}: "${msg.slice(0, 60)}" at ${new Date(fireAt).toISOString()}`);
              } catch (err) {
                console.warn('[Discord] Failed to schedule reminder:', err.message);
              }
            }
          }

          responseText = cleanText;

        } else if (USE_GATEWAY) {
          provider = _routedSkill ? `skill:${_routedSkill}` : 'gateway';
          let result;
          if (_routedSkill) {
            const { runSkill } = await import('../skills/runner.js');
            result = await runSkill(_routedSkill, { messages: msgs, summary, learnings, userId });
            recordSkillInvocation(userId, _routedSkill);
          } else {
            result = await callGateway({ messages: msgs, system });
          }
          responseText = result.text;
          toolUseCount = result.toolUseCount;

          // Tag extraction (gateway path — minimal tags expected)
          recordStep(traceId, 'tag_extraction', { status: 'ok', durationMs: 0, meta: {} });

          // Delivery
          const t6 = Date.now();
          await sendReply(reply, responseText);
          recordStep(traceId, 'delivery', {
            status: 'ok', durationMs: Date.now() - t6,
            meta: { chars: responseText?.length ?? 0 },
          });

        } else {
          await reply('No providers configured. Set ALLOWED_PROVIDERS in .env.');
          return;
        }
      } catch (err) {
        if (USE_GATEWAY && USE_CLI) {
          provider = 'gateway-fallback';
          const result = await callGateway({ messages: msgs, system });
          responseText = result.text;
          toolUseCount = result.toolUseCount;
          recordStep(traceId, 'tag_extraction', { status: 'ok', durationMs: 0, meta: {} });
          const t6 = Date.now();
          await sendReply(reply, responseText);
          recordStep(traceId, 'delivery', {
            status: 'ok', durationMs: Date.now() - t6,
            meta: { chars: responseText?.length ?? 0, fallback: true },
          });
        } else {
          throw err;
        }
      } finally {
        clearInterval(typingInterval);
      }

      recordStep(traceId, 'ai_call', {
        status: 'ok', durationMs: Date.now() - t4,
        meta: {
          provider,
          toolUseCount,
          responseLen: responseText?.length ?? 0,
          request: text.slice(0, 500),
          response: (responseText ?? '').slice(0, 500),
          sessionId: getBotState(`cli_session:${userId}`) || null,
        },
      });

      // ── Step 8: Memory persist ───────────────────────────────────────────────
      const t7 = Date.now();
      appendMessage(userId, { role: 'user', content: text, platform, channelId });
      appendMessage(userId, { role: 'assistant', content: responseText, platform, channelId });
      if (toolUseCount) incrementToolUse(userId, toolUseCount, channelId);
      recordStep(traceId, 'memory_persist', {
        status: 'ok', durationMs: Date.now() - t7,
        meta: {
          userMsgLen: text.length,
          assistantMsgLen: responseText?.length ?? 0,
          toolUseCount,
          historyLenAfter: history.length + 2,
        },
      });

      finalizeTrace(traceId, { status: 'ok' });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      finalizeTrace(traceId, { status: 'error', error: err.message });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (err.code === 'GATEWAY_RATE_LIMITED') {
        await reply(`⏳ Quota exhausted across all providers (Anthropic quota shared with your active Claude Code sessions). Try again in ${err.retryAfter}s or when your other sessions are idle.`).catch(() => {});
      } else {
        await reply(`Sorry, something went wrong: ${err.message.slice(0, 200)}`).catch(() => {});
      }
    } finally {
      span.end();
    }
  });
}

function buildSystem(summary, learnings, timezone = 'UTC', pins = {}) {
  const nowLocal = new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
  const tzLabel = timezone === 'UTC' ? 'UTC' : `${timezone} (currently ${nowLocal})`;
  const parts = [
    `You are ${BOT_NAME}, a helpful AI assistant integrated into Discord. Be concise and friendly.`,
    `You have full permission to read files, edit files, run commands, and take any action needed. Never ask the user for permission or confirmation before acting — just do it and report what you did.`,
    `When you need to edit any file — including files under ~/.claude/, ~/.claude/skills/, or any system/config directory — use shell commands (bash, sed, python3, etc.) to modify them directly. Do NOT tell the user to run commands themselves. Do NOT say a directory is "protected" or requires manual steps. Just run the shell command and do it.`,
    `To react to the user's message with an emoji, include [REACT:emoji] in your response (e.g. [REACT:👍]). Use this sparingly — only when a reaction genuinely adds meaning (e.g. [REACT:✅] after completing a task, [REACT:👀] when you start a long job). Do NOT react to every message. Never react just to seem friendly.`,
    `To send a file as a Discord attachment, include [FILE:/absolute/path/to/file] in your response (e.g. [FILE:C:/Users/Admin/WorkPlace/resume-agent/output/resume.pdf]). The file will be uploaded directly to the chat. Files over 25 MB are automatically uploaded to the user's Google Drive (if they have connected it via /auth_gdrive) and sent as a shareable link. Use [FILE:] whenever you generate or compile a document, PDF, APK, resume, report, or any file the user should download — do NOT paste the file contents as text.`,
    `The user's timezone is ${tzLabel}. When they say "tomorrow 9am" or "Friday at 3pm", interpret it in their timezone and convert to UTC for reminder tags. To set a reminder, include [REMINDER:timestamp:recur:message] in your response — timestamp must be ISO 8601 UTC. recur must be one of: none, hourly, daily, weekly, monthly. Examples: [REMINDER:2026-05-20T10:00:00Z:none:Call John] for a one-off, [REMINDER:2026-05-19T09:00:00Z:daily:Stand-up meeting] for daily. Only set reminders when the user explicitly asks. They can list with /reminders and cancel with /cancel-reminder <id>.`,
    `The user can receive a daily digest DM with upcoming reminders. To enable it, they use /set digest_time HH:MM (24h format, e.g. /set digest_time 08:30) along with /set timezone. If they ask to "send me a morning briefing" or similar, guide them to set these two preferences.`,
    `In Discord server channels, conversations automatically start in a new thread to keep channels clean. Users can disable this with /set auto_thread false. If a user asks to stop using threads, tell them to run that command.`,
    `When the user sends a voice message, it is automatically transcribed and injected as [Voice message transcript: "..."]. Treat it exactly as if the user typed that text.`,
    `When the user sends an image, it is automatically analysed and injected as [Image description: ...] followed by [Image file path: ...]. Use the description to answer questions about the image. If you need to inspect the raw file (e.g. to extract data), read it via the file path.`,
  ];
  const pinEntries = Object.entries(pins);
  if (pinEntries.length) {
    const pinLines = pinEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n');
    parts.push(`Always keep in mind (user-pinned notes):\n${pinLines}`);
  }
  if (summary) parts.push(`Conversation summary: ${summary}`);
  if (learnings?.length) {
    parts.push(`User insights: ${learnings.map((l) => `${l.key}: ${l.insight}`).join('; ')}`);
  }
  return parts.join('\n');
}

/**
 * React to the original message with an emoji.
 * `reply` is the Discord reply function — we abuse its closure to get the message.
 * We store the original message on the reply function via a _msg property set at call site.
 */
async function reactToMessage(reply, emoji) {
  try {
    if (reply._msg) await reply._msg.react(emoji);
  } catch (err) {
    console.warn(`[Discord] react failed (${emoji}):`, err.message);
  }
}

function _timeAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function sendReply(reply, text) {
  // Discord message limit is 2000 chars
  if (text.length <= 2000) {
    await reply(text);
  } else {
    for (let i = 0; i < text.length; i += 1900) {
      await reply(text.slice(i, i + 1900));
    }
  }
}

// ─── Catch-up on missed messages ─────────────────────────────────────────────

/** Convert a JS timestamp (ms) to a Discord snowflake string for use as `after:` cursor. */
function timestampToSnowflake(ms) {
  return String((BigInt(ms - 1420070400000) << 22n));
}

/**
 * On startup, scan all known active channels for messages sent while the bot
 * was offline and process the last unanswered one per channel.
 */
async function catchUpMissedMessages(client) {
  const lastOnline = getBotState('lastOnline');
  if (!lastOnline) return; // first boot — nothing to catch up

  const since = parseInt(lastOnline, 10);
  const afterSnowflake = timestampToSnowflake(since);
  const channels = getActiveChannels('discord');

  console.log(`[Discord] catch-up: scanning ${channels.length} channel(s) for messages since ${new Date(since).toISOString()}`);

  for (const { channel_id } of channels) {
    try {
      const channel = await client.channels.fetch(channel_id).catch(() => null);
      if (!channel) continue;

      const fetched = await channel.messages.fetch({ after: afterSnowflake, limit: 50 });
      if (!fetched.size) continue;

      // Sort oldest → newest
      const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      // Clean up orphaned "Still working…" messages left by a previous crashed session
      for (const m of sorted) {
        if (m.author.id === client.user.id && m.content.includes('Still working…')) {
          await m.delete().catch(() => {});
          console.log(`[Discord] catch-up: deleted orphaned "Still working…" in ${channel_id}`);
        }
      }

      // Find messages directed at the bot (DM or mention) OR any message in active threads
      const isDM = channel.type === 1;
      const isThread = channel.isThread?.() ?? false;
      const directed = sorted.filter((m) =>
        !m.author.bot && (isDM || isThread || m.mentions.has(client.user))
      );
      if (!directed.length) continue;

      const lastDirected = directed[directed.length - 1];

      // Check if bot replied after last directed message — look in fetched window first
      let botRepliedAfter = sorted.some(
        (m) => m.author.id === client.user.id && m.createdTimestamp > lastDirected.createdTimestamp
      );

      // Also fetch a few messages before lastOnline to catch a reply that happened just before shutdown
      if (!botRepliedAfter) {
        const beforeSnowflake = timestampToSnowflake(since + 1); // just after lastOnline
        const recent = await channel.messages.fetch({ before: beforeSnowflake, limit: 5 }).catch(() => null);
        if (recent) {
          botRepliedAfter = recent.some(
            (m) => m.author.id === client.user.id && m.createdTimestamp > lastDirected.createdTimestamp
          );
        }
      }

      if (botRepliedAfter) continue;

      let text = lastDirected.content.replace(/<@!?\d+>/g, '').trim();
      if (lastDirected.attachments.size > 0) {
        const files = await attachmentsToText(lastDirected.attachments);
        text = text ? `${text}\n${files}` : files;
      }
      if (!text) continue;

      console.log(`[Discord] catch-up: answering missed message in channel ${channel_id} from ${lastDirected.author.id}`);

      await handleMessage(
        text,
        lastDirected.author.id,
        'discord',
        (r) => lastDirected.reply(r),
        () => channel.sendTyping(),
        { channelId: channel_id, messageId: lastDirected.id, channelName: channel.name ?? null },
      );
    } catch (err) {
      console.warn(`[Discord] catch-up failed for channel ${channel_id}:`, err.message);
    }
  }
}

// ─── Adapter start ────────────────────────────────────────────────────────────

export function start() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
  _client = client;

  client.once(Events.ClientReady, async (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag}`);
    // Register slash commands
    await registerSlashCommands(token, c.application.id);
    // Small delay to let the gateway fully settle before fetching channel history
    setTimeout(() => catchUpMissedMessages(c).catch((err) => {
      console.warn('[Discord] catch-up error:', err.message);
    }), 3000);
  });

  // Deduplicate: ignore a message ID we're already processing
  const _inFlight = new Set();

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const isMentioned = message.mentions.has(client.user);
    const isDM = message.channel.type === 1;
    const isThread = message.channel.isThread?.() ?? false;
    const botInThread = isThread && isActiveChannel('discord', message.channel.id);
    if (!isMentioned && !isDM && !botInThread) return;

    let text = message.content.replace(/<@!?\d+>/g, '').trim();

    // Download attachments locally so the CLI can read them by file path
    if (message.attachments.size > 0) {
      const files = await attachmentsToText(message.attachments);
      text = text ? `${text}\n${files}` : files;
    }

    if (!text) return;

    // If the user is replying to a specific message, prepend its content as context
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (refMsg && refMsg.content) {
          const refAuthor = refMsg.author.id === client.user.id ? 'you' : refMsg.author.username;
          text = `[Replying to ${refAuthor}: "${refMsg.content.slice(0, 300)}"]\n${text}`;
        }
      } catch {}
    }

    if (_inFlight.has(message.id)) {
      console.warn(`[Discord] duplicate MessageCreate for ${message.id} — skipping`);
      return;
    }
    _inFlight.add(message.id);
    console.log(`[Discord] message ${message.id} from ${message.author.id} — "${text.slice(0, 60)}"`);

    // Track this channel so catch-up knows where to look on next restart
    trackChannel('discord', message.channel.id, message.guild?.id ?? null);
    // Heartbeat: record we were alive at this moment
    setBotState('lastOnline', String(Date.now()));

    // ── Auto-thread: start a thread for guild-channel mentions ────────────────
    let replyFn = (r) => message.reply(r); // default: reply in the channel
    let typingChannel = message.channel;

    // effectiveChannelId: always the Discord channel snowflake — unique for every DM,
    // guild channel, and thread. Updated to thread.id when auto-thread fires so
    // the first exchange is stored under the thread context, not the parent channel.
    let effectiveChannelId = message.channel.id;

    const shouldAutoThread = isMentioned && !isDM && !isThread;
    if (shouldAutoThread) {
      const _userId = getOrCreateUser('discord', message.author.id);
      const autoThreadEnabled = getPreference(_userId, 'auto_thread') !== 'false';

      if (autoThreadEnabled) {
        try {
          const threadTs   = new Date().toISOString().slice(0, 16).replace('T', ' '); // "2026-05-19 14:32"
          const threadBase = text.trim().slice(0, 40)
            || `${message.author.displayName ?? message.author.username}`;
          const threadName = `(${threadTs}) ${threadBase}`;
          const thread = await message.startThread({
            name: threadName,
            autoArchiveDuration: 1440, // 1 day
          });
          trackChannel('discord', thread.id, message.guild?.id ?? null);
          // All replies go into the thread — startThread already anchors it to the
          // original message visually in Discord, no need to also reply in the channel.
          replyFn = (r) => thread.send(r);
          typingChannel = thread;
          // Store context under the thread ID, not the parent channel, so this
          // conversation is isolated from other threads in the same channel.
          effectiveChannelId = thread.id;
          console.log(`[Discord] thread created: ${thread.id} for msg ${message.id}`);
        } catch (err) {
          console.warn(`[Discord] thread creation failed (missing perms?): ${err.message}`);
          // fall back to channel reply — effectiveChannelId stays as parent channel
        }
      }
    }

    let _replyN = 0;
    const trackedReply = (r) => {
      _replyN++;
      const preview = (typeof r === 'string' ? r : r?.content ?? JSON.stringify(r)).slice(0, 80);
      console.log(`[Discord] reply #${_replyN} for msg ${message.id}: "${preview}"`);
      return replyFn(r);
    };
    trackedReply._msg = message;

    try {
      await handleMessage(
        text,
        message.author.id,
        'discord',
        trackedReply,
        () => typingChannel.sendTyping(),
        { channelId: effectiveChannelId, messageId: message.id, channelName: typingChannel.name ?? null },
      );
    } finally {
      _inFlight.delete(message.id);
    }
  });

  // Emoji → natural language mapping for reaction-based responses
  const EMOJI_TEXT = {
    '👍': 'yes', '✅': 'yes', '✔️': 'yes', '☑️': 'yes', '🆗': 'yes', '👌': 'yes',
    '👎': 'no',  '❌': 'no',  '🚫': 'no',  '⛔': 'no',
    '1️⃣': '1',  '2️⃣': '2',  '3️⃣': '3',  '4️⃣': '4',  '5️⃣': '5',
  };

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;

    // Fetch partial reaction/message if needed
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch (err) {
      console.warn('[Discord] Failed to fetch reaction:', err.message);
      return;
    }

    // Only react to reactions on bot's own messages
    if (reaction.message.author?.id !== client.user.id) return;

    // Proactive feedback check — handle 👍/👎 on proactive sends before emoji-to-text routing
    const matched = await proactiveFeedback.handleReaction(reaction.message.id, reaction.emoji.name, user.id);
    if (matched) return;

    const emojiName = reaction.emoji.name;
    const text = EMOJI_TEXT[emojiName];
    if (!text) return; // unmapped emoji — ignore

    const channel = reaction.message.channel;
    const isDM = channel.type === 1;
    const isMentionChannel = !isDM; // in guilds, only respond if original message was a reply to bot

    console.log(`[Discord] reaction "${emojiName}" → "${text}" from ${user.id} on msg ${reaction.message.id}`);

    trackChannel('discord', channel.id, reaction.message.guild?.id ?? null);
    setBotState('lastOnline', String(Date.now()));

    await handleMessage(
      text,
      user.id,
      'discord',
      (r) => reaction.message.reply(r),
      () => channel.sendTyping(),
      { skipCommands: true, messageId: reaction.message.id },
    );
  });

  // ── Slash command interaction handler ────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.type !== InteractionType.ApplicationCommand) return;

    const { commandName, user } = interaction;
    const platformId = user.id;

    // Defer reply immediately — slash commands must be acknowledged within 3s
    await interaction.deferReply({ ephemeral: false }).catch(() => {});

    // Build a reply shim that edits the deferred reply (first call) or follows up
    let replied = false;
    const reply = async (content) => {
      if (!replied) {
        replied = true;
        return interaction.editReply(typeof content === 'string' ? { content } : content);
      }
      return interaction.followUp(typeof content === 'string' ? { content } : content);
    };
    reply._msg = null; // no original message for reactions in slash context

    // Resolve userId for commands that need it
    const userId = getOrCreateUser('discord', platformId);

    // Translate slash command → text and route through existing handlers
    try {
      switch (commandName) {
        case 'status':
          await handleCommand('/status', userId, platformId, 'discord', reply);
          break;

        case 'stats': {
          const sub = interaction.options.getSubcommand(false) ?? 'me';
          await handleCommand(sub === 'global' ? '/stats global' : '/stats', userId, platformId, 'discord', reply);
          break;
        }

        case 'search': {
          const query = interaction.options.getString('query');
          const from  = interaction.options.getString('from');
          const cmd = from ? `/search ${query} from:${from}` : `/search ${query}`;
          await handleCommand(cmd, userId, platformId, 'discord', reply);
          break;
        }

        case 'export': {
          const fmt = interaction.options.getString('format') ?? 'md';
          await handleCommand(`/export ${fmt}`, userId, platformId, 'discord', reply);
          break;
        }

        case 'pin': {
          const key     = interaction.options.getString('key');
          const content = interaction.options.getString('content');
          await handleCommand(`/pin ${key} ${content}`, userId, platformId, 'discord', reply);
          break;
        }

        case 'unpin': {
          const key = interaction.options.getString('key');
          await handleCommand(`/unpin ${key}`, userId, platformId, 'discord', reply);
          break;
        }

        case 'pins':
          await handleCommand('/pins', userId, platformId, 'discord', reply);
          break;

        case 'reminders':
          await handleCommand('/reminders', userId, platformId, 'discord', reply);
          break;

        case 'cancel_reminder': {
          const id = interaction.options.getString('id');
          await handleCommand(`/cancel-reminder ${id}`, userId, platformId, 'discord', reply);
          break;
        }

        case 'set': {
          const key   = interaction.options.getString('key');
          const value = interaction.options.getString('value');
          if (key === 'gdrive_folder') {
            if (!hasGDriveAuth(userId)) {
              await reply('Connect Google Drive first with `/auth_gdrive`, then set your folder.');
            } else {
              try {
                await setUserFolder(userId, value);
                await reply(`✅ Google Drive upload folder set to **${value}**. Files will go to \`${value} / [thread title] / file\`.`);
              } catch (err) {
                await reply(`Failed to set folder: ${err.message.slice(0, 200)}`);
              }
            }
          } else {
            await handleCommand(`/set ${key} ${value}`, userId, platformId, 'discord', reply);
          }
          break;
        }

        case 'preferences':
          await handleCommand('/preferences', userId, platformId, 'discord', reply);
          break;

        case 'forget': {
          const pairs = interaction.options.getInteger('pairs') ?? 1;
          await handleCommand(`/forget ${pairs}`, userId, platformId, 'discord', reply);
          break;
        }

        case 'reset_context':
          await handleCommand('/reset-context confirm', userId, platformId, 'discord', reply, interaction.channelId ?? null);
          break;

        case 'webhook': {
          const sub  = interaction.options.getSubcommand();
          const name = interaction.options.getString('name') ?? '';
          await handleCommand(`/webhook ${sub} ${name}`.trim(), userId, platformId, 'discord', reply);
          break;
        }

        case 'backup':
          await handleCommand('/backup', userId, platformId, 'discord', reply);
          break;

        case 'auth_gdrive': {
          if (!process.env.GDRIVE_CLIENT_ID) {
            await reply('Google Drive integration is not configured on this bot.');
            break;
          }
          const url = getAuthUrl(userId);
          const already = hasGDriveAuth(userId);
          await reply(
            already
              ? `Your Google Drive is already connected. [Re-authorise](${url}) if you want to switch accounts.`
              : `[Click here to connect your Google Drive](${url})\n\nOnce authorised, files over 25 MB will be uploaded to your Drive and shared as a link.`
          );
          break;
        }

        default:
          await reply(`Unknown command \`${commandName}\`.`);
      }
    } catch (err) {
      await reply(`Error: ${err.message.slice(0, 200)}`).catch(() => {});
      console.error(`[Discord] Slash command /${commandName} error:`, err.message);
    }
  });

  client.on('error', (err) => console.error('[Discord]', err.message));

  client.login(token).catch((err) => console.error('[Discord] Login failed:', err.message));
  console.log('[Discord] Adapter starting...');

  return {
    sendOwnerDM: async (text) => {
      if (!OWNER_ID) return;
      try {
        const owner = await client.users.fetch(OWNER_ID);
        await owner.send(text);
      } catch (err) {
        console.error('[Discord] Failed to DM owner:', err.message);
      }
    },

    /** Send a DM to any Discord user by their snowflake ID. Returns message.id on success, null on failure. */
    sendDM: async (discordUserId, text) => {
      try {
        const user = await client.users.fetch(discordUserId);
        const msg = await user.send(text);
        return msg.id;
      } catch (err) {
        console.warn(`[Discord] Failed to DM user ${discordUserId}:`, err.message);
        return null;
      }
    },

    /** Send a message to a specific channel by ID. Returns message.id on success, null on failure. */
    sendToChannel: async (channelId, text) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          const msg = await channel.send(text);
          return msg.id;
        }
        return null;
      } catch (err) {
        console.warn(`[Discord] Failed to send to channel ${channelId}:`, err.message);
        return null;
      }
    },
  };
}
