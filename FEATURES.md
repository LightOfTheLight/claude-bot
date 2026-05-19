# ClaudeBot v2 — Feature Log

All completed features in shipping order. Update this file when a feature lands.

---

## Core Bot Infrastructure

### Multi-platform adapter system
Adapter-per-platform design. Each platform starts independently; unrecognised or unconfigured adapters are skipped silently.
- Platforms supported: Discord, Slack, Telegram, WhatsApp, WeChat
- Auto-detection from env vars; or explicit `ADAPTERS=discord,slack` override
- Each adapter returns a handle with `sendOwnerDM`, `sendDM`, `sendToChannel`

### SQLite memory with rolling context
Persistent per-user conversation memory backed by `better-sqlite3`.
- Rolling window of last 50 messages per user
- LLM-generated summary triggered every 100 messages (`summarize.js`)
- `learnings` array: structured user insights stored per thread
- Append-only `message_log` table (v2 schema) for full audit trail

### Schema migrations (V1–V6)
Versioned migrations run automatically at startup; each version backs up before altering.
- V1: core tables — `users`, `threads`, `platform_ids`, `link_tokens`, `reminders`, `skills_generated`
- V2: `message_log` append-only table + backfill from existing threads
- V3: `bot_state` key-value store + `active_channels` table
- V4: `reminders.channel_id` for delivery routing
- V5: `reminders.recur` for recurring reminders
- V6: `message_fts` FTS5 virtual table + sync triggers + backfill (graceful fallback if FTS5 unavailable)
- V7: `webhooks` table for webhook integration

### Cross-platform identity linking
Users can merge identities across platforms using one-time tokens.
- `/link` — generates a 6-char token (10 min TTL)
- `/link <TOKEN>` on second platform — consumes token, merges `platform_ids` rows

---

## AI / Response Pipeline

### Claude CLI integration (`ALLOWED_PROVIDERS=cli`)
Spawns `claude` subprocess per message; full tool-use capabilities without API quota.
- Streams stdout chunks back to Discord in real-time (live message edits every 1.2s)
- `--dangerously-skip-permissions --permission-mode bypassPermissions` for unattended use
- Falls back to gateway if CLI fails and gateway is also enabled

### CLI session continuity (`--resume`)
Each user's CLI session ID is persisted in `bot_state` (`cli_session:<userId>`).
- Resume mode sends only the latest message; session retains full history
- Falls back gracefully to a fresh session if the stored ID has expired
- `/reset-context` also clears the stored session ID

### Activity-based inactivity timeout
No hard wall-clock timeout. CLI subprocess is monitored for output activity.
- Heartbeat fires every 15s; if no real output has arrived yet, posts/updates a `⏳ Still working… (Ns)` indicator
- Kills subprocess after 10 minutes of complete silence (`INACTIVITY_MS = 600_000`)
- Typing indicator refreshed every 8s to keep Discord's "Bot is typing…" alive

### AI gateway fallback
LiteLLM-based gateway (`ai-gateway` on port 4242) as secondary provider.
- `gateway-manager.js` syncs OAuth tokens from `~/.claude/.credentials.json` and spawns the gateway process
- Health-checked on startup; owner DM alert sent if unreachable
- Proactive OAuth token refresh every 30 min (scheduler job) — refreshes if token expires within 35 min

### Streaming file uploads via `[FILE:path]` tag
Bot can upload any local file to Discord as an attachment.
- Include `[FILE:/absolute/path]` anywhere in the response
- Adapter strips the tag, builds an `AttachmentBuilder`, sends as Discord attachment
- Streaming placeholder is deleted and replaced with a clean file message

### Emoji reactions via `[REACT:emoji]` tag
Bot can react to the user's message with an emoji.
- Include `[REACT:👍]` in the response; used sparingly for meaningful signal only
- Unused for generic friendliness; documented in system prompt

---

## Discord Adapter

### Real-time message streaming
CLI stdout chunks are edited into a live Discord message as they arrive.
- Edits throttled to once per 1.2s to stay within Discord rate limits
- Long responses (>2000 chars) automatically chunked into multiple messages

### Attachment handling (voice, images, files)
Discord attachments are downloaded to a local temp dir before passing to the CLI.
- `downloadAttachment()` saves to `/tmp/claude-bot-attachments/<id>_<name>`
- Local path injected into the prompt so CLI can read/transcribe directly
- Handles messages that are attachments-only (no text body)

