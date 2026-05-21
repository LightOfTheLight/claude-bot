# claude-bot — Project Conventions

## Module Map

```
src/
├── index.js                  — entry point: startup sequence, adapter wiring, platformSenders
├── adapters/
│   ├── discord.js            — Discord.js v14 adapter; message pipeline + slash commands
│   ├── slack.js              — Slack Bolt adapter
│   ├── telegram.js           — Telegram Bot API adapter
│   ├── whatsapp.js           — WhatsApp Cloud API webhook adapter
│   ├── wechat.js             — Wechaty adapter
│   └── interface.js          — shared adapter type docs (not imported at runtime)
├── core/
│   ├── claude.js             — callGateway(), checkGatewayHealth(), Claude CLI helpers
│   ├── gateway-manager.js    — syncAndRestart(): syncs OAuth tokens, starts ai-gateway process
│   ├── rate-limiter.js       — per-user token-bucket rate limiting
│   └── events.js             — internal EventEmitter bus (message, reaction, etc.)
├── memory/
│   ├── db.js                 — SQLite (better-sqlite3), initDb(), schema migrations V1–V10
│   ├── index.js              — getContext(), saveMessage(), getProactiveUsers(),
│   │                           recordSkillInvocation(), setBotState(), …
│   └── summarize.js          — LLM-based thread summarization
├── proactive/
│   ├── index.js              — runScheduled(): hour-gated briefs + concern checks, dedup, semaphore
│   ├── trigger.js            — checkAll(userId): 5 concern templates in parallel
│   ├── templates.js          — buildBriefPrompt(), buildConcernPrompt()
│   ├── feedback.js           — EMA threshold tuning, handleReaction()
│   └── subagent.js           — shouldSpawnSubAgent(), runSubAgent(): async Claude CLI follow-up
├── dreaming/
│   ├── index.js              — reviewCandidates(), approveSkill(); runs after idle silence
│   ├── quality.js            — LLM skill quality gate
│   └── template.js           — skill SKILL.md template generator
├── router/
│   ├── index.js              — classifyIntent(): reminder | skill_dispatch | none
│   └── skills-map.js         — name → skill path registry
├── skills/
│   └── runner.js             — runSkill(name, ctx): executes a skill SKILL.md via Claude CLI
├── scheduler/
│   └── index.js              — node-cron jobs: dreaming + proactive (per-minute)
├── dashboard/
│   ├── index.js              — Express routes: /dashboard, /api/traces, /api/dreaming,
│   │                           /api/proactive, /api/health
│   └── dashboard.html        — SPA: Traces, Dreaming, Proactive tabs
├── trace/
│   └── index.js              — in-memory + SQLite trace store (getTrace, getTraces, …)
├── backup/
│   └── index.js              — runBackup(): SQLite hot-copy to ./data/backups/
├── webhooks/
│   └── index.js              — registerWebhookRoutes(app, {platformSenders, sendOwnerAlert})
├── discord/
│   ├── commands.js           — slash command definitions (data arrays)
│   └── register.js           — one-shot slash command registration script
├── media/
│   ├── transcribe.js         — Whisper transcription for voice messages
│   └── vision.js             — image description via Claude vision
├── response/
│   └── discord.js            — Discord message chunking / formatting helpers
└── telemetry/
    └── index.js              — lightweight event telemetry (optional)
```

## Startup Sequence (`src/index.js`)

1. `initDb()` — migrations V1→V10, WAL mode
2. `initTraceStore()` — load persisted traces into memory
3. `runBackup()` — hot-copy backup on startup
4. `syncAndRestart()` (gateway-manager) — sync OAuth tokens, start ai-gateway; falls back to `checkGatewayHealth()`
5. `startAdapters(adapters)` — populates `platformSenders` and `ownerDMHandles`
6. `startScheduler({ sendOwnerAlert, platformSenders })` — registers cron jobs
7. `registerWebhookRoutes(app, { platformSenders, sendOwnerAlert })`
8. `registerDashboardRoutes(app)`

