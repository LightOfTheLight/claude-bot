/**
 * Discord response formatter.
 * Splits long messages to respect Discord's 2000-char limit.
 */

const DISCORD_LIMIT = 2000;
const CHUNK_SIZE = 1900; // leave headroom for reply overhead

export async function send(replyFn, text) {
  if (!text) return;
  if (text.length <= DISCORD_LIMIT) {
    await replyFn(text);
    return;
  }
  // Split on paragraph boundaries where possible
  const chunks = splitText(text, CHUNK_SIZE);
  for (const chunk of chunks) {
    await replyFn(chunk);
  }
}

function splitText(text, maxLen) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Try to split at a paragraph break
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
