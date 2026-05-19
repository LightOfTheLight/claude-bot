/**
 * Voice message transcription via OpenAI Whisper API.
 *
 * Requires OPENAI_API_KEY in env. Accepts any audio format Whisper supports:
 * ogg, mp3, mp4, wav, webm, m4a, flac.
 *
 * Returns the transcript string, or null if transcription is unavailable.
 */

import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

// MIME types Discord uses for audio attachments
const AUDIO_TYPES = new Set([
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
  'audio/webm', 'audio/x-m4a', 'audio/flac', 'audio/aac',
  'video/ogg', // Discord sometimes tags voice notes as video/ogg
]);

/**
 * Returns true if the attachment content-type or filename looks like audio.
 */
export function isAudio(contentType, filename) {
  if (contentType && AUDIO_TYPES.has(contentType.split(';')[0].trim().toLowerCase())) return true;
  const ext = extname(filename ?? '').toLowerCase();
  return ['.ogg', '.mp3', '.mp4', '.wav', '.webm', '.m4a', '.flac', '.aac'].includes(ext);
}

/**
 * Transcribe a local audio file using OpenAI Whisper.
 * Returns the transcript string, or null if OPENAI_API_KEY is not set or call fails.
 */
export async function transcribeAudio(localPath, filename) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const audioBuffer = readFileSync(localPath);
    const ext   = extname(filename || localPath).slice(1).toLowerCase() || 'ogg';
    const mime  = extToMime(ext);
    const fname = basename(filename || localPath);

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mime }), fname);
    form.append('model', 'whisper-1');
    // Ask Whisper to detect the language automatically
    form.append('response_format', 'json');

    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[transcribe] Whisper API error ${res.status}:`, body.slice(0, 200));
      return null;
    }

    const data = await res.json();
    return data.text?.trim() || null;
  } catch (err) {
    console.warn('[transcribe] transcribeAudio failed:', err.message);
    return null;
  }
}

function extToMime(ext) {
  const map = {
    ogg: 'audio/ogg', mp3: 'audio/mpeg', mp4: 'audio/mp4',
    wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/x-m4a',
    flac: 'audio/flac', aac: 'audio/aac',
  };
  return map[ext] ?? 'audio/ogg';
}
