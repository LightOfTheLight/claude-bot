/**
 * Discord application command definitions.
 * Registered globally on startup via REST.
 * Handled in discord.js via Events.InteractionCreate.
 */

import { SlashCommandBuilder } from 'discord.js';

export const commandDefs = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot health, provider status, and your context size'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show your usage statistics')
    .addSubcommand((sub) =>
      sub.setName('me').setDescription('Your personal stats: messages, tool uses, active days')
    )
    .addSubcommand((sub) =>
      sub.setName('global').setDescription('Bot-wide stats (owner only)')
    ),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search your conversation history')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Search term').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('from')
        .setDescription('Filter by sender')
        .addChoices(
          { name: 'Me', value: 'me' },
          { name: 'Bot', value: 'bot' },
        )
    ),

  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Download your full conversation history')
    .addStringOption((opt) =>
      opt.setName('format')
        .setDescription('File format (default: Markdown)')
        .addChoices(
          { name: 'Markdown', value: 'md' },
          { name: 'JSON', value: 'json' },
        )
    ),

  new SlashCommandBuilder()
    .setName('pin')
    .setDescription('Add a permanent memory note the bot always keeps in mind')
    .addStringOption((opt) =>
      opt.setName('key').setDescription('Short label (e.g. role, project, style)').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('content').setDescription('What to remember').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unpin')
    .setDescription('Remove a pinned memory note')
    .addStringOption((opt) =>
      opt.setName('key').setDescription('The key to remove').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('pins')
    .setDescription('List all your pinned memory notes'),

  new SlashCommandBuilder()
    .setName('reminders')
    .setDescription('List your active reminders'),

  new SlashCommandBuilder()
    .setName('cancel_reminder')
    .setDescription('Cancel an active reminder')
    .addStringOption((opt) =>
      opt.setName('id').setDescription('Reminder short ID (first 8 chars from /reminders)').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('set')
    .setDescription('Save a user preference')
    .addStringOption((opt) =>
      opt.setName('key')
        .setDescription('Preference name')
        .setRequired(true)
        .addChoices(
          { name: 'timezone', value: 'timezone' },
          { name: 'digest_time', value: 'digest_time' },
          { name: 'auto_thread', value: 'auto_thread' },
          { name: 'rate_limit', value: 'rate_limit' },
        )
    )
    .addStringOption((opt) =>
      opt.setName('value').setDescription('Value to set').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('preferences')
    .setDescription('Show all your saved preferences'),

  new SlashCommandBuilder()
    .setName('forget')
    .setDescription('Remove recent messages from your context window')
    .addIntegerOption((opt) =>
      opt.setName('pairs')
        .setDescription('Number of message pairs to remove (default: 1)')
        .setMinValue(1)
        .setMaxValue(25)
    ),

  new SlashCommandBuilder()
    .setName('reset_context')
    .setDescription('Wipe your conversation context and start fresh'),

  new SlashCommandBuilder()
    .setName('webhook')
    .setDescription('Manage incoming webhooks')
    .addSubcommand((sub) =>
      sub.setName('create')
        .setDescription('Create a new webhook')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Webhook name (e.g. github, ci)').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List your active webhooks')
    )
    .addSubcommand((sub) =>
      sub.setName('delete')
        .setDescription('Delete a webhook')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Webhook name to delete').setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Owner: trigger a database backup now'),
].map((cmd) => cmd.toJSON());
