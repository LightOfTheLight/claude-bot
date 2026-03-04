import { Client, Events, GatewayIntentBits } from 'discord.js';
import { ask } from '../core/claude.js';

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
    console.log(`[Discord] msg from ${message.author.tag} | bot=${message.author.bot} | content="${message.content}" | mentioned=${message.mentions.has(client.user)}`);
    if (message.author.bot) return;

    const isMentioned = message.mentions.has(client.user);
    const isDM = message.channel.type === 1; // ChannelType.DM
    if (!isMentioned && !isDM) return;

    // Strip all @mentions to get the clean prompt
    const prompt = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!prompt) return;

    try {
      await message.channel.sendTyping();
      const reply = await ask(prompt);
      await message.reply(reply);
    } catch (err) {
      console.error('[Discord]', err);
      await message.reply('Sorry, something went wrong.').catch(() => {});
    }
  });

  client.on('error', (err) => console.error('[Discord]', err.message));

  client.login(token).catch((err) => console.error('[Discord] Login failed:', err.message));
  console.log('[Discord] Adapter starting...');
}
