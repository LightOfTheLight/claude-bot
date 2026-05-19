/**
 * Gateway lifecycle manager.
 *
 * Responsibilities:
 *   - Sync OAuth tokens from ~/.claude/.credentials.json → ai-gateway/.env
 *   - Spawn / kill / restart the gateway process
 *   - Expose syncAndRestart() for callGateway to call on invalid_grant
 *
 * The bot owns the gateway process once it takes over. If the user started
 * the gateway manually, the first syncAndRestart() will replace it.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? '4242');
const GATEWAY_URL  = process.env.GATEWAY_URL ?? `http://localhost:${GATEWAY_PORT}`;

// Resolve gateway directory: env override → sibling directory → home
function resolveGatewayDir() {
  if (process.env.GATEWAY_DIR) return process.env.GATEWAY_DIR;
  // Try sibling of the claude-bot repo
  const sibling = path.resolve(process.cwd(), '..', 'ai-gateway');
  if (fs.existsSync(path.join(sibling, 'package.json'))) return sibling;
  return path.join(os.homedir(), 'WorkPlace', 'ai-gateway');
}

const GATEWAY_DIR       = resolveGatewayDir();
const GATEWAY_ENV_PATH  = path.join(GATEWAY_DIR, '.env');
const CREDENTIALS_PATH  = path.join(os.homedir(), '.claude', '.credentials.json');

let _proc = null; // managed child_process handle

// ─── Token sync ───────────────────────────────────────────────────────────────

/**
 * Read OAuth tokens from Claude Code's credential store and patch gateway .env.
 * Throws if credentials are missing or gateway .env doesn't exist.
 */
export function syncTokens() {
  let env = fs.readFileSync(GATEWAY_ENV_PATH, 'utf8');

  // If a proper API key is already set, prefer it over OAuth tokens
  const hasApiKey = /^ANTHROPIC_API_KEY=sk-ant-api/m.test(env) ||
    (/^ANTHROPIC_API_KEY=.+/m.test(env) && !/^ANTHROPIC_API_KEY=sk-ant-oat/m.test(env));

  if (hasApiKey) {
    console.log('[gateway-manager] API key present — skipping OAuth token sync');
    return;
  }

  // No API key — sync OAuth tokens from Claude Code credentials
  const raw  = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (!oauth?.accessToken || !oauth?.refreshToken) {
    throw new Error('claudeAiOauth not found in ~/.claude/.credentials.json');
  }

  const patch = {
    ANTHROPIC_API_KEY            : oauth.accessToken,   // keep gateway key in sync with fresh token
    ANTHROPIC_OAUTH_ACCESS_TOKEN : oauth.accessToken,
    ANTHROPIC_OAUTH_REFRESH_TOKEN: oauth.refreshToken,
    ANTHROPIC_OAUTH_EXPIRES_AT   : String(oauth.expiresAt),
  };

  for (const [k, v] of Object.entries(patch)) {
    const re = new RegExp(`^${k}=.*$`, 'gm');
    if (re.test(env)) {
      // Replace ALL occurrences (handles accidental duplicates)
      env = env.replace(new RegExp(`^${k}=.*$`, 'gm'), `${k}=${v}`);
    } else {
      // Append — ensure file ends with a newline before adding
      if (!env.endsWith('\n')) env += '\n';
      env += `${k}=${v}\n`;
    }
  }

  fs.writeFileSync(GATEWAY_ENV_PATH, env, 'utf8');
  console.log('[gateway-manager] Tokens synced — expires', new Date(oauth.expiresAt).toISOString());
}

// ─── Process management ───────────────────────────────────────────────────────

/** Kill whatever process is listening on the gateway port. */
function killPort() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${GATEWAY_PORT}`, { encoding: 'utf8' });
      const pids = [
        ...new Set(
          out.split('\n')
            .filter((l) => l.includes('LISTENING') || l.includes(`:${GATEWAY_PORT}`))
            .map((l) => l.trim().split(/\s+/).pop())
            .filter((p) => /^\d+$/.test(p) && p !== '0'),
        ),
      ];
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' }); } catch {}
      }
    } else {
      execSync(`fuser -k ${GATEWAY_PORT}/tcp 2>/dev/null || true`, { shell: true });
    }
    console.log(`[gateway-manager] Killed process(es) on port ${GATEWAY_PORT}`);
  } catch {
    // Nothing was listening — that's fine
  }
}

/** Spawn the gateway process; wire stdout/stderr through to bot console. */
function spawnGateway() {
  const child = spawn('bun', ['run', 'src/index.ts'], {
    cwd  : GATEWAY_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: false,
  });

  child.stdout.on('data', (d) => process.stdout.write(`[gateway] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[gateway] ${d}`));
  child.on('exit', (code, signal) => {
    console.warn(`[gateway-manager] Process exited — code=${code} signal=${signal}`);
    if (_proc === child) _proc = null;
  });

  _proc = child;
  console.log(`[gateway-manager] Spawned gateway (pid=${child.pid}, dir=${GATEWAY_DIR})`);
  return child;
}

/** Wait up to maxMs for the health endpoint to respond OK. */
async function waitHealthy(maxMs = 8000) {
  const step = 800;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    await new Promise((r) => setTimeout(r, step));
    try {
      const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log('[gateway-manager] Gateway is healthy');
        return true;
      }
    } catch {}
  }
  console.warn('[gateway-manager] Gateway did not become healthy within', maxMs, 'ms');
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sync tokens then kill + respawn the gateway.
 * Called at bot startup and on invalid_grant errors.
 */
export async function syncAndRestart() {
  // 1. Sync tokens into .env first so the new process picks them up
  syncTokens();

  // 2. Gracefully stop managed process (if any)
  if (_proc) {
    _proc.kill('SIGTERM');
    _proc = null;
    await new Promise((r) => setTimeout(r, 400));
  }

  // 3. Kill anything else on the port (e.g. a user-started gateway)
  killPort();
  await new Promise((r) => setTimeout(r, 300));

  // 4. Spawn fresh
  spawnGateway();

  // 5. Wait for it to come up
  return waitHealthy();
}