### Catch-up on missed messages
On startup, scans all known active channels for messages sent while the bot was offline.
- Uses `lastOnline` from `bot_state` to compute the catch-up window
- Converts timestamps to Discord snowflakes for efficient `after:` pagination
- Answers only the last unanswered directed message per channel; skips if bot already replied

### Reply context injection
When a user replies to a specific message, the referenced message content is prepended to the prompt.
- Format: `[Replying to <author>: "<first 300 chars>"]`

### Emoji reaction → text responses
Reacting to a bot message with a mapped emoji sends a synthetic text message.
- Mapped emojis: 👍/✅ → "yes", 👎/❌ → "no", 1️⃣–5️⃣ → "1"–"5"
- Bypasses command handling (`skipCommands: true`) to avoid `/reset-context` false triggers

### Deduplication guard
In-flight message ID set prevents processing the same `MessageCreate` event twice.

---

## Built-in Commands

| Command | Description |
|---|---|
| `/status` | Uptime, provider list, gateway health, context size, CLI session ID |
| `/restart` | Owner-only — graceful restart (spawns new process, exits current) |
| `/reset-context` | Wipes thread messages, summary, learnings, and CLI session |
| `/forget <n>` | Removes last n message pairs from rolling window |
| `/learnings` | Lists all stored user insights |
| `/forget-learning <key>` | Removes a specific learning by key |
| `/clear-summary` | Clears the LLM-generated summary |
| `/link` | Generates a cross-platform identity link token |
| `/link <TOKEN>` | Consumes a token to merge platform identities |
| `/reminders` | List all active reminders with next fire time in user's local timezone |
| `/cancel-reminder <id>` | Cancel a reminder by short ID (first 8 chars) |
| `/pin <key> <content>` | Add or update a permanent memory note |
| `/pins` | List all pinned notes |
| `/unpin <key>` | Remove a pinned note |
| `/webhook create <name>` | Create a webhook — returns URL + bearer token |
| `/webhook list` | List your active webhooks |
| `/webhook delete <name>` | Deactivate a webhook |
| `/backup` | Owner: trigger database backup now, report path and size |
| `/broadcast <message>` | Owner: post announcement to all active channels |
| `/broadcast dm <message>` | Owner: DM all known Discord users |
| `/stats` | Personal usage stats: messages, tool uses, active days, reminders |
| `/stats global` | Owner-only: bot-wide user counts, message totals, top users |
| `/export` | Download full conversation history as a Markdown file |
| `/export json` | Download full conversation history as JSON |
| `/search <query>` | Full-text search across conversation history; add `from:me` or `from:bot` to filter |
| `/preferences` | Show all saved user preferences |
| `/set <key> <value>` | Save a preference (e.g. `/set timezone Asia/Singapore`, `/set auto_thread false`) |
| `/unset <key>` | Remove a preference |
| `/approve-skill <id>` | Approves a dreaming-generated skill (owner) |
| `/reject-skill <id>` | Rejects a dreaming-generated skill (owner) |

---

## Scheduler

### Daily digest check (every 1 min)
Runs `_runDigests()` — iterates users with `digest_time` set, compares current HH:MM in their timezone, sends if matched and not already sent today.

### Gateway health check (every 10 min)
Calls `checkGatewayHealth()`; sends owner DM alert if unreachable.

### Reminder delivery (every 1 min)
Fires due reminders with 3-tier routing:
1. `sendToChannel(channel_id)` — deliver to the channel where the reminder was set
2. `sendDM(platform_id)` — DM the user directly via their platform snowflake
3. `sendOwnerAlert` — fallback if all else fails

### OAuth token refresh (every 30 min)
Checks token expiry; calls `syncAndRestart()` if expiring within 35 min.

### Dreaming curator (every hour at :30)
Calls `dreaming.reviewCandidates()` to process post-session skill generation candidates.

---

## User Preferences

### Per-user preferences store
User preferences are persisted in the `users.preferences` JSON column (existing column, no migration needed).
- `getPreference(userId, key)` / `setPreference(userId, key, value)` / `getAllPreferences(userId)` helpers in `memory/index.js`
- `/set <key> <value>` — save any preference; `/unset <key>` to remove; `/preferences` to list all
- Preferences are per internal `user_id`, so they persist across platforms for linked identities

### Automated database backup
Hot, consistent SQLite backups using `better-sqlite3`'s built-in `.backup()` — safe with WAL mode, no locks, no downtime.

