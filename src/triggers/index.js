/**
 * Local triggers — provider-agnostic saved prompts that run on demand or on a cron schedule.
 * State stored in SQLite (triggers table). Execution routed through the bot's AI pipeline.
 */

import cron from 'node-cron';
import { getAllScheduledTriggers, getTriggerById, recordTriggerRun } from '../memory/index.js';

// Map of triggerId -> cron.ScheduledTask
const _cronJobs = new Map();

let _platformSenders = {};
let _sendOwnerAlert = async () => {};

export function setTriggerContext(platformSenders, sendOwnerAlert) {
  _platformSenders = platformSenders;
  _sendOwnerAlert  = sendOwnerAlert;
}

/**
 * Execute a trigger by ID. Calls the AI pipeline and delivers to the trigger's channel.
 * Returns { ok, text, error }.
 */
export async function runTrigger(triggerId) {
  const trigger = getTriggerById(triggerId);
  if (!trigger) return { ok: false, error: 'Trigger not found' };
  if (!trigger.enabled) return { ok: false, error: 'Trigger is disabled' };

  try {
    const { callGateway, callClaudeCLI } = await import('../core/claude.js');
    const providers   = new Set((process.env.ALLOWED_PROVIDERS ?? 'cli,anthropic,openai,gemini').split(',').map((s) => s.trim()));
    const USE_CLI     = providers.has('cli');
    const USE_GATEWAY = providers.has('anthropic') || providers.has('openai') || providers.has('gemini');

    let text;
    if (USE_CLI) {
      const result = await callClaudeCLI({ messages: [{ role: 'user', content: trigger.prompt }], system: '' });
      text = result.text;
    } else {
      const result = await callGateway({ messages: [{ role: 'user', content: trigger.prompt }], system: '' });
      text = result.text;
    }

    recordTriggerRun(triggerId);

    // Deliver result
    if (trigger.channel_id && trigger.platform) {
      const sender = _platformSenders[trigger.platform];
      if (sender?.sendToChannel) {
        await sender.sendToChannel(trigger.channel_id, `**[Trigger: ${trigger.name}]**\n${text}`);
        return { ok: true, text };
      }
    }

    // Fallback to owner alert
    await _sendOwnerAlert(`**[Trigger: ${trigger.name}]**\n${text}`);
    return { ok: true, text };
  } catch (err) {
    console.error(`[triggers] runTrigger ${triggerId} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Register a cron job for a trigger. Replaces any existing job for the same ID.
 */
export function registerTriggerCron(trigger) {
  if (!trigger.schedule || !cron.validate(trigger.schedule)) {
    console.warn(`[triggers] Invalid cron schedule for trigger ${trigger.id}: "${trigger.schedule}"`);
    return false;
  }
  unregisterTriggerCron(trigger.id);
  const job = cron.schedule(trigger.schedule, () => {
    runTrigger(trigger.id).catch((err) =>
      console.error(`[triggers] Scheduled run failed for ${trigger.id}:`, err.message)
    );
  });
  _cronJobs.set(trigger.id, job);
  console.log(`[triggers] Registered cron for trigger ${trigger.id} (${trigger.name}): ${trigger.schedule}`);
  return true;
}

/**
 * Stop and remove the cron job for a trigger.
 */
export function unregisterTriggerCron(triggerId) {
  const job = _cronJobs.get(triggerId);
  if (job) {
    job.stop();
    _cronJobs.delete(triggerId);
  }
}

/**
 * Load all enabled scheduled triggers from DB and register their cron jobs.
 * Called once on bot startup.
 */
export function loadScheduledTriggers() {
  const triggers = getAllScheduledTriggers();
  for (const t of triggers) registerTriggerCron(t);
  console.log(`[triggers] Loaded ${triggers.length} scheduled trigger(s)`);
}
