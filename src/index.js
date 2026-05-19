import 'dotenv/config';
import express from 'express';

// Print a restart separator so log files are easy to scan across restarts
const startedAt = new Date().toISOString();
console.log(`\n${'─'.repeat(60)}`);
console.log(`[index] *** BOT STARTING — ${startedAt} ***`);
console.log(`${'─'.repeat(60)}\n`);
import { initDb } from './memory/db.js';
import { checkGatewayHealth } from './core/claude.js';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

function resolveAdapters() {
  if (process.env.ADAPTERS) {
    return process.env.ADAPTERS.split(',').map((a) => a.trim().toLowerCase());
  }
  const isConfigured = (...vars) =>
    vars.every((v) => process.env[v] && !process.env[v].startsWith('your_') && !process.env[v].includes('-your-'));

  const detected = [];
  if (isConfigured('DISCORD_BOT_TOKEN')) detected.push('discord');
  if (isConfigured('SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN')) detected.push('slack');
  if (isConfigured('TELEGRAM_BOT_TOKEN')) detected.push('telegram');
  if (isConfigured('WHATSAPP_ACCESS_TOKEN')) detected.push('whatsapp');
  if (isConfigured('WECHATY_TOKEN')) detected.push('wechat');

  if (!detected.length) {
    console.warn('[index] No adapter credentials found — set at least one platform token in .env');
  }
  return detected;
}

// Collect send handles from adapters that support them
const ownerDMHandles = [];
const platformSenders = {}; // platform → { sendDM, sendToChannel }

async function startAdapters(adapters) {
  for (const name of adapters) {
    try {
      switch (name) {
        case 'discord': {
          const { start } = await import('./adapters/discord.js');
          const handle = start();
          if (handle?.sendOwnerDM) ownerDMHandles.push(handle.sendOwnerDM);
          if (handle?.sendDM || handle?.sendToChannel) {
            platformSenders['discord'] = {
              sendDM: handle.sendDM,
              sendToChannel: handle.sendToChannel,
            };
          }
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
          register(app);
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
      console.error(`[index] Failed to start adapter "${name}":`, err.message);
    }
  }
}

async function sendOwnerAlert(text) {
  for (const fn of ownerDMHandles) {
    try { await fn(text); } catch {}
  }
}

const PORT = process.env.PORT ?? 3000;

// Save lastOnline timestamp on graceful shutdown so catch-up knows the cutoff
async function saveLastOnline() {
  try {
    const { setBotState } = await import('./memory/index.js');
    setBotState('lastOnline', String(Date.now()));
  } catch {}
}
process.on('SIGTERM', async () => { await saveLastOnline(); process.exit(0); });
process.on('SIGINT',  async () => { await saveLastOnline(); process.exit(0); });

app.listen(PORT, async () => {
  console.log(`[index] HTTP server on port ${PORT}`);

  // Initialise SQLite (runs migrations)
  await initDb();
  console.log('[index] Database ready');

  // Load persisted traces into memory
  try {
    const { initTraceStore } = await import('./trace/index.js');
    initTraceStore();
  } catch (err) {
    console.warn('[index] Trace store init failed:', err.message);
  }

  // Startup backup (runs after migrations so the backup reflects current schema)
  try {
    const { runBackup } = await import('./backup/index.js');
    const result = await runBackup();
    if (result.ok) {
      console.log(`[index] Startup backup: ${result.path} (${(result.sizeBytes / 1024).toFixed(1)}KB)`);
    }
  } catch (err) {
    console.warn('[index] Startup backup skipped:', err.message);
  }

  // Sync OAuth tokens + ensure gateway is running
  let pendingStartupAlert = false;
  try {
    const { syncAndRestart } = await import('./core/gateway-manager.js');
    const healthy = await syncAndRestart();
    if (healthy) {
      console.log('[index] AI gateway ready (tokens synced, process started)');
    } else {
      console.warn('[index] Gateway started but health check timed out');
      pendingStartupAlert = true;
    }
  } catch (err) {
    // Gateway dir missing or credentials unavailable — fall back to health check only
    console.warn('[index] Gateway manager unavailable:', err.message);
    const healthy = await checkGatewayHealth();
    if (healthy) {
      console.log('[index] AI gateway reachable (external)');
    } else {
      console.warn('[index] AI gateway unreachable at startup — will alert owner once Discord connects');
      pendingStartupAlert = true;
    }
  }

  // Start adapters
  const adapters = resolveAdapters();
  console.log(`[index] Starting adapters: ${adapters.join(', ') || 'none'}`);
  await startAdapters(adapters);

  // Send deferred startup alert now that adapters (and DM channel) are online
  if (pendingStartupAlert) {
    setTimeout(async () => {
      await sendOwnerAlert('⚠️ Bot started but AI gateway was unreachable. Check that `ai-gateway` is running on port 4242.');
    }, 3000); // give Discord a moment to connect
  }

  // Start scheduler (after DB is ready)
  try {
    const { startScheduler } = await import('./scheduler/index.js');
    startScheduler({ sendOwnerAlert, platformSenders });
    console.log('[index] Scheduler started');
  } catch {
    // Scheduler module not yet present (Week 1/2) — skip silently
  }

  // Register webhook routes
  try {
    const { registerWebhookRoutes } = await import('./webhooks/index.js');
    registerWebhookRoutes(app, { platformSenders, sendOwnerAlert });
    console.log('[index] Webhook routes registered');
  } catch (err) {
    console.warn('[index] Webhook routes unavailable:', err.message);
  }

  // Register dashboard routes
  try {
    const { registerDashboardRoutes } = await import('./dashboard/index.js');
    registerDashboardRoutes(app);
  } catch (err) {
    console.warn('[index] Dashboard routes unavailable:', err.message);
  }
});
