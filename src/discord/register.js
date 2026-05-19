/**
 * Register slash commands globally via Discord REST API.
 * Called once on startup — Discord caches commands globally (~1h propagation).
 * Safe to call on every restart; Discord deduplicates unchanged commands.
 */

import { REST, Routes } from 'discord.js';
import { commandDefs } from './commands.js';

export async function registerSlashCommands(token, clientId) {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    const data = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commandDefs },
    );
    console.log(`[discord] Registered ${data.length} slash commands globally`);
    return true;
  } catch (err) {
    console.warn('[discord] Slash command registration failed:', err.message);
    return false;
  }
}
