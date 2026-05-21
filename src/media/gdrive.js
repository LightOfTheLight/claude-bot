/**
 * Google Drive integration — per-user OAuth2, large file upload.
 *
 * Upload structure:
 *   [root folder (default: "claude-bot")]
 *     └── [thread title]
 *           └── file.apk
 *
 * Flow:
 *   1. User runs /auth_gdrive → consent URL → tokens stored
 *   2. Optionally: /set gdrive_folder <name> → setUserFolder() stores folder ID
 *   3. On delivery, isOversized(path) → uploadToDrive(userId, path, threadTitle)
 *
 * Env vars required:
 *   GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REDIRECT_URI
 */

import { google } from 'googleapis';
import { statSync, createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { getDb } from '../memory/db.js';

export const DISCORD_FILE_LIMIT = 25 * 1024 * 1024; // 25 MB
const DEFAULT_FOLDER_NAME = 'claude-bot';

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
 * Find or create a root folder by name in the user's Drive, store its ID.
 * Called when user runs /set gdrive_folder <name>.
 */
export async function setUserFolder(userId, folderName) {
  const drive = await _getDriveClient(userId);
  const folderId = await _findOrCreateFolder(drive, folderName, null);
  _saveFolderId(userId, folderId);
  return folderName;
}

/**
 * Upload filePath to the user's Google Drive.
 * - Places file under: [root folder] / [threadTitle] / file
 * - Root folder defaults to "claude-bot" if not set by user.
 * - threadTitle subfolder is created if it doesn't exist.
 * Returns a public shareable link.
 */
export async function uploadToDrive(userId, filePath, threadTitle = null) {
  const row = _getTokenRow(userId);
  if (!row) throw new Error('User has not authorised Google Drive — run /auth_gdrive first');

  const drive = await _getDriveClient(userId, row);

  // 1. Resolve root folder (stored ID or find/create default)
  let rootFolderId = row.folder_id ?? null;
  if (!rootFolderId) {
    rootFolderId = await _findOrCreateFolder(drive, DEFAULT_FOLDER_NAME, null);
    _saveFolderId(userId, rootFolderId);
  }

  // 2. Resolve thread subfolder
  const subFolderName = threadTitle
    ? threadTitle.slice(0, 100)   // Drive folder name limit
    : 'uncategorised';
  const subFolderId = await _findOrCreateFolder(drive, subFolderName, rootFolderId);

  // 3. Upload file into the subfolder
  const createRes = await drive.files.create({
    requestBody: {
      name: basename(filePath),
      parents: [subFolderId],
    },
    media: { body: createReadStream(filePath) },
    fields: 'id',
  });
  const fileId = createRes.data.id;

  // 4. Make publicly readable
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  // 5. Return shareable link
  const meta = await drive.files.get({ fileId, fields: 'webViewLink' });
  return meta.data.webViewLink;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _getDriveClient(userId, row) {
  const tokenRow = row ?? _getTokenRow(userId);
  if (!tokenRow) throw new Error('No Google Drive token for user');

  const client = makeOAuth2Client();
  client.setCredentials({
    access_token:  tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date:   tokenRow.expiry_date,
  });
  client.on('tokens', (tokens) => {
    _saveTokens(userId, { refresh_token: tokenRow.refresh_token, ...tokens });
  });
  return google.drive({ version: 'v3', auth: client });
}

/**
 * Find a folder by name (optionally under parentId), or create it.
 * Returns the folder ID.
 */
async function _findOrCreateFolder(drive, name, parentId) {
  const parentQuery = parentId ? ` and '${parentId}' in parents` : " and 'root' in parents";
  const res = await drive.files.list({
    q: `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentQuery}`,
    fields: 'files(id)',
    pageSize: 1,
  });

  if (res.data.files?.length) {
    return res.data.files[0].id;
  }

  // Create it
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
  });
  return created.data.id;
}

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
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, gdrive_tokens.refresh_token),
      expiry_date   = excluded.expiry_date,
      updated_at    = excluded.updated_at
  `).run(
    userId,
    tokens.access_token,
    tokens.refresh_token ?? null,
    tokens.expiry_date   ?? null,
    now,
    now,
  );
}

function _saveFolderId(userId, folderId) {
  const db = getDb();
  db.prepare('UPDATE gdrive_tokens SET folder_id = ?, updated_at = ? WHERE user_id = ?')
    .run(folderId, Date.now(), userId);
}