Adapter list resolved from `ADAPTERS` env var or auto-detected from token presence.

## platformSenders Pattern

```js
// Shape: platform → { sendDM, sendToChannel }
const platformSenders = {
  discord: {
    sendDM: (userId, text) => Promise<string|null>,       // returns discord_message_id or null
    sendToChannel: (channelId, text) => Promise<string|null>,
  },
};

// Owner alerts: broadcast to all ownerDMHandles collected from adapters
async function sendOwnerAlert(text) { … }
```

Both `sendDM` and `sendToChannel` return the platform message ID (string) on success, `null` on failure. The proactive layer uses the returned ID as `discord_message_id` for reaction-based feedback.

## Discord Adapter Message Pipeline (`src/adapters/discord.js`)

1. Ignore bots, DM-only enforcement, rate limit check
2. Slash command dispatch (`handleCommand`)
3. Fetch context (thread history, memory summary, learnings)
4. **Step 4b — intent router** (gateway path only):
   - `classifyIntent(text, recentHistory)` → `reminder | skill_dispatch | none`
   - Reminder: create reminder, short-circuit reply
   - `skill_dispatch`: set `_routedSkill`, call `runSkill()` + `recordSkillInvocation()`
5. AI call: `callGateway({ messages, system })` or `runSkill()` if routed
6. Save assistant message, update trace, send response

Reaction handler (`messageReactionAdd`) checks `proactiveFeedback.handleReaction()` first; returns early if matched.

## DB Schema (V1–V10)

| Version | Tables added |
|---------|-------------|
| V1 | `users`, `threads`, `learnings` |
| V2 | `message_log` (append-only) |
| V3 | `bot_state`, `active_channels` |
| V4 | `reminders` + `channel_id` |
| V5 | `reminders.recur` (recurring) |
| V6 | `message_log_fts` (FTS5) |
| V7 | `webhooks` |
| V8 | `traces` |
| V9 | `proactive_sends`, `proactive_feedback`, `skills_generated.content` |
| V10 | `skill_invocations` |

DB path: `./data/claudebot.db` (override with `DB_PATH` env var). WAL mode + `foreign_keys = ON`.

When adding a new migration: increment `SCHEMA_VN`, set `TARGET_VERSION = SCHEMA_VN`, add `migrateVN(db)` function, add `if (version < SCHEMA_VN) migrateVN(_db)` in `initDb()`.

## Proactive System

**Entry:** `src/scheduler/index.js` runs a per-minute cron → `proactive.runScheduled(platformSenders, sendOwnerAlert)`

**Flow:**
1. `runScheduled`: iterates `getProactiveUsers()`, fires morning brief (07:00 UTC) or nightly sync (21:00 UTC) once per day; then calls `runConcernChecks()` for each user
2. `runConcernChecks`: calls `checkAll(userId)` → returns up to 5 hits filtered by EMA threshold; sends top hit via `sendDM`
3. Dedup: only inserts `proactive_sends` row when `discord_message_id` is non-null; 20h dedup window per user+template

**Concern templates (5):**
| Template | Trigger | Data source |
|----------|---------|-------------|
| `UNRESOLVED_THREAD` | Thread >5 msgs, silent >48h | `threads` table |
| `REPEATED_QUESTION` | Keyword ≥3× in last 30 messages | `message_log` |
| `LONG_SILENCE` | No messages in >72h | `message_log` |
| `UNRESOLVED_INTENT` | Claude CLI intent extraction (1×/hour/user) | `message_log` (last 20 msgs, 3-day window) |
| `BROKEN_STREAK` | Skill used ≥5 consecutive days, silent >24h | `skill_invocations` |

**EMA threshold tuning:**
- Initial: 0.7 per template, stored in `bot_state` key `proactive_threshold_{TEMPLATE}`
- Formula: `Math.max(0.3, Math.min(0.95, 0.8 * old + 0.2 * ratingNorm))`
- 👍 = ratingNorm 1.0 (raises threshold — be more selective), 👎 = 0.0 (lowers it)
- Feedback stored in `proactive_feedback`, trigger: reaction on the proactive message

