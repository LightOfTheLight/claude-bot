import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json());

// Health check — required by the Docker Compose healthcheck
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

/**
 * Auto-detect which adapters to start based on available env vars.
 * Overridden by the ADAPTERS env var (comma-separated, e.g. "discord,telegram").
 */
function resolveAdapters() {
  if (process.env.ADAPTERS) {
    return process.env.ADAPTERS.split(',').map((a) => a.trim().toLowerCase());
  }

  // Returns true only if the var is set and not still a placeholder value
  const isConfigured = (...vars) => vars.every((v) => process.env[v] && !process.env[v].startsWith('your_') && !process.env[v].includes('-your-'));

  const detected = [];
  if (isConfigured('DISCORD_BOT_TOKEN')) detected.push('discord');
  if (isConfigured('SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN')) detected.push('slack');
  if (isConfigured('TELEGRAM_BOT_TOKEN')) detected.push('telegram');
  if (isConfigured('WHATSAPP_ACCESS_TOKEN')) detected.push('whatsapp');
  if (isConfigured('WECHATY_TOKEN')) detected.push('wechat');

  if (detected.length === 0) {
    console.warn('[index] No adapter credentials found. Set at least one platform token in .env');
  }

  return detected;
}

async function startAdapters(adapters) {
  for (const name of adapters) {
    try {
      switch (name) {
        case 'discord': {
          const { start } = await import('./adapters/discord.js');
          start();
          break;
        }
        case 'slack': {
          const { start } = await import('./adapters/slack.js');
          start();
          break;
        }
        case 'telegram': {
          const { start } = await import('./adapters/telegram.js');
          start();
          break;
        }
        case 'whatsapp': {
          const { register } = await import('./adapters/whatsapp.js');
          register(app); // mounts routes on the shared Express app
          break;
        }
        case 'wechat': {
          const { start } = await import('./adapters/wechat.js');
          start();
          break;
        }
        default:
          console.warn(`[index] Unknown adapter: "${name}" — skipping`);
      }
    } catch (err) {
      console.error(`[index] Failed to start adapter "${name}": ${err.message}`);
    }
  }
}

const PORT = process.env.PORT ?? 3000;

app.listen(PORT, async () => {
  console.log(`[index] HTTP server listening on port ${PORT}`);
  const adapters = resolveAdapters();
  console.log(`[index] Starting adapters: ${adapters.join(', ') || 'none'}`);
  await startAdapters(adapters);
});