- **Startup backup**: runs immediately after every bot start (post-migration), so there's always a pre-restart snapshot
- **Scheduled**: every 6 hours via cron (`0 */6 * * *`)
- **Retention**: keeps last 14 backups (configurable via `BACKUP_KEEP` env var); older files pruned automatically
- **Location**: `data/backups/claudebot-YYYY-MM-DD-HHMM.db`
- **Owner DM alert**: sent if a scheduled backup fails
- `/backup` command: owner-only, triggers immediately, reports file path, size, and duration
- `/status` (owner view) shows: `💾 Last backup: 2h ago`
- Last backup timestamp persisted in `bot_state` (`lastBackupAt`, `lastBackupPath`) — survives restarts

### Discord slash commands
Proper Discord application commands registered on every startup — users see autocomplete, parameter hints, and command descriptions by typing `/` in any channel.

**Registered commands (14 total):**
`/status`, `/stats me`, `/stats global`, `/search`, `/export`, `/pin`, `/unpin`, `/pins`, `/reminders`, `/cancel_reminder`, `/set`, `/preferences`, `/forget`, `/reset_context`, `/webhook create|list|delete`

**Architecture:**
- `src/discord/commands.js` — `SlashCommandBuilder` definitions with descriptions, options, choices, and subcommands
- `src/discord/register.js` — REST `PUT applicationCommands` call on every `ClientReady`; Discord deduplicates unchanged commands so restarts are safe
- `Events.InteractionCreate` handler in `discord.js` — defers reply immediately (3s window), translates interaction options to the existing text-command strings, calls `handleCommand` with the same path as text commands
- Existing text commands (`/pin key content`, etc.) still work — slash commands are an additive layer

### Pinned memories
User-controlled permanent notes injected into every AI context, surviving rolling window compression and session restarts.

Stored in `users.preferences.pins` as a `{ key: content }` map — no new migration needed.

- `/pin <key> <content>` — add or update a note (key max 40 chars, any content length). Examples:
  - `/pin role Senior backend engineer at Acme, mainly Node.js and Go`
  - `/pin project Building ClaudeBot v2 — Discord + Telegram, SQLite backend`
  - `/pin style Prefer concise answers with code examples over long explanations`
- `/pins` — list all pins with keys and content
- `/unpin <key>` — remove a pin; clears the `pins` key entirely when last pin removed
- Pins appear in the system prompt as **"Always keep in mind:"** section, above the conversation summary and learnings — highest-priority persistent context

Completes the four-layer memory model:
1. **Rolling window** — last 50 messages (recency)
2. **Summary** — LLM-compressed past (breadth)
3. **Learnings** — AI-inferred user insights (inference)
4. **Pins** — user-explicit permanent notes (authority)

### Webhook integration
Turns the bot into a personal notification hub. Any external service (GitHub, CI/CD, monitoring, Jira) can POST a message and have it delivered to your Discord.

**HTTP endpoint:** `POST /hook/:webhookId`
- `Authorization: Bearer <token>` header required
- Body: `{ "message": "...", "title": "optional title" }`
- Rate limited: 20 calls per minute per webhook
- Returns `{ ok: true, delivered: boolean }`

**Discord commands:**
- `/webhook create <name>` — generates a webhook URL + bearer token, shows a ready-to-use `curl` example
- `/webhook list` — shows all active webhooks with URL, creation date, last-used date
- `/webhook delete <name>` — deactivates a webhook

**Delivery routing:**
1. Discord DM via the user's `platform_id`
2. Most-recently-active channel fallback
3. Owner alert as last resort

**Config:** Set `WEBHOOK_BASE_URL=https://yourserver.com` in `.env` so generated URLs are publicly reachable. Defaults to `http://localhost:3000`.

**Schema V7:** `webhooks` table with `id`, `user_id`, `name`, `token`, `created_at`, `last_used`, `active`.

### Admin broadcast (`/broadcast`)
Owner-only command to push a message to all active channels or all known users.
- `/broadcast <message>` — posts to every channel in `active_channels` (all channels the bot has been active in)
- `/broadcast dm <message>` — DMs every user with a Discord `platform_id` in the DB
- Reports delivery in two steps: first `Broadcasting to N…`, then `📣 Done: X delivered, Y failed`
- Message is prefixed with `📣 **Broadcast from owner:**` so recipients know it's an announcement
- Uses the module-level `_client` reference set in `start()` — no extra routing needed
- Owner-only: rejected with `⛔` for anyone else