## Dreaming System (`src/dreaming/`)

Runs after a user thread goes idle (>2h since last message, >5 tool-use events, `dreamed=0`). Generates a skill SKILL.md candidate from the conversation. Skill candidates stored in `skills_generated` with `status: pending|approved|auto-kept|rejected`. Dashboard Dreaming tab shows candidates and approve/reject controls.

`approveSkill()` reads `content` from `skills_generated`, writes to `~/.claude/skills/{name}/SKILL.md`.

After dreaming each thread, `runConcernChecks()` is called for that user (concern check piggybacked on dreaming loop).

## Skill Invocation Router

`classifyIntent(text, history)` in `src/router/index.js` classifies incoming messages. On `skill_dispatch`, `runSkill(name, ctx)` in `src/skills/runner.js` executes the skill via Claude CLI and `recordSkillInvocation(userId, skillName)` writes to `skill_invocations` (feeds BROKEN_STREAK detection).

## Key Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DISCORD_BOT_TOKEN` | Discord adapter | — |
| `DISCORD_CLIENT_ID` | Slash command registration | — |
| `DISCORD_OWNER_ID` | Owner DM for alerts | — |
| `DISCORD_DM_ONLY` | `true` = DM-only mode | `false` |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | Slack adapter | — |
| `TELEGRAM_BOT_TOKEN` | Telegram adapter | — |
| `GATEWAY_URL` | ai-gateway base URL | `http://localhost:4242` |
| `GATEWAY_TOKEN` | Bearer token for gateway | — |
| `USE_GATEWAY` | `true` = use gateway, `false` = direct Claude CLI | `true` |
| `DB_PATH` | SQLite file path | `./data/claudebot.db` |
| `PORT` | HTTP server port | `3000` |
| `DASHBOARD_TOKEN` | Bearer token for dashboard (unset = open) | — |
| `PROACTIVE_ENABLED` | `true` = run proactive cron | `true` |
| `PROACTIVE_MORNING_HOUR` | UTC hour for morning brief | `7` |
| `PROACTIVE_NIGHT_HOUR` | UTC hour for nightly sync | `21` |
| `PROACTIVE_SUBAGENT_ENABLED` | `true` = spawn follow-up sub-agents for high-confidence hits | unset (off) |
| `SUBAGENT_TEMPLATES` | Comma-separated eligible templates | `UNRESOLVED_INTENT,UNRESOLVED_THREAD` |
| `SUBAGENT_MIN_CONFIDENCE` | Confidence floor to spawn sub-agent | `0.85` |
| `ADAPTERS` | Comma-separated override (`discord,slack`) | auto-detected |

## Coding Conventions

- **ESM throughout**: `import`/`export`, `.js` extensions on all local imports
- **`better-sqlite3`**: synchronous DB API; all DB calls are sync (no `await` on queries)
- **Lazy imports**: adapters and optional modules imported with dynamic `import()` inside `try/catch` so missing modules don't crash startup
- **Error boundaries**: every cron job and adapter start wrapped in try/catch; errors logged, never thrown to the event loop
- **No global state** except `_db` in db.js and in-memory trace store; pass `platformSenders` and `sendOwnerAlert` as function arguments
- **Trace IDs**: format `t{timestamp}-{counter}` (e.g. `t1779336449868-4`); set early in message handler
- **`bot_state` table**: generic key-value store for persistent bot state (EMA thresholds, rate-limit timestamps, `lastOnline`, etc.)
- **Schema changes**: always add a new `SCHEMA_VN` constant + `migrateVN` function; never modify existing migration functions
- **`spawnSync` for Claude CLI**: used in `checkUnresolvedIntent` and dreaming; always set `timeout` and check `result.status`
- **Return message IDs**: `sendDM` / `sendToChannel` return the platform message ID string (or `null`), not a boolean
