import { DurableObject } from 'cloudflare:workers';

const ROOM_CODE_BYTES = 6;
const CHAT_LIMIT = 500;
const CHAT_HISTORY_LIMIT = 100;
const CHAT_BURST = 5;
const CHAT_WINDOW_MS = 5000;
const QUEUE_LIMIT = 50;
const DISCONNECT_GRACE_MS = 15000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  const configured = String(env.CLIENT_ORIGIN || '').trim();
  const hostname = new URL(request.url).hostname;
  if (!configured && ['localhost', '127.0.0.1'].includes(hostname)) return origin || '*';
  if (!origin) return configured ? configured.split(',')[0].trim() : '*';
  if (!configured) return null;
  const allowed = configured.split(',').map(value => value.trim()).filter(Boolean);
  return allowed.includes('*') || allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function bodyJson(request) {
  try { return await request.json(); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (!origin) return json({ error: 'Origin is not allowed.' }, 403);
    const cors = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok' }, 200, cors);
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const payload = await bodyJson(request);
      const username = validUsername(payload?.username);
      if (!username) return json({ error: 'Enter a display name.' }, 400, cors);
      const roomId = randomHex(ROOM_CODE_BYTES);
      const room = {
        roomId,
        name: validRoomName(payload?.roomName) || 'Watch party',
        videoId: validVideoId(payload?.videoId) || 'dQw4w9WgXcQ',
        playState: 'paused',
        currentTime: 0,
        participants: [],
        messages: [],
        queue: [],
        lastAdvanceAt: 0,
        lastEndedVideoId: null,
        updatedAt: Date.now()
      };
      const session = createSession(username, 'host');
      const stub = roomStub(env, roomId);
      const result = await internalJson(stub, '/_initialize', { room, session });
      if (!result.ok) return json(result.data, result.status, cors);
      return json({ ...result.data, token: session.token }, 201, cors);
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Fa-f0-9]+)\/join$/);
    if (joinMatch && request.method === 'POST') {
      const payload = await bodyJson(request);
      const username = validUsername(payload?.username);
      if (!username) return json({ error: 'Enter a display name.' }, 400, cors);
      const roomId = joinMatch[1].toUpperCase();
      const session = createSession(username, 'participant');
      const result = await internalJson(roomStub(env, roomId), '/_join', { session });
      return json({ ...result.data, ...(result.ok ? { token: session.token } : {}) }, result.status, cors);
    }

    const websocketMatch = url.pathname.match(/^\/api\/rooms\/([A-Fa-f0-9]+)\/ws$/);
    if (websocketMatch && request.method === 'GET') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426, cors);
      return roomStub(env, websocketMatch[1].toUpperCase()).fetch(new Request('https://room.internal/_websocket', request));
    }

    return json({ error: 'Not found.' }, 404, cors);
  }
};