### Usage statistics (`/stats`)
Personal and global usage stats drawn from `message_log`, `threads`, and `reminders`.

**`/stats`** — personal view:
- Messages sent (total, this week, this month), bot replies, tool uses triggered
- Active days + average messages per active day
- First message date, active reminder count
- Current rate limit usage snapshot

**`/stats global`** — owner-only bot-wide view:
- Total users, active last 7d / 30d
- Total messages across all users, total tool uses
- Reminder counts (active vs total)
- Bot uptime
- Top 5 most active users by message count

No new schema or migrations needed — all queries run against existing tables.

### Rate limiting
Per-user sliding-window rate limiter protecting against quota exhaustion and spam.
- **Two guards**: minimum cooldown between consecutive messages (default 2s) + sliding window cap (default 15 msg / 60s)
- **Config via env vars**: `RATE_LIMIT_PER_WINDOW`, `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_COOLDOWN_SEC`, `RATE_LIMIT_MAX_BURST`
- **Owner always exempt** — `OWNER_ID` bypasses all checks
- **User-adjustable cap**: `/set rate_limit 20` raises a user's personal window limit (capped at `RATE_LIMIT_MAX_BURST`, default 60)
- **Clear error messages**: cooldown gives exact seconds to wait; window exhaustion shows slot-open time
- `/status` shows current usage: `X/Y messages used in last Zs window`
- State is in-memory (resets on restart — intentional fresh start per bot bounce)
- Rate limit state cleared on `/reset-context`

### Conversation export (`/export`)
Download full conversation history as a file attachment directly in Discord.
- `/export` or `/export md` — clean Markdown file: header with export date/timezone + message count, then each message as a section with speaker, platform, timestamp, and content
- `/export json` — structured JSON with ISO timestamps, suitable for scripting or import into other tools
- File is written to a temp path, uploaded via `AttachmentBuilder`, then immediately deleted from disk
- Timestamps rendered in the user's configured timezone (falls back to UTC)
- Works on the full `message_log` (not just the rolling window), so users get their complete history

