import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const credsPath = join(homedir(), '.claude', '.credentials.json');
const envPath = new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const token = creds.claudeAiOauth.accessToken;

let env = readFileSync(envPath, 'utf8');
env = env.replace(/^ANTHROPIC_API_KEY=.*/m, 'ANTHROPIC_API_KEY=');
env = env.replace(/^# CLAUDE_CODE_OAUTH_TOKEN=.*/m, `CLAUDE_CODE_OAUTH_TOKEN=${token}`);
writeFileSync(envPath, env);

console.log('CLAUDE_CODE_OAUTH_TOKEN written to .env');
