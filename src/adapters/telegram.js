import { Telegraf } from 'telegraf';
import { ask } from '../core/claude.js';

export function start() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const bot = new Telegraf(token);
  const botName = (process.env.BOT_NAME ?? 'claude').toLowerCase();

  bot.on('text', async (ctx) => {
    const text = ctx.message.text ?? '';
    const isPrivate = ctx.chat.type === 'private';

    // In groups, only respond when the bot is mentioned by @handle or name
    const botUsername = ctx.botInfo.username.toLowerCase();
    const isMentioned =
      text.toLowerCase().includes(`@${botUsername}`) ||
      text.toLowerCase().includes(`@${botName}`);

    if (!isPrivate && !isMentioned) return;

    const prompt = text
      .replace(new RegExp(`@${botUsername}`, 'gi'), '')
      .replace(new RegExp(`@${botName}`, 'gi'), '')
      .trim();

    if (!prompt) return;

    try {
      await ctx.sendChatAction('typing');
      const reply = await ask(prompt);
      await ctx.reply(reply, { reply_parameters: { message_id: ctx.message.message_id } });
    } catch (err) {
      console.error('[Telegram]', err);
      await ctx.reply('Sorry, something went wrong.').catch(() => {});
    }
  });

  bot.launch().then(() => console.log('[Telegram] Adapter started')).catch((err) => {
    console.error('[Telegram] Failed to start:', err.message);
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