export class WatchRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/_initialize' && request.method === 'POST') return this.initialize(await bodyJson(request));
    if (url.pathname === '/_join' && request.method === 'POST') return this.join(await bodyJson(request));
    if (url.pathname === '/_websocket' && request.method === 'GET') return this.openWebSocket();
    return json({ error: 'Not found.' }, 404);
  }

  async initialize(payload) {
    if (!payload?.room || !payload?.session) return json({ error: 'Invalid room initialization.' }, 400);
    const existing = await this.ctx.storage.get('room');
    if (existing) return json({ error: 'Room code collision. Try creating the room again.' }, 409);
    payload.room.participants.push(payload.session);
    await this.ctx.storage.put('room', payload.room);
    return json({ room: publicRoom(payload.room), userId: payload.session.id, messages: payload.room.messages });
  }

  async join(payload) {
    const room = await this.ctx.storage.get('room');
    if (!room) return json({ error: 'Room not found. Check the code and try again.' }, 404);
    if (!payload?.session?.id || !payload?.session?.token) return json({ error: 'Invalid room session.' }, 400);
    const messageHistory = room.messages.slice();
    room.participants.push(payload.session);
    const systemMessage = addSystemMessage(room, `${payload.session.username} joined the room.`);
    await this.ctx.storage.put('room', room);
    this.broadcast('user_joined', publicRoom(room));
    this.broadcast('chat_message', systemMessage);
    return json({ room: publicRoom(room), userId: payload.session.id, messages: messageHistory });
  }

  async openWebSocket() {
    const room = await this.ctx.storage.get('room');
    if (!room) return json({ error: 'Room not found.' }, 404);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(webSocket, message) {
    let command;
    try { command = JSON.parse(message); } catch { return this.replyError(webSocket, null, 'Malformed message.'); }
    const attachment = webSocket.deserializeAttachment();
    const room = await this.ctx.storage.get('room');
    if (!room) return this.replyError(webSocket, command.requestId, 'Room not found.');
    if (!attachment?.userId && command.event === 'authenticate') {
      const member = room.participants.find(person => person.token === command.payload?.token);
      if (!member) return this.replyError(webSocket, command.requestId, 'Room session is invalid or expired.');
      member.disconnectAlarm = null;
      webSocket.serializeAttachment({ userId: member.id });
      await this.ctx.storage.put('room', room);
      webSocket.send(JSON.stringify({ event: 'room_updated', payload: publicRoom(room) }));
      if (command.requestId) webSocket.send(JSON.stringify({ requestId: command.requestId, result: { ok: true } }));
      return;
    }
    if (!attachment?.userId) return this.replyError(webSocket, command.requestId, 'Authenticate the room session first.');
    const member = room.participants.find(person => person.id === attachment.userId);
    if (!member) return this.replyError(webSocket, command.requestId, 'You are no longer in this room.');

    try {
      const keepRoom = await this.handleCommand(room, member, webSocket, command);
      if (keepRoom !== false) await this.ctx.storage.put('room', room);
      if (command.requestId) webSocket.send(JSON.stringify({ requestId: command.requestId, result: { ok: true } }));
    } catch (error) {
      this.replyError(webSocket, command.requestId, error instanceof Error ? error.message : 'Request failed.');
    }
  }

  async handleCommand(room, member, webSocket, command) {
    const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
    switch (command.event) {
      case 'chat_send': {
        if (typeof payload.text !== 'string') throw new Error('Invalid chat message.');
        const text = payload.text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        if (!text) throw new Error('Message cannot be empty.');
        if (text.length > CHAT_LIMIT) throw new Error('Messages must be 500 characters or fewer.');
        const now = Date.now();
        member.chatTimes = (member.chatTimes || []).filter(time => now - time < CHAT_WINDOW_MS);
        if (member.chatTimes.length >= CHAT_BURST) throw new Error('You are sending messages too quickly. Try again shortly.');
        member.chatTimes.push(now);
        addRoomMessage(room, { id: crypto.randomUUID(), username: member.username, text, timestamp: now, system: false });
        this.broadcast('chat_message', room.messages.at(-1));
        break;
      }
      case 'playback_action':
        this.playbackAction(room, member, payload, webSocket);
        break;
      case 'video_ended':
        if (!canControl(member) || payload.videoId !== room.videoId || room.lastEndedVideoId === payload.videoId || !room.queue.length || Date.now() - room.lastAdvanceAt < 1500) break;
        this.advanceQueue(room, true);
        break;
      case 'queue_add':
        this.queueAdd(room, member, payload);
        break;
      case 'queue_remove':
        this.queueRemove(room, member, payload);
        break;
      case 'queue_move':
        this.queueMove(room, member, payload);
        break;
      case 'queue_play_next':
        if (!canControl(member)) throw new Error('Only the host or a moderator can play the next video.');
        this.advanceQueue(room, false);
        break;
      case 'room_settings_update':
        if (member.role !== 'host') throw new Error('Only the host can update room settings.');
        room.name = validRoomName(payload.name);
        if (!room.name) throw new Error('Room names must be between 2 and 60 characters.');
        this.broadcast('room_updated', publicRoom(room));
        break;
      case 'assign_role':
        this.assignRole(room, member, payload);
        break;
      case 'remove_participant':
        this.removeParticipant(room, member, payload);
        break;
      case 'leave_room':
        await this.removeMember(room, member, webSocket, false);
        return false;
        break;
      default:
        throw new Error('Unsupported room action.');
    }
  }

  playbackAction(room, member, payload, webSocket) {
    if (!canControl(member)) throw new Error('Only the host or a moderator can control playback.');
    if (payload.action === 'play' || payload.action === 'pause') room.playState = payload.action === 'play' ? 'playing' : 'paused';
    else if (payload.action === 'seek') {
      if (!Number.isFinite(Number(payload.time)) || Number(payload.time) < 0) throw new Error('Invalid seek position.');
      room.currentTime = Number(payload.time);
    } else if (payload.action === 'change_video') {
      const videoId = validVideoId(payload.videoId);
      if (!videoId) throw new Error('Enter a valid YouTube video URL or video ID.');
      room.videoId = videoId; room.currentTime = 0; room.playState = 'paused'; room.lastEndedVideoId = null;
    } else throw new Error('Unsupported playback action.');
    room.updatedAt = Date.now();
    this.broadcast('sync_state', { videoId: room.videoId, playState: room.playState, currentTime: room.currentTime, action: payload.action, actorId: member.id, updatedAt: room.updatedAt });
  }

  queueAdd(room, member, payload) {
    const videoId = validVideoId(payload.videoId);
    if (!videoId) throw new Error('Enter a valid YouTube video URL or video ID.');
    if (room.queue.length >= QUEUE_LIMIT) throw new Error('The video queue is full.');
    if (room.queue.some(item => item.videoId === videoId) || room.videoId === videoId) throw new Error('That video is already playing or queued.');
    room.queue.push({ id: crypto.randomUUID(), videoId, suggestedBy: member.username, suggestedById: member.id, addedAt: Date.now() });
    this.broadcast('room_updated', publicRoom(room));
  }

  queueRemove(room, member, payload) {
    const index = room.queue.findIndex(item => item.id === payload.itemId);
    if (index < 0) throw new Error('That video is no longer in the queue.');
    if (!canControl(member) && room.queue[index].suggestedById !== member.id) throw new Error('You can only remove your own suggestions.');
    room.queue.splice(index, 1);
    this.broadcast('room_updated', publicRoom(room));
  }

  queueMove(room, member, payload) {
    if (!canControl(member)) throw new Error('Only the host or a moderator can reorder the queue.');
    const index = room.queue.findIndex(item => item.id === payload.itemId);
    const target = index + (payload.direction === 'up' ? -1 : payload.direction === 'down' ? 1 : 0);
    if (index < 0 || !['up', 'down'].includes(payload.direction) || target < 0 || target >= room.queue.length) return;
    [room.queue[index], room.queue[target]] = [room.queue[target], room.queue[index]];
    this.broadcast('room_updated', publicRoom(room));
  }

  assignRole(room, member, payload) {
    if (member.role !== 'host') throw new Error('Only the host can assign roles.');
    if (payload.userId === member.id) throw new Error('The host cannot change their own role.');
    if (!['participant', 'moderator'].includes(payload.role)) throw new Error('Role must be participant or moderator.');
    const target = room.participants.find(person => person.id === payload.userId);
    if (!target) throw new Error('Participant is no longer in this room.');
    target.role = payload.role;
    this.broadcast('role_assigned', publicRoom(room));
  }

  removeParticipant(room, member, payload) {
    if (member.role !== 'host') throw new Error('Only the host can remove participants.');
    if (payload.userId === member.id) throw new Error('The host cannot remove themselves.');
    const target = room.participants.find(person => person.id === payload.userId);
    if (!target) throw new Error('Participant is no longer in this room.');
    this.sendToMember(target.id, 'removed_from_room', { roomId: room.roomId });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.userId === target.id) socket.close(1000, 'Removed from room');
    }
    room.participants = room.participants.filter(person => person.id !== target.id);
    this.broadcast('chat_message', addSystemMessage(room, `${target.username} was removed from the room.`));
    this.broadcast('participant_removed', publicRoom(room));
  }

  advanceQueue(room, autoplay) {
    const next = room.queue.shift();
    if (!next) return;
    room.lastEndedVideoId = room.videoId;
    room.lastAdvanceAt = Date.now();
    room.videoId = next.videoId; room.currentTime = 0; room.playState = autoplay ? 'playing' : 'paused'; room.updatedAt = room.lastAdvanceAt;
    this.broadcast('sync_state', { videoId: room.videoId, playState: room.playState, currentTime: 0, action: 'change_video', updatedAt: room.updatedAt });
    this.broadcast('room_updated', publicRoom(room));
    this.broadcast('chat_message', addSystemMessage(room, `Now playing the next queued video, suggested by ${next.suggestedBy}.`));
  }

  webSocketClose(webSocket) {
    this.ctx.waitUntil(this.handleWebSocketClose(webSocket));
  }

  async handleWebSocketClose(webSocket) {
    const attachment = webSocket.deserializeAttachment();
    const room = await this.ctx.storage.get('room');
    const member = room?.participants.find(person => person.id === attachment?.userId);
    if (!room || !member) return;
    member.disconnectAlarm = Date.now() + DISCONNECT_GRACE_MS;
    await this.ctx.storage.put('room', room);
    await this.ctx.storage.setAlarm(member.disconnectAlarm);
  }

  webSocketError(webSocket) { this.ctx.waitUntil(this.handleWebSocketClose(webSocket)); }

  async alarm() {
    const room = await this.ctx.storage.get('room');
    if (!room) return;
    const now = Date.now();
    const disconnected = room.participants.filter(person => person.disconnectAlarm && person.disconnectAlarm <= now);
    if (!disconnected.length) {
      const nextAlarm = Math.min(...room.participants.filter(person => person.disconnectAlarm).map(person => person.disconnectAlarm));
      if (Number.isFinite(nextAlarm)) await this.ctx.storage.setAlarm(nextAlarm);
      return;
    }
    const disconnectedIds = new Set(disconnected.map(person => person.id));
    room.participants = room.participants.filter(person => !disconnectedIds.has(person.id));
    for (const member of disconnected) this.broadcast('chat_message', addSystemMessage(room, `${member.username} left the room.`));
    if (!room.participants.length) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (!room.participants.some(person => person.role === 'host')) room.participants[0].role = 'host';
    await this.ctx.storage.put('room', room);
    this.broadcast('user_left', publicRoom(room));
    const nextAlarm = Math.min(...room.participants.filter(person => person.disconnectAlarm).map(person => person.disconnectAlarm));
    if (Number.isFinite(nextAlarm)) await this.ctx.storage.setAlarm(nextAlarm);
  }

  async removeMember(room, member, webSocket, notify = true) {
    if (notify) webSocket.send(JSON.stringify({ event: 'removed_from_room', payload: { roomId: room.roomId } }));
    room.participants = room.participants.filter(person => person.id !== member.id);
    if (!room.participants.length) {
      await this.ctx.storage.deleteAll();
      webSocket.close(1000, 'Left room');
      return;
    }
    this.broadcast('chat_message', addSystemMessage(room, `${member.username} left the room.`));
    if (!room.participants.some(person => person.role === 'host')) room.participants[0].role = 'host';
    await this.ctx.storage.put('room', room);
    this.broadcast('user_left', publicRoom(room));
    webSocket.close(1000, 'Left room');
  }

  broadcast(event, payload) {
    const message = JSON.stringify({ event, payload });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch {}
    }
  }

  sendToMember(userId, event, payload) {
    const message = JSON.stringify({ event, payload });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.userId === userId) {
        try { socket.send(message); } catch {}
      }
    }
  }

  replyError(webSocket, requestId, message) {
    webSocket.send(JSON.stringify({ event: 'app_error', payload: { message }, requestId, error: message }));
  }
}

