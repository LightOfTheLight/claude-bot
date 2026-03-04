import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const credsPath = join(homedir(), '.claude', '.credentials.json');
const envPath = new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const token = creds.claudeAiOauth.accessToken;

let env = readFileSync(envPath, 'utf8');

// Clear any plain API key so the OAuth token takes sole precedence
env = env.replace(/^ANTHROPIC_API_KEY=.*/m, 'ANTHROPIC_API_KEY=');

// Write as ANTHROPIC_AUTH_TOKEN — the name the Anthropic SDK reads natively
if (/^#?\s*ANTHROPIC_AUTH_TOKEN=/m.test(env)) {
  env = env.replace(/^#?\s*ANTHROPIC_AUTH_TOKEN=.*/m, `ANTHROPIC_AUTH_TOKEN=${token}`);
} else {
  env += `\nANTHROPIC_AUTH_TOKEN=${token}\n`;
}

writeFileSync(envPath, env);

console.log('CLAUDE_CODE_OAUTH_TOKEN written to .env');
