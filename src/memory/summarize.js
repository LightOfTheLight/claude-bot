import { getDb } from './db.js';

const MESSAGES_TO_COMPRESS = 50;

/**
 * LLM-based context compression. Triggered when message_count crosses SUMMARY_TRIGGER.
 * Summarises the oldest MESSAGES_TO_COMPRESS messages and appends to threads.summary.
 * Removes those messages from the rolling window JSON.
 */
export async function maybeSummarize(userId) {
  const db = getDb();
  const thread = db.prepare('SELECT messages, summary FROM threads WHERE user_id = ?').get(userId);
  if (!thread) return;

  let messages = [];
  try { messages = JSON.parse(thread.messages); } catch { return; }

  if (messages.length < MESSAGES_TO_COMPRESS) return;

  const toCompress = messages.slice(0, MESSAGES_TO_COMPRESS);
  const remaining = messages.slice(MESSAGES_TO_COMPRESS);

  const conversationText = toCompress
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const existingSummary = thread.summary ?? '';
  const prompt = existingSummary
    ? `Previous summary: ${existingSummary}\n\nNew conversation:\n${conversationText}`
    : conversationText;

  try {
    // Lazy import to avoid circular dependency at module load time
    const { callGateway } = await import('../core/claude.js');
    const { text } = await callGateway({
      messages: [{ role: 'user', content: prompt }],
      system: 'Summarize the following conversation into 2-3 sentences capturing key topics, decisions, and user preferences. Be factual and concise.',
      maxTokens: 256,
    });

    db.prepare('UPDATE threads SET messages = ?, summary = ?, updated_at = ? WHERE user_id = ?')
      .run(JSON.stringify(remaining), text.trim(), Date.now(), userId);
  } catch (err) {
    console.warn('[summarize] failed for', userId, err.message);
  }
}
