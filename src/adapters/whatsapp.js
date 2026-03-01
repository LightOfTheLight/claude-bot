import axios from 'axios';
import { ask } from '../core/claude.js';

const WA_API_BASE = 'https://graph.facebook.com/v21.0';

async function sendMessage(to, text) {
  const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID } = process.env;
  await axios.post(
    `${WA_API_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } },
  );
}

/**
 * Register WhatsApp webhook routes on the shared Express app.
 * Uses the WhatsApp Business Cloud API (Meta).
 *
 * @param {import('express').Application} app
 */
export function register(app) {
  const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN } = process.env;

  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_VERIFY_TOKEN) {
    throw new Error(
      'WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_VERIFY_TOKEN must all be set',
    );
  }

  // Meta webhook verification handshake
  app.get('/webhook/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('[WhatsApp] Webhook verified by Meta');
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  });

  // Incoming message handler
  app.post('/webhook/whatsapp', async (req, res) => {
    // Always respond 200 immediately so Meta does not retry
    res.sendStatus(200);

    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from;
    const text = (message.text?.body ?? '').trim();
    const botName = (process.env.BOT_NAME ?? 'claude').toLowerCase();

    // Strip the mention and use the remaining text as the prompt
    const prompt = text.replace(new RegExp(`@${botName}`, 'gi'), '').trim();
    if (!prompt) return;

    try {
      const reply = await ask(prompt);
      await sendMessage(from, reply);
    } catch (err) {
      console.error('[WhatsApp]', err);
      await sendMessage(from, 'Sorry, something went wrong.').catch(() => {});
    }
  });

  console.log('[WhatsApp] Webhook routes registered at /webhook/whatsapp');
}
