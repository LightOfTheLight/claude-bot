import { WechatyBuilder, types } from 'wechaty';
import { ask } from '../core/claude.js';

export function start() {
  const puppet = process.env.WECHATY_PUPPET ?? 'wechaty-puppet-wechat4u';
  const token = process.env.WECHATY_TOKEN;

  const bot = WechatyBuilder.build({
    name: 'claude-bot', // persists login session to ./claude-bot.memory-card.json
    puppet,
    puppetOptions: token ? { token } : {},
  });

  const botName = (process.env.BOT_NAME ?? 'claude').toLowerCase();

  bot.on('scan', (qrcode, status) => {
    console.log(`[WeChat] Scan QR to login (status: ${status})`);
    console.log(`[WeChat] https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`);
  });

  bot.on('login', (user) => {
    console.log(`[WeChat] Logged in as ${user.name()}`);
  });

  bot.on('logout', (user, reason) => {
    console.log(`[WeChat] Logged out: ${user.name()} — ${reason}`);
  });

  bot.on('message', async (message) => {
    // Ignore messages sent by the bot itself
    if (message.self()) return;
    // Only handle plain text messages
    if (message.type() !== types.Message.Text) return;

    const text = (message.text() ?? '').trim();
    const room = message.room();

    if (room) {
      // In group chats, only respond when mentioned by the platform (@name) or bot name
      const mentionedSelf = await message.mentionSelf();
      const namedMention = text.toLowerCase().includes(`@${botName}`);
      if (!mentionedSelf && !namedMention) return;
    }

    const prompt = text.replace(new RegExp(`@${botName}`, 'gi'), '').trim();
    if (!prompt) return;

    try {
      const reply = await ask(prompt);
      if (room) {
        // Mention the sender in the group reply
        await room.say(reply, message.talker());
      } else {
        await message.say(reply);
      }
    } catch (err) {
      console.error('[WeChat]', err);
    }
  });

  bot.on('error', (err) => {
    console.error('[WeChat] Error:', err);
  });

  bot.start().then(() => console.log('[WeChat] Adapter started'));
}