function roomStub(env, roomId) {
  return env.WATCH_ROOMS.get(env.WATCH_ROOMS.idFromName(roomId));
}

async function internalJson(stub, path, payload) {
  const response = await stub.fetch(`https://room.internal${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  return { ok: response.ok, status: response.status, data: await response.json() };
}

function createSession(username, role) {
  return { id: crypto.randomUUID(), token: `${randomHex(32)}${crypto.randomUUID().replaceAll('-', '')}`, username, role, chatTimes: [], joinedAt: Date.now() };
}

function publicRoom(room) {
  return {
    roomId: room.roomId,
    name: room.name,
    videoId: room.videoId,
    playState: room.playState,
    currentTime: room.currentTime,
    participants: room.participants.map(({ id, username, role }) => ({ id, username, role })),
    queue: room.queue.map(({ suggestedById, ...item }) => ({ ...item }))
  };
}

function validUsername(input) {
  if (typeof input !== 'string') return null;
  const username = input.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
  return username || null;
}

function validRoomName(input) {
  if (typeof input !== 'string') return null;
  const name = input.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.length >= 2 && name.length <= 60 ? name : null;
}

function validVideoId(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) return url.pathname.slice(1).split('/')[0].match(/^[\w-]{11}$/)?.[0] || null;
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
      const id = url.searchParams.get('v') || url.pathname.match(/\/(?:embed|shorts)\/([\w-]{11})/)?.[1];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
  } catch {}
  return null;
}

function addRoomMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > CHAT_HISTORY_LIMIT) room.messages.shift();
}

function addSystemMessage(room, text) {
  const message = { id: crypto.randomUUID(), username: 'WatchTogether', text, timestamp: Date.now(), system: true };
  addRoomMessage(room, message);
  return message;
}

function canControl(member) { return member && ['host', 'moderator'].includes(member.role); }