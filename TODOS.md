# claude-bot — Open Work Items

## P1

### [x] UNRESOLVED_INTENT concern template (Week 3)
**What:** New trigger template in `src/proactive/trigger.js` — Claude CLI call per user per hour to detect unresolved intents from recent conversations. Surfaces your own open loops: "You mentioned X unresolved 3 days ago — still relevant?"
**Why:** The core "second brain" feature. Deferred from Week 2 because it requires NLP design: intent extraction prompt, cost management, and per-user rate limiting on the Claude CLI call.
**Where to start:** `src/proactive/trigger.js` — add `UNRESOLVED_INTENT` template after the 4 DB-query templates are proven. Design the intent extraction prompt first.
**Effort:** M (human ~2 days / CC ~20 min)
**Depends on:** Proactive infrastructure from Week 1 + Week 2 must ship first.

---

## P2

### [x] BROKEN_STREAK concern template (Week 4+)
**What:** Add `BROKEN_STREAK` template to `src/proactive/trigger.js`. Fires when a skill used daily for 5+ days goes silent.
**Why:** Current `skills_generated` table records skill CREATION only — there is no data source for skill USE. The template cannot be implemented correctly without either a `skill_invocations` table (recording each invocation event) or a viable message_log keyword heuristic.
**Where to start:** Schema change first — add `skill_invocations (user_id, skill_name, invoked_at)` to `db.js` V10. Wire invocation tracking in the router when a skill is used. Then add the BROKEN_STREAK template in `trigger.js`.
**Effort:** M (human ~1 day / CC ~15 min)
**Depends on:** Proactive infrastructure (this PR) must ship first. Decision needed: real invocation table vs. message_log keyword heuristic.

### [x] EMA threshold visibility in Proactive dashboard
**What:** Add a "Current thresholds" panel to the Proactive tab in the dashboard showing the EMA value per template and feedback count from `proactive_feedback`.
**Why:** Without this, the EMA threshold tuning is a black box. If a cold-start goes wrong (a few early 👎 collapse the threshold), there's no way to see it without querying the DB directly.
**Where to start:** Extend `GET /api/proactive` to include `{ template, threshold, feedbackCount }[]` from `bot_state` + `proactive_feedback`. Surface in `dashboard.html` Proactive tab.
**Effort:** S (human ~2h / CC ~5 min)
**Depends on:** Proactive infrastructure (this PR) shipped with EMA feedback.

### [x] Add CLAUDE.md and TODOS.md to repo root
**What:** Create `CLAUDE.md` (project coding conventions, module map, adapter patterns) and ensure `TODOS.md` tracks open work.
**Why:** No project instructions = every AI assistant session starts cold. Costs time on re-discovery of existing patterns (dreaming.js style, scheduler patterns, etc.).
**Effort:** S (human ~30 min / CC ~5 min)

### [ ] Temporal advocate — future-self projection (Month 2)
**What:** Nightly projection engine: "Given patterns from the last 30 days, what will Thursday look like if nothing changes?" Surfaces preemptive restructuring suggestions before bad days happen. Not reminders — pattern-driven foresight.
**Why:** The 10x version of the proactive agent. Requires weeks of `proactive_sends` data + feedback ratings to be useful.
**Where to start:** New module `src/proactive/temporal.js`. Runs nightly (not hourly). Reads last 30 days of `proactive_sends`, `proactive_feedback`, `threads` activity. Passes to Claude CLI with projection prompt.
**Effort:** L (human ~1 week / CC ~1 day)
**Depends on:** `proactive_sends` table populated with real data; feedback EMA calibrated; `UNRESOLVED_INTENT` template shipped.

### [x] Sub-agent spawning in proactive dispatcher (Week 3+)
**What:** When a morning brief or concern trigger identifies a task too complex for a single-turn response, spawn a specialist Claude CLI subprocess, post result back to channel when done.
**Why:** Enables the proactive agent to take real actions, not just surface observations.
**Effort:** M (human ~1 day / CC ~15 min)
**Depends on:** Proactive infrastructure from Week 1 + Week 2 must ship first.
