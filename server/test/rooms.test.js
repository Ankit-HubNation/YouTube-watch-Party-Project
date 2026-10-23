import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { after, before, test } from 'node:test';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let serverProcess;
let serverUrl;
const sockets = [];

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function connectClient() {
  const socket = io(serverUrl, { transports: ['websocket'], timeout: 3000, reconnection: false });
  sockets.push(socket);
  await once(socket, 'connect');
  return socket;
}

function request(socket, event, payload) {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}

function waitFor(socket, event, predicate = () => true, timeout = 1500, label = event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeout);
    const onEvent = payload => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };
    socket.on(event, onEvent);
  });
}

before(async () => {
  const port = await unusedPort();
  serverUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['src/index.js'], {
    cwd: serverRoot,
    env: { ...process.env, PORT: String(port), CLIENT_ORIGIN: serverUrl },
    stdio: 'ignore'
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error('Test server did not start');
});

after(() => {
  for (const socket of sockets) socket.disconnect();
  serverProcess?.kill();
});

test('rooms isolate chat and enforce chat, playback, queue, and settings rules', async () => {
  const host = await connectClient();
  const guest = await connectClient();
  const otherHost = await connectClient();
  const created = await request(host, 'create_room', { username: 'Host', roomName: 'Test night' });
  assert.equal(created.room.name, 'Test night');
  assert.equal(created.room.roomId.length, 12);

  const joined = await request(guest, 'join_room', { username: 'Guest', roomId: created.room.roomId });
  const isolated = await request(otherHost, 'create_room', { username: 'Other host' });
  assert.equal(joined.room.roomId, created.room.roomId);
  assert.notEqual(isolated.room.roomId, created.room.roomId);

  const hostMessage = waitFor(guest, 'chat_message', message => message.text === 'room-isolation-check', 1500, 'room chat delivery');
  const leakedMessage = waitFor(otherHost, 'chat_message', message => message.text === 'room-isolation-check', 350, 'isolated room (expected no delivery)');
  host.emit('chat_send', { text: 'room-isolation-check' });
  assert.equal((await hostMessage).username, 'Host');
  await assert.rejects(leakedMessage, /Timed out waiting/);

  const guestErrors = [];
  const hostErrors = [];
  guest.on('app_error', error => guestErrors.push(error.message));
  host.on('app_error', error => hostErrors.push(error.message));
  guest.emit('chat_send', { text: '   ' });
  guest.emit('chat_send', { text: { malformed: true } });
  guest.emit('chat_send', { text: 'x'.repeat(501) });
  guest.emit('playback_action', { action: 'change_video', videoId: 'abcdefghijk' });
  guest.emit('room_settings_update', { name: 'Spoofed name' });
  guest.emit('queue_play_next');
  await delay(120);
  assert.ok(guestErrors.some(message => message.includes('empty')));
  assert.ok(guestErrors.some(message => message.includes('Invalid chat message')));
  assert.ok(guestErrors.some(message => message.includes('500 characters')));
  assert.ok(guestErrors.some(message => message.includes('Only the host or a moderator')));
  assert.ok(guestErrors.some(message => message.includes('Only the host can update')));
  host.emit('assign_role', { userId: created.userId, role: 'participant' });
  await delay(60);
  assert.ok(hostErrors.some(message => message.includes('cannot change their own role')));

  let rateTestDeliveries = 0;
  host.on('chat_message', message => { if (message.text.startsWith('rate-test-')) rateTestDeliveries++; });
  const rateLimitError = waitFor(host, 'app_error', error => error.message.includes('too quickly'), 1500, 'chat rate-limit rejection');
  for (let index = 0; index < 6; index++) host.emit('chat_send', { text: `rate-test-${index}` });
  await rateLimitError;
  await delay(100);
  assert.equal(rateTestDeliveries, 4);
  assert.ok(hostErrors.some(message => message.includes('too quickly')));

  const queueUpdate = waitFor(guest, 'room_updated', room => room.queue.length === 1, 1500, 'shared queue update');
  host.emit('queue_add', { videoId: 'abcdefghijk' });
  const queuedRoom = await queueUpdate;
  assert.equal(queuedRoom.queue[0].suggestedBy, 'Host');
  assert.equal('suggestedById' in queuedRoom.queue[0], false);

  const deniedPlayback = guestErrors.length;
  guest.emit('playback_action', { action: 'play' });
  await delay(80);
  assert.ok(guestErrors.length > deniedPlayback);

  const transition = waitFor(guest, 'sync_state', state => state.videoId === 'abcdefghijk', 1500, 'queue playback transition');
  host.emit('video_ended', { videoId: created.room.videoId });
  assert.equal((await transition).playState, 'playing');
  host.emit('video_ended', { videoId: created.room.videoId });
  await delay(100);

  const oldRoomMessage = waitFor(guest, 'chat_message', message => message.text === 'moved-membership-check', 350, 'old room membership (expected no delivery)');
  const moved = await request(guest, 'join_room', { username: 'Guest', roomId: isolated.room.roomId });
  assert.equal(moved.room.roomId, isolated.room.roomId);
  host.emit('chat_send', { text: 'moved-membership-check' });
  await assert.rejects(oldRoomMessage, /Timed out waiting/);
});
