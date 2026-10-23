import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { WatchRoom } from '../src/index.js';

afterEach(async () => { await reset(); });

async function createRoom(username = 'Host') {
  const response = await exports.default.fetch('http://localhost:8787/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ username, roomName: 'Test night' })
  });
  return { response, data: await response.json() };
}

async function joinRoom(roomId, username) {
  const response = await exports.default.fetch(`http://localhost:8787/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ username })
  });
  return { response, data: await response.json() };
}

describe('Cloudflare room backend', () => {
  it('allows local development origin but fails closed for unconfigured production origins', async () => {
    const local = await exports.default.fetch('http://localhost:8787/health', {
      headers: { origin: 'http://localhost:5173' }
    });
    const production = await exports.default.fetch('https://watch-party.workers.dev/health', {
      headers: { origin: 'https://unknown-site.example' }
    });
    expect(local.status).toBe(200);
    expect(production.status).toBe(403);
  });

  it('creates unique named rooms and returns the host session', async () => {
    const first = await createRoom();
    const second = await createRoom('Second host');
    expect(first.response.status).toBe(201);
    expect(first.data.room.name).toBe('Test night');
    expect(first.data.room.roomId).toMatch(/^[A-F0-9]{12}$/);
    expect(first.data.room.participants[0].role).toBe('host');
    expect(first.data.token).toBeTruthy();
    expect(second.data.room.roomId).not.toBe(first.data.room.roomId);
  });

  it('validates room membership and keeps rooms isolated', async () => {
    const { data: first } = await createRoom();
    const { data: second } = await createRoom('Other host');
    const joined = await joinRoom(first.room.roomId, 'Guest');
    const missing = await joinRoom('FFFFFFFFFFFF', 'Nobody');
    expect(joined.response.status).toBe(200);
    expect(joined.data.room.participants.map(person => person.username)).toEqual(['Host', 'Guest']);
    expect(joined.data.messages).toHaveLength(0);
    expect(joined.data.room.roomId).toBe(first.room.roomId);
    expect(missing.response.status).toBe(404);
    expect(second.room.roomId).not.toBe(first.room.roomId);
  });

  it('requires a valid room session before accepting room commands', async () => {
    const { data } = await createRoom();
    const missingAuth = await exports.default.fetch(`http://localhost:8787/api/rooms/${data.room.roomId}/ws`, {
      headers: { upgrade: 'websocket', origin: 'http://localhost:5173' }
    });
    expect(missingAuth.status).toBe(101);

    const denied = new Promise(resolve => missingAuth.webSocket.addEventListener('message', event => resolve(JSON.parse(event.data))));
    missingAuth.webSocket.accept();
    missingAuth.webSocket.send(JSON.stringify({ event: 'authenticate', payload: { token: 'invalid' }, requestId: 'auth-fail' }));
    expect((await denied).error).toContain('Room session is invalid');

    const wrongOrigin = await exports.default.fetch(`https://watch-party.workers.dev/api/rooms/${data.room.roomId}/ws`, {
      headers: { upgrade: 'websocket', origin: 'https://attacker.example' }
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it('delivers chat to the correct room and rejects participant playback controls', async () => {
    const hostResult = await createRoom('Socket host');
    const otherResult = await createRoom('Isolated host');
    const guestResult = await joinRoom(hostResult.data.room.roomId, 'Socket guest');
    const makeSocket = async session => {
      const url = new URL(`http://localhost:8787/api/rooms/${session.room.roomId}/ws`);
      const response = await exports.default.fetch(url, { headers: { upgrade: 'websocket', origin: 'http://localhost:5173' } });
      expect(response.status).toBe(101);
      return response.webSocket;
    };
    const hostSocket = await makeSocket(hostResult.data);
    const guestSocket = await makeSocket(guestResult.data);
    const otherSocket = await makeSocket(otherResult.data);
    const hostMessages = [];
    const otherMessages = [];
    hostSocket.accept(); guestSocket.accept(); otherSocket.accept();
    hostSocket.addEventListener('message', event => { hostMessages.push(JSON.parse(event.data)); });
    guestSocket.addEventListener('message', event => { hostMessages.push(JSON.parse(event.data)); });
    otherSocket.addEventListener('message', event => { otherMessages.push(JSON.parse(event.data)); });

    const waitForAuth = socket => new Promise(resolve => {
      const onMessage = event => {
        const message = JSON.parse(event.data);
        if (message.requestId === 'auth') {
          socket.removeEventListener('message', onMessage);
          resolve(message);
        }
      };
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify({ event: 'authenticate', payload: { token: socket === hostSocket ? hostResult.data.token : socket === guestSocket ? guestResult.data.token : otherResult.data.token }, requestId: 'auth' }));
    });
    await Promise.all([waitForAuth(hostSocket), waitForAuth(guestSocket), waitForAuth(otherSocket)]);

    guestSocket.send(JSON.stringify({ event: 'chat_send', payload: { text: 'room scoped hello' }, requestId: 'chat-1' }));
    guestSocket.send(JSON.stringify({ event: 'playback_action', payload: { action: 'play' }, requestId: 'control-1' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(hostMessages.some(message => message.event === 'chat_message' && message.payload.text === 'room scoped hello')).toBe(true);
    expect(hostMessages.some(message => message.requestId === 'control-1' && message.error.includes('Only the host or a moderator'))).toBe(true);
    expect(otherMessages.some(message => message.event === 'chat_message' && message.payload.text === 'room scoped hello')).toBe(false);
    hostSocket.close(); guestSocket.close(); otherSocket.close();
  });

  it('enforces playback, queue ownership, host settings, and queue idempotency', async () => {
    const { data } = await createRoom();
    const joined = await joinRoom(data.room.roomId, 'Guest');
    const namespaceId = env.WATCH_ROOMS.idFromName(data.room.roomId);
    const stub = env.WATCH_ROOMS.get(namespaceId);
    const calls = [];
  const fakeSocket = { send: message => calls.push(JSON.parse(message)), close() {} };

    const result = await runInDurableObject(stub, async (object, state) => {
      const room = await state.storage.get('room');
      const host = room.participants.find(person => person.id === data.userId);
      const guest = room.participants.find(person => person.id === joined.data.userId);
      await expect(object.handleCommand(room, guest, fakeSocket, { event: 'playback_action', payload: { action: 'play' } })).rejects.toThrow('Only the host or a moderator');
      await expect(object.handleCommand(room, guest, fakeSocket, { event: 'room_settings_update', payload: { name: 'Spoofed' } })).rejects.toThrow('Only the host can update');
      await object.handleCommand(room, guest, fakeSocket, { event: 'queue_add', payload: { videoId: 'abcdefghijk' } });
      const item = room.queue[0];
      await expect(object.handleCommand(room, host, fakeSocket, { event: 'video_ended', payload: { videoId: room.videoId } })).resolves.toBeUndefined();
      expect(room.videoId).toBe('abcdefghijk');
      expect(room.playState).toBe('playing');
      expect(room.queue).toHaveLength(0);
      expect(room.lastEndedVideoId).not.toBe(room.videoId);
      expect(item.suggestedById).toBe(guest.id);
      return publicView(room);
    });
    expect(result.videoId).toBe('abcdefghijk');
  });

  it('persists voluntary leave and reassigns the host when required', async () => {
    const { data: host } = await createRoom('Host');
    const guest = await joinRoom(host.room.roomId, 'Guest');
    const stub = env.WATCH_ROOMS.get(env.WATCH_ROOMS.idFromName(host.room.roomId));
    const afterLeave = await runInDurableObject(stub, async (object, state) => {
      const room = await state.storage.get('room');
      const hostMember = room.participants.find(person => person.id === host.userId);
      const socket = { send() {}, close() {} };
      await object.handleCommand(room, hostMember, socket, { event: 'leave_room', payload: {} });
      return state.storage.get('room');
    });
    expect(afterLeave.participants).toHaveLength(1);
    expect(afterLeave.participants[0].id).toBe(guest.data.userId);
    expect(afterLeave.participants[0].role).toBe('host');
  });

  it('expires disconnected sessions after the reconnect grace period', async () => {
    const { data: host } = await createRoom('Host');
    const guest = await joinRoom(host.room.roomId, 'Guest');
    const stub = env.WATCH_ROOMS.get(env.WATCH_ROOMS.idFromName(host.room.roomId));
    const room = await runInDurableObject(stub, async (object, state) => {
      const stored = await state.storage.get('room');
      const disconnectedHost = stored.participants.find(person => person.id === host.userId);
      disconnectedHost.disconnectAlarm = Date.now() - 1;
      await state.storage.put('room', stored);
      await object.alarm();
      return state.storage.get('room');
    });
    expect(room.participants).toHaveLength(1);
    expect(room.participants[0].id).toBe(guest.data.userId);
    expect(room.participants[0].role).toBe('host');
  });
});

function publicView(room) {
  return { roomId: room.roomId, videoId: room.videoId, playState: room.playState, queue: room.queue };
}
