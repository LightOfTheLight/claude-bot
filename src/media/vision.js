/**
 * Image description via Anthropic claude-haiku-4-5 vision.
 *
 * Reads the image file, encodes it as base64, and asks Haiku to produce
 * a rich description for injection into the main AI pipeline prompt.
 *
 * Requires ANTHROPIC_API_KEY in env. If not set, returns null and the
 * caller falls back to passing the raw file path to the CLI.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

const VISION_MODEL  = 'claude-haiku-4-5-20251001';
const VISION_PROMPT = 'Describe this image thoroughly for a chat assistant that will answer the user\'s follow-up questions. Include: all visible text (exact wording), objects, people, facial expressions, colors, spatial layout, any data/charts/tables, and any context that would help answer questions about it. Be detailed and factual.';

/**
 * Returns true if content-type or filename extension indicates an image.
 */
export function isImage(contentType, filename) {
  if (contentType && IMAGE_TYPES.has(contentType.split(';')[0].trim().toLowerCase())) return true;
  const ext = extname(filename ?? '').toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
}

/**
 * Describe a local image file using Claude Haiku vision.
 * Returns the description string, or null if unavailable.
 */
export async function describeImage(localPath, contentType) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const imageBuffer = readFileSync(localPath);
    const base64      = imageBuffer.toString('base64');
    const mediaType   = normaliseMediaType(contentType, localPath);

    // Lazy import so the SDK doesn't load on every startup if vision is unused
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const msg = await client.messages.create({
      model:      VISION_MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type:   'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    });

    const text = msg.content.find((b) => b.type === 'text')?.text?.trim();
    return text || null;
  } catch (err) {
    console.warn('[vision] describeImage failed:', err.message);
    return null;
  }
}

function normaliseMediaType(contentType, localPath) {
  const raw = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(raw)) return raw;
  const ext = extname(localPath).toLowerCase();
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  return map[ext] ?? 'image/jpeg';
}
