import { EventEmitter } from 'node:events';

/**
 * Central event bus for internal bot events.
 *
 * Events:
 *   'skill:created'  { name, path }  — dreaming loop wrote a new SKILL.md
 */
const bus = new EventEmitter();
bus.setMaxListeners(20);

export default bus;
