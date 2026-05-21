/**
 * Tests that the Discord adapter's sendToChannel / sendDM contract returns
 * message.id (string) on success and null on failure.
 *
 * We test this with mock client stubs — no real Discord connection needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline the adapter contract (mirrors src/adapters/discord.js) ─────────────

function makeSendDM(client) {
  return async (discordUserId, text) => {
    try {
      const user = await client.users.fetch(discordUserId);
      const msg = await user.send(text);
      return msg.id;
    } catch (err) {
      return null;
    }
  };
}

function makeSendToChannel(client) {
  return async (channelId, text) => {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        const msg = await channel.send(text);
        return msg.id;
      }
      return null;
    } catch (err) {
      return null;
    }
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('sendDM returns message.id string on success', async () => {
  const fakeClient = {
    users: {
      fetch: async () => ({
        send: async () => ({ id: 'discord-message-id-123' }),
      }),
    },
  };
  const sendDM = makeSendDM(fakeClient);
  const result = await sendDM('some-user-id', 'hello');
  assert.equal(result, 'discord-message-id-123');
  assert.equal(typeof result, 'string');
});

test('sendDM returns null when fetch throws', async () => {
  const fakeClient = {
    users: {
      fetch: async () => { throw new Error('Unknown user'); },
    },
  };
  const sendDM = makeSendDM(fakeClient);
  const result = await sendDM('nonexistent', 'hello');
  assert.equal(result, null);
});

test('sendDM returns null when send throws', async () => {
  const fakeClient = {
    users: {
      fetch: async () => ({
        send: async () => { throw new Error('Cannot send message to this user'); },
      }),
    },
  };
  const sendDM = makeSendDM(fakeClient);
  const result = await sendDM('user1', 'hello');
  assert.equal(result, null);
});

test('sendToChannel returns message.id string on success', async () => {
  const fakeClient = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async () => ({ id: 'channel-message-id-456' }),
      }),
    },
  };
  const sendToChannel = makeSendToChannel(fakeClient);
  const result = await sendToChannel('channel-id', 'hello');
  assert.equal(result, 'channel-message-id-456');
  assert.equal(typeof result, 'string');
});

test('sendToChannel returns null when channel is not text-based', async () => {
  const fakeClient = {
    channels: {
      fetch: async () => ({
        isTextBased: () => false,
        send: async () => { throw new Error('Should not be called'); },
      }),
    },
  };
  const sendToChannel = makeSendToChannel(fakeClient);
  const result = await sendToChannel('voice-channel', 'hello');
  assert.equal(result, null);
});

test('sendToChannel returns null when fetch throws', async () => {
  const fakeClient = {
    channels: {
      fetch: async () => { throw new Error('Unknown channel'); },
    },
  };
  const sendToChannel = makeSendToChannel(fakeClient);
  const result = await sendToChannel('bad-channel', 'hello');
  assert.equal(result, null);
});

test('sendToChannel returns null when channel is null', async () => {
  const fakeClient = {
    channels: {
      fetch: async () => null,
    },
  };
  const sendToChannel = makeSendToChannel(fakeClient);
  const result = await sendToChannel('channel-id', 'hello');
  assert.equal(result, null);
});
