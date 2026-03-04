import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const BOT_NAME = process.env.BOT_NAME ?? 'claude';

function getApiKey() {
  // Prefer an explicit API key from env
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Fall back to the Claude Code OAuth token (works as x-api-key)
  try {
    const credsPath = join(homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
    return creds.claudeAiOauth.accessToken;
  } catch {
    throw new Error('No ANTHROPIC_API_KEY set and ~/.claude/.credentials.json not found');
  }
}

// Lazily instantiated after dotenv has loaded
let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: getApiKey() });
  return client;
}

/**
 * Send a prompt to Claude and return the text response.
 *
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
export async function ask(userMessage) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: `You are ${BOT_NAME}, a helpful AI assistant integrated into a messaging platform. Be concise and friendly.`,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].text;
}
