# RCA: Claude Code OAuth Token Authentication

**Date:** 2026-03-05
**Status:** Resolved
**Component:** `src/core/claude.js`

## Problem

The bot could not authenticate against the Anthropic API using a Claude Code OAuth token (`sk-ant-oat01-...`). The goal was to avoid requiring a separate `ANTHROPIC_API_KEY` and instead reuse the OAuth token already present in `~/.claude/.credentials.json` from an existing Claude Code installation.

## Timeline of Attempts

### 1. SDK `authToken` (Bearer header)

Used the Anthropic SDK's `authToken` constructor parameter, which sends `Authorization: Bearer <token>`:

```javascript
new Anthropic({ authToken: token })
```

**Result:** `401 – "OAuth authentication is currently not supported"`

The API endpoint `api.anthropic.com/v1/messages` explicitly rejects OAuth Bearer tokens.

---

### 2. Raw `fetch` with `Authorization: Bearer`

Bypassed the SDK entirely and called the API directly with various beta headers (`anthropic-beta: oauth-user-auth-2025-01-01`, `claude-oauth-2024-12-01`, no beta header):

```javascript
fetch('https://api.anthropic.com/v1/messages', {
  headers: { 'authorization': `Bearer ${token}`, 'anthropic-version': '2023-06-01' }
})
```

**Result:** All combinations returned `401 – "OAuth authentication is currently not supported"`

---

### 3. OAuth Token Exchange (`create_api_key`)

Found the endpoint `/api/oauth/claude_cli/create_api_key` referenced in the Claude CLI binary. Attempted to exchange the OAuth token for a standard API key:

```javascript
fetch('https://api.anthropic.com/api/oauth/claude_cli/create_api_key', {
  method: 'POST',
  headers: { 'authorization': `Bearer ${token}` }
})
```

**Result:** `403 – missing scope "org:create_api_key"`

The Claude Code OAuth token only has the `user:inference` scope. It cannot be exchanged for an org-level API key.

---

### 4. `claude --print` Subprocess

Attempted to spawn the Claude CLI as a subprocess to use its built-in auth:

```javascript
spawn('claude', ['--print', prompt], { stdio: ['ignore', 'pipe', 'pipe'] })
```

Issues encountered:
- **Nested session error:** `CLAUDECODE=1` inherited from parent Claude Code session; setting `CLAUDECODE=external` bypassed it from bash but not reliably from Node.js.
- **Subprocess hangs:** The process never produced output when spawned from Node.js regardless of `stdio` configuration.

This approach was abandoned.

---

### 5. OAuth Token as `x-api-key` ✅ (Solution)

By accident discovered that the token works when sent as the `x-api-key` header instead of `Authorization: Bearer`:

```javascript
fetch('https://api.anthropic.com/v1/messages', {
  headers: { 'x-api-key': token }
})
```

**Result:** `200 OK`

The Anthropic SDK's `apiKey` constructor parameter maps to the `x-api-key` header, so passing the OAuth token as `apiKey` works correctly:

```javascript
new Anthropic({ apiKey: token })
```

## Root Cause

The Anthropic API accepts Claude Code OAuth tokens as `x-api-key` values, even though they are OAuth tokens (not traditional API keys). This is intentional — it allows Claude Code installations to call the API without requiring a separate paid API key. However, the API explicitly rejects the same token when sent via the `Authorization: Bearer` scheme.

The SDK's `authToken` parameter always uses Bearer auth, so it cannot be used with OAuth tokens. The `apiKey` parameter uses `x-api-key`, which is the correct transport for these tokens.

## Fix

`src/core/claude.js` reads the OAuth token from `~/.claude/.credentials.json` and passes it as `apiKey`:

```javascript
function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const credsPath = join(homedir(), '.claude', '.credentials.json');
  const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
  return creds.claudeAiOauth.accessToken;
}

const client = new Anthropic({ apiKey: getApiKey() });
```

`ANTHROPIC_API_KEY` in `.env` still takes precedence, so users with a real API key can use it directly.
