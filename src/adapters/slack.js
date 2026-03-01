import pkg from '@slack/bolt';
const { App } = pkg;
import { ask } from '../core/claude.js';

export function start() {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!token || !appToken) {
    throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN must both be set');
  }

  const app = new App({ token, appToken, socketMode: true });

  // Respond to @mentions in channels
  app.event('app_mention', async ({ event, say }) => {
    const prompt = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!prompt) return;

    try {
      const reply = await ask(prompt);
      // Reply in the same thread if it exists, otherwise start one
      await say({ text: reply, thread_ts: event.thread_ts ?? event.ts });
    } catch (err) {
      console.error('[Slack]', err);
      await say({ text: 'Sorry, something went wrong.', thread_ts: event.thread_ts ?? event.ts });
    }
  });

  // Respond to direct messages
  app.message(async ({ message, say }) => {
    if (message.channel_type !== 'im') return;
    const prompt = message.text?.trim();
    if (!prompt) return;

    try {
      const reply = await ask(prompt);
      await say(reply);
    } catch (err) {
      console.error('[Slack]', err);
      await say('Sorry, something went wrong.');
    }
  });

  app.start().then(() => console.log('[Slack] Adapter started (Socket Mode)'));
}
