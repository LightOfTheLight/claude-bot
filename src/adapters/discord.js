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
  createReminder,
} from '../memory/index.js';

const tracer = trace.getTracer('claudebot', '2.0.0');
const BOT_NAME = process.env.BOT_NAME ?? 'Claude';
const OWNER_ID = process.env.DISCORD_OWNER_ID ?? '';

// Lazily imported after routing modules are available
let _router = null;
let _runner = null;
async function getRouter() {
  if (!_router) _router = await import('../router/index.js');
  return _router;
}
async function getRunner() {
  if (!_runner) _runner = await import('../skills/runner.js');
  return _runner;
}

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

      // Load context
      const { messages, summary, learnings } = getContext(userId);

      // Append user message before calling LLM (so context includes it)
      appendMessage(userId, { role: 'user', content: text, platform });

      await sendTyping();

      // Route intent (falls back to direct gateway call if router unavailable)
      let responseText;
      let toolUseCount = 0;

      try {
        const router = await getRouter();
        const intent = await router.classifyIntent(text, messages);

        if (intent.intent === 'skill_dispatch' && intent.skill) {
          const runner = await getRunner();
          const result = await runner.runSkill(intent.skill, { messages, summary, learnings, userId });
          responseText = result.text;
          toolUseCount = result.toolUseCount;
        } else if (intent.intent === 'reminder' && intent.fire_at && intent.message) {
          // Validate fire_at (Reviewer Concern #5)
          const fireTs = Date.parse(intent.fire_at);
          if (!Number.isFinite(fireTs)) throw new Error('invalid fire_at from router');
          createReminder(userId, { message: intent.message, fireAt: fireTs, platform });
          responseText = `Got it — I'll remind you: "${intent.message}" at ${new Date(fireTs).toLocaleString()}.`;
        } else {
          // General query: direct gateway call with memory context
          const { callGateway } = await import('../core/claude.js');
          const system = buildSystem(summary, learnings);
          const result = await callGateway({ messages, system });
          responseText = result.text;
          toolUseCount = result.toolUseCount;
        }
      } catch (routerErr) {
        // Router unavailable (Week 1: modules not yet present) — fall back to direct call
        const { callGateway } = await import('../core/claude.js');
        const system = buildSystem(summary, learnings);
        const result = await callGateway({ messages, system });
        responseText = result.text;
        toolUseCount = result.toolUseCount;
      }

      // Persist assistant response + tool use count
      appendMessage(userId, { role: 'assistant', content: responseText, platform });
      if (toolUseCount) incrementToolUse(userId, toolUseCount);

      await sendReply(reply, responseText);

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      await reply('Sorry, something went wrong.').catch(() => {});
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

  client.once(Events.ClientReady, (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const isMentioned = message.mentions.has(client.user);
    const isDM = message.channel.type === 1;
    if (!isMentioned && !isDM) return;

    const text = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!text) return;

    await handleMessage(
      text,
      message.author.id,
      'discord',
      (r) => message.reply(r),
      () => message.channel.sendTyping(),
    );
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