### Message search (`/search`)
Full-text search across a user's entire conversation history stored in `message_log`.
- **FTS5 path** (default): SQLite FTS5 virtual table `message_fts` with porter stemmer — "run" matches "running", "ran". Snippets use `snippet()` with `**bold**` highlighting around matched terms.
- **LIKE fallback**: if FTS5 wasn't compiled into the SQLite binary, falls back to `LIKE %query%` with a manual 100-char snippet window.
- **V6 migration**: creates the FTS virtual table, three sync triggers (`AFTER INSERT/DELETE/UPDATE`), and backfills all existing messages.
- **Role filter**: append `from:me` or `from:bot` to restrict results — e.g. `/search deploy from:me`
- Results show up to 5 matches with timestamp (in user's timezone), speaker icon (🧑/🤖), and highlighted snippet.

### Auto-thread in guild channels
When the bot is mentioned in a guild text channel (not a DM, not already a thread), it automatically starts a Discord thread on that message and routes the entire conversation there.
- Thread name = first 60 chars of the message text
- Auto-archive after 1 day of inactivity
- New thread tracked in `active_channels` immediately — catch-up and `botInThread` routing work from the first reply
- First reply is anchored to the original message (so the thread is visible); subsequent streaming edits go directly to the thread
- Graceful fallback to channel reply if thread creation fails (e.g. missing `CREATE_PUBLIC_THREADS` permission)
- Opt out per-user: `/set auto_thread false`

### User timezone
IANA timezone preference (e.g. `Asia/Singapore`, `America/New_York`).
- Validated on save via `Intl.DateTimeFormat` — rejects unknown timezone names with a helpful error
- System prompt updated with user's timezone and current local time so the bot converts natural language times ("tomorrow 9am", "Friday at 3pm") to UTC correctly
- `/reminders` shows all fire times in the user's local timezone instead of UTC
- Defaults to UTC if not set

### Daily digest
A morning briefing DM sent automatically at a user-configured time.
- Enable with `/set digest_time 08:30` (24h, in the user's configured timezone)
- Sent once per calendar day; duplicate suppressed via `bot_state` key `digest:<userId>:<YYYY-MM-DD>`
- Content: greeting matched to time of day (morning/afternoon/evening) + **Today** reminders + **Coming up (next 7 days)** reminders with recurrence labels
- Delivered via DM on each registered platform (Discord preferred); falls back to owner alert
- Disable by `/unset digest_time`

---

## Reminders

### One-off and recurring reminders via `[REMINDER:timestamp:recur:message]` tag
Bot includes a `[REMINDER:...]` tag in its response when the user asks for a reminder.
- Syntax: `[REMINDER:2026-05-20T10:00:00Z:none:Call John]` (one-off) or `[REMINDER:2026-05-19T09:00:00Z:daily:Stand-up]` (recurring)
- `recur` values: `none`, `hourly`, `daily`, `weekly`, `monthly`
- Adapter parses the tag, strips it from visible text, calls `createReminder()` with `recur` field
- Recurring reminders are rescheduled automatically by the scheduler (`markReminderFired` advances `fire_at` instead of setting `fired=1`)
- Schema V5 migration adds `recur TEXT` column to `reminders`
- `/reminders` — list all active reminders with short ID, next fire time, and recurrence label
- `/cancel-reminder <short-id>` — cancel by first 8 chars of UUID (scoped to requesting user)

### Request trace dashboard (Apigee-style)
A live single-page UI at `GET /dashboard` that shows every message flowing through the bot pipeline — similar to Google Apigee's trace tool.

**Pipeline steps instrumented (in order):**
1. `identity` — `getOrCreateUser()` resolves the canonical userId from platform + platformId
2. `command_check` — checks if message is a built-in command (`/status`, `/pin`, etc.); marks as `skip` if handled
3. `rate_limit` — sliding window check; marks `block` + records reason if rejected
4. `context_fetch` — loads rolling history, summary, learnings, timezone, pins
5. `ai_call` — CLI or gateway call; records provider, token counts, response length, total duration
6. `tag_extraction` — parses `[REACT:]`, `[FILE:]`, `[REMINDER:]` tags from AI response
7. `delivery` — sends reply to Discord (streaming edits, file uploads, reactions)
8. `memory_persist` — `appendMessage()` + `incrementToolUse()`

**UI features:**
- Auto-refreshing sidebar (2s interval) listing last 80 traces with status badge, duration, platform, timestamp
- Click any trace → right panel shows: summary card (traceId, platform, userId, duration, error) + pipeline step cards + waterfall chart
- Per-step cards: colored status dot, duration bar scaled to total, all metadata key-values
- Waterfall chart shows relative timing of each step across the full request duration
- Live health bar: uptime, requests in last 5 min, error count
- Filter by status (ok / error / rate_limited / command / running) + free-text search
- Pause/resume live refresh toggle
- Optional `DASHBOARD_TOKEN` env var for bearer-token protection (`?token=` or `Authorization: Bearer`)

**Files:**
- `src/trace/index.js` — in-memory ring buffer (200 traces), `createTrace`, `recordStep`, `finalizeTrace`, `getTraces`, `getTrace`, `getTraceSummary`
- `src/dashboard/index.js` — Express routes: `GET /dashboard`, `GET /api/traces`, `GET /api/traces/:id`, `GET /api/health`
- `src/dashboard/dashboard.html` — dark-theme SPA, no external dependencies

---

## Observability

### OpenTelemetry metrics + traces
- Metrics exported on `:9464` (Prometheus scrape endpoint)
- Traces exported to `http://localhost:4318/v1/traces` (OTLP/HTTP)
- Counters: `gateway_failures_total`, `reminders_fired_total`
- Gauge: `bot_active_threads` (threads active in last 24h, observed from DB)
- Spans: `bot.message.receive`, `gateway.health_check`, `reminder.fire`

---

## Operations

### Persistent append-mode logging (`start.sh`)
`start.sh` redirects stdout+stderr to `data/bot.log` in append mode (`>>`).
- Restart separator banner printed at each start: `*** BOT STARTING — <ISO timestamp> ***`
- Log survives restarts; easy to grep across sessions

### Graceful shutdown with `lastOnline` persistence
`SIGTERM` / `SIGINT` handlers call `setBotState('lastOnline', timestamp)` before exiting.
- Used by catch-up logic on next boot to know the offline window

### `/restart` Discord command
Owner-only command for fast in-chat bot restarts.
- Sends confirmation, spawns a detached `bash -c "sleep 2 && node src/index.js"`, exits current process
- New process starts 2s after port 3000 is freed — no race condition
