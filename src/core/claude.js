import Anthropic from '@anthropic-ai/sdk';

// Prefer an explicit API key; fall back to the Claude Code OAuth token
const client = process.env.CLAUDE_CODE_OAUTH_TOKEN
  ? new Anthropic({ authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN })
  : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const BOT_NAME = process.env.BOT_NAME ?? 'claude';

/**
 * Send a prompt to Claude and return the text response.
 *
 * @param {string} userMessage - The user's message after stripping the mention.
 * @param {{ history?: Array<{ role: 'user' | 'assistant', content: string }> }} options
 * @returns {Promise<string>}
 */
export async function ask(userMessage, { history = [] } = {}) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: `You are ${BOT_NAME}, a helpful AI assistant integrated into a messaging platform. Be concise and friendly.`,
    messages: [
      ...history,
      { role: 'user', content: userMessage },
    ],
  });

  return response.content[0].text;
}
