/**
 * Google Drive integration — per-user OAuth2, large file upload.
 *
 * Flow:
 *   1. User runs /auth_gdrive → bot calls getAuthUrl(userId) → sends link
 *   2. User authorises in browser → Google redirects to GDRIVE_REDIRECT_URI
 *   3. Webhook handler calls handleOAuthCallback(code, userId) → stores tokens
 *   4. On delivery, isOversized(path) → uploadToDrive(userId, path) → shareable link
 *
 * Env vars required:
 *   GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REDIRECT_URI
 */

import { google } from 'googleapis';
import { statSync, createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { getDb } from '../memory/db.js';

export const DISCORD_FILE_LIMIT = 25 * 1024 * 1024; // 25 MB

function isConfigured() {
  return !!(process.env.GDRIVE_CLIENT_ID && process.env.GDRIVE_CLIENT_SECRET && process.env.GDRIVE_REDIRECT_URI);
}

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GDRIVE_CLIENT_ID,
    process.env.GDRIVE_CLIENT_SECRET,
    process.env.GDRIVE_REDIRECT_URI,
  );
}

/** Generate the consent-screen URL to send to the user. */
export function getAuthUrl(userId) {
  if (!isConfigured()) throw new Error('Google Drive OAuth not configured (missing env vars)');
  const client = makeOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    state: userId,
    prompt: 'consent',
  });
}

/** Exchange OAuth code for tokens and persist them. Called from the webhook callback. */
export async function handleOAuthCallback(code, userId) {
  const client = makeOAuth2Client();
  const { tokens } = await client.getToken(code);
  _saveTokens(userId, tokens);
  return tokens;
}

/** True if this userId has stored Drive credentials. */
export function hasGDriveAuth(userId) {
  return !!_getTokenRow(userId);
}

/** True if the file at filePath exceeds Discord's upload limit. */
export function isOversized(filePath) {
  try {
    return statSync(filePath).size > DISCORD_FILE_LIMIT;
  } catch {
    return false;
  }
}

/**
 * Upload filePath to the user's Google Drive and return a public shareable link.
 * Throws if the user hasn't authorised or the upload fails.
 */
export async function uploadToDrive(userId, filePath) {
  const row = _getTokenRow(userId);
  if (!row) throw new Error('User has not authorised Google Drive — run /auth_gdrive first');

  const client = makeOAuth2Client();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date,
  });

  // Persist refreshed tokens automatically
  client.on('tokens', (tokens) => {
    _saveTokens(userId, { refresh_token: row.refresh_token, ...tokens });
  });

  const drive = google.drive({ version: 'v3', auth: client });

  // Upload
  const createRes = await drive.files.create({
    requestBody: { name: basename(filePath) },
    media: { body: createReadStream(filePath) },
    fields: 'id,name',
  });
  const fileId = createRes.data.id;

  // Make publicly readable
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  // Get the view link
  const meta = await drive.files.get({ fileId, fields: 'webViewLink' });
  return meta.data.webViewLink;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _getTokenRow(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM gdrive_tokens WHERE user_id = ?').get(userId);
}

function _saveTokens(userId, tokens) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO gdrive_tokens (user_id, access_token, refresh_token, expiry_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, gdrive_tokens.refresh_token),
      expiry_date  = excluded.expiry_date,
      updated_at   = excluded.updated_at
  `).run(
    userId,
    tokens.access_token,
    tokens.refresh_token ?? null,
    tokens.expiry_date  ?? null,
    now,
    now,
  );
}
