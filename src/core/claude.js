import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BOT_NAME = process.env.BOT_NAME ?? 'claude';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

/**
 * Send a prompt to Claude via the Claude CLI and return the text response.
 *
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
export async function ask(userMessage) {
  const systemPrompt = `You are ${BOT_NAME}, a helpful AI assistant integrated into a messaging platform. Be concise and friendly.`;
  const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

  const { stdout } = await execFileAsync(CLAUDE_BIN, ['--print', fullPrompt], {
    timeout: 60000,
  });

  return stdout.trim();
}
