import { Client, Events, GatewayIntentBits } from 'discord.js';
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
} from '../memory/index.js';

const tracer = trace.getTracer('claudebot', '2.0.0');
const BOT_NAME = process.env.BOT_NAME ?? 'Claude';
const OWNER_ID = process.env.DISCORD_OWNER_ID ?? '';


// ─── Built-in commands ────────────────────────────────────────────────────────

/** Returns true if the message was a built-in command (handled internally). */
async function handleCommand(text, userId, platform, reply) {
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
    await reply('Reset conversation context? Reply `yes` within 30s to confirm.');
    return true; // confirmation handled in next message (simple approach: just proceed)
  }

  if (lower === 'yes' || lower === '/reset-context confirm') {
    resetThread(userId);
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

  return false; // not a built-in command
}

// ─── Message pipeline ─────────────────────────────────────────────────────────

async function handleMessage(text, platformId, platform, reply, sendTyping) {
  return tracer.startActiveSpan('bot.message.receive', async (span) => {
    span.setAttribute('platform', platform);
    try {
      // Resolve identity
      const userId = getOrCreateUser(platform, platformId);

      // Built-in commands bypass routing
      const handled = await handleCommand(text, userId, platform, reply);
      if (handled) { span.end(); return; }

      const { messages: history, summary, learnings } = getContext(userId);

      await sendTyping();

      // Single call: CLI first (separate quota tier), gateway as fallback
      const { callGateway, callClaudeCLI } = await import('../core/claude.js');
      const system = buildSystem(summary, learnings);
      const msgs = [...history, { role: 'user', content: text }];
      let responseText;
      let toolUseCount = 0;

      // Keep typing indicator alive during long CLI responses (expires after 10s)
      const typingInterval = setInterval(() => sendTyping().catch(() => {}), 8000);

      try {
        // Try streaming CLI first
        let liveMsg = null;
        let accumulated = '';
        let lastEdit = 0;

        const result = await callClaudeCLI({
          messages: msgs,
          system,
          onChunk: async (chunk) => {
            accumulated += chunk;
            const now = Date.now();
            if (now - lastEdit > 1200) {
              lastEdit = now;
              const preview = accumulated.slice(-1900) + '▌';
              try {
                if (!liveMsg) {
                  liveMsg = await reply(preview);
                } else {
                  await liveMsg.edit(preview);
                }
              } catch {
                // edit failed — ignore, we'll set the final message anyway
              }
            }
          },
        });
        responseText = result.text;

        // Finalize: edit or send the complete response
        if (liveMsg) {
          if (responseText.length <= 2000) {
            await liveMsg.edit(responseText).catch(() => {});
          } else {
            // Too long to fit in one edit — delete placeholder and send chunks
            await liveMsg.delete().catch(() => {});
            await sendReply(reply, responseText);
          }
        } else {
          await sendReply(reply, responseText);
        }
      } catch {
        const result = await callGateway({ messages: msgs, system });
        responseText = result.text;
        toolUseCount = result.toolUseCount;
        await sendReply(reply, responseText);
      } finally {
        clearInterval(typingInterval);
      }

      // Persist both turns only after a successful response
      appendMessage(userId, { role: 'user', content: text, platform });
      appendMessage(userId, { role: 'assistant', content: responseText, platform });
      if (toolUseCount) incrementToolUse(userId, toolUseCount);

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (err.code === 'GATEWAY_RATE_LIMITED') {
        await reply(`⏳ AI providers are rate-limited. Try again in ${err.retryAfter}s.`).catch(() => {});
      } else {
        await reply('Sorry, something went wrong.').catch(() => {});
      }
    } finally {
      span.end();
    }
  });
}

function buildSystem(summary, learnings) {
  const parts = [
    `You are ${BOT_NAME}, a helpful AI assistant integrated into Discord. Be concise and friendly.`,
  ];
  if (summary) parts.push(`Conversation summary: ${summary}`);
  if (learnings?.length) {
    parts.push(`User insights: ${learnings.map((l) => `${l.key}: ${l.insight}`).join('; ')}`);
  }
  return parts.join('\n');
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

      // Find messages directed at the bot (DM or mention)
      const isDM = channel.type === 1;
      const directed = sorted.filter((m) =>
        !m.author.bot && (isDM || m.mentions.has(client.user))
      );
      if (!directed.length) continue;

      // Check if the bot already replied after the last directed message
      const lastDirected = directed[directed.length - 1];
      const botRepliedAfter = sorted.some(
        (m) => m.author.id === client.user.id && m.createdTimestamp > lastDirected.createdTimestamp
      );
      if (botRepliedAfter) continue;

      const text = lastDirected.content.replace(/<@!?\d+>/g, '').trim();
      if (!text) continue;

      console.log(`[Discord] catch-up: answering missed message in channel ${channel_id} from ${lastDirected.author.id}`);

      await handleMessage(
        text,
        lastDirected.author.id,
        'discord',
        (r) => lastDirected.reply(r),
        () => channel.sendTyping(),
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
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag}`);
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
    if (!isMentioned && !isDM) return;

    const text = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!text) return;

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

    let _replyN = 0;
    const trackedReply = (r) => {
      _replyN++;
      const preview = String(r).slice(0, 80);
      const stack = new Error().stack.split('\n').slice(2, 5).join(' | ');
      console.log(`[Discord] reply #${_replyN} for msg ${message.id}: "${preview}" @ ${stack}`);
      return message.reply(r);
    };

    try {
      await handleMessage(
        text,
        message.author.id,
        'discord',
        trackedReply,
        () => message.channel.sendTyping(),
      );
    } finally {
      _inFlight.delete(message.id);
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
  };
}
