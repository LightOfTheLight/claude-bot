/**
 * Adapter interface contract.
 *
 * Every platform adapter must satisfy this shape.
 * Discord v1 is the reference implementation; Phase 2 adapters
 * (Telegram, Slack, etc.) must implement the same methods.
 *
 * @typedef {object} Adapter
 *
 * @property {function(handler: MessageHandler): void} onMessage
 *   Register a handler called for every incoming user message.
 *   The adapter is responsible for filtering bot messages and
 *   extracting clean text (e.g. stripping @mentions).
 *
 * @property {function(userId: string, text: string, opts?: SendOpts): Promise<void>} sendMessage
 *   Send a message to a user on this platform.
 *   userId is the platform-specific channel/chat ID, NOT the bot's user_id UUID.
 *
 * @property {function(text: string): Promise<void>} sendOwnerDM
 *   Send a DM to the bot owner (identified by OWNER_ID env var).
 *   Used for alerts (gateway health failures, skill confirmations).
 *
 * @typedef {function(ctx: MessageContext): Promise<void>} MessageHandler
 *
 * @typedef {object} MessageContext
 * @property {string} platformId   - platform-native user ID (e.g. Discord snowflake)
 * @property {string} platform     - 'discord' | 'telegram' | 'slack' | ...
 * @property {string} text         - cleaned message text
 * @property {function(string): Promise<void>} reply  - send a reply in the same channel
 * @property {function(): Promise<void>} sendTyping   - show typing indicator
 *
 * @typedef {object} SendOpts
 * @property {boolean} [dm]        - send as DM rather than in-channel
 */

// This file is JSDoc-only — no runtime exports needed.
// Adapters import from it only for documentation purposes.
export {};
