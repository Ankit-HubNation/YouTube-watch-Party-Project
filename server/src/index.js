import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { randomBytes, randomUUID } from 'node:crypto';

const app = express();
const server = http.createServer(app);
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin }));
app.use(express.json());
const io = new Server(server, { cors: { origin, methods: ['GET', 'POST'] } });
const rooms = new Map();

function makeRoomId() {
  let id;
  do { id = randomBytes(6).toString('hex').toUpperCase(); } while (rooms.has(id));
  return id;
}
function publicRoom(room) {
  return { roomId: room.id, name: room.name, videoId: room.videoId, playState: room.playState, currentTime: room.currentTime,
    participants: [...room.participants.values()].map(({ id, username, role }) => ({ id, username, role })),
    queue: room.queue.map(({ suggestedById, ...item }) => ({ ...item })) };
}
function emitRoom(room, event = 'room_updated') { io.to(room.id).emit(event, publicRoom(room)); }
function getMember(socket, roomId) {
  const room = rooms.get(String(roomId || '').toUpperCase());
  const member = room?.participants.get(socket.id);
  return { room, member };
}
function canControl(member) { return member && ['host', 'moderator'].includes(member.role); }
function sendError(socket, message) { socket.emit('app_error', { message }); }

app.get('/health', (_req, res) => res.json({ status: 'ok', rooms: rooms.size }));

io.on('connection', (socket) => {
  socket.on('create_room', ({ username, videoId, roomName } = {}, ack = () => {}) => {
    const name = String(username || '').trim().slice(0, 32);
    if (!name) return ack({ error: 'Enter a display name.' });
    if (socket.data.roomId) leaveCurrentRoom(socket);
    const id = makeRoomId();
    const room = { id, name: validRoomName(roomName) || 'Watch party', videoId: validVideoId(videoId) || 'dQw4w9WgXcQ', playState: 'paused', currentTime: 0, updatedAt: Date.now(), participants: new Map(), messages: [], queue: [], lastAdvanceAt: 0 };
    room.participants.set(socket.id, { id: socket.id, username: name, role: 'host', chatTimes: [] });
    rooms.set(id, room); socket.join(id); socket.data.roomId = id;
    ack({ room: publicRoom(room), userId: socket.id, messages: room.messages }); emitRoom(room);
  });
  socket.on('join_room', ({ roomId, username } = {}, ack = () => {}) => {
    const id = String(roomId || '').trim().toUpperCase();
    const name = String(username || '').trim().slice(0, 32);
    const room = rooms.get(id);
    if (!name) return ack({ error: 'Enter a display name.' });
    if (!room) return ack({ error: 'Room not found. Check the code and try again.' });
    if (socket.data.roomId) leaveCurrentRoom(socket);
    room.participants.set(socket.id, { id: socket.id, username: name, role: 'participant', chatTimes: [] });
    socket.join(id); socket.data.roomId = id;
    ack({ room: publicRoom(room), userId: socket.id, messages: room.messages });
    emitRoom(room, 'user_joined');
    addSystemMessage(room, `${name} joined the room.`);
  });
  socket.on('chat_send', ({ text } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || !member) return sendError(socket, 'Join a room before sending a message.');
    if (typeof text !== 'string') return sendError(socket, 'Invalid chat message.');
    const message = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!message) return sendError(socket, 'Message cannot be empty.');
    if (message.length > 500) return sendError(socket, 'Messages must be 500 characters or fewer.');
    const now = Date.now();
    member.chatTimes = member.chatTimes.filter(time => now - time < 5000);
    if (member.chatTimes.length >= 5) return sendError(socket, 'You are sending messages too quickly. Try again shortly.');
    member.chatTimes.push(now);
    addRoomMessage(room, { id: randomUUID(), username: member.username, text: message, timestamp: now, system: false });
  });
  socket.on('queue_add', ({ videoId } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || !member) return sendError(socket, 'Join a room before adding a video.');
    const parsed = validVideoId(videoId);
    if (!parsed) return sendError(socket, 'Enter a valid YouTube video URL or video ID.');
    if (room.queue.length >= 50) return sendError(socket, 'The video queue is full.');
    if (room.queue.some(item => item.videoId === parsed) || room.videoId === parsed) return sendError(socket, 'That video is already playing or queued.');
    room.queue.push({ id: randomUUID(), videoId: parsed, suggestedBy: member.username, suggestedById: socket.id, addedAt: Date.now() });
    emitRoom(room);
  });
  socket.on('queue_remove', ({ itemId } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || !member) return sendError(socket, 'Join a room before changing the queue.');
    const index = room.queue.findIndex(item => item.id === itemId);
    if (index < 0) return sendError(socket, 'That video is no longer in the queue.');
    if (!canControl(member) && room.queue[index].suggestedById !== socket.id) return sendError(socket, 'You can only remove your own suggestions.');
    room.queue.splice(index, 1);
    emitRoom(room);
  });
  socket.on('queue_move', ({ itemId, direction } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || !canControl(member)) return sendError(socket, 'Only the host or a moderator can reorder the queue.');
    const index = room.queue.findIndex(item => item.id === itemId);
    const target = index + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0);
    if (index < 0 || !['up', 'down'].includes(direction) || target < 0 || target >= room.queue.length) return;
    [room.queue[index], room.queue[target]] = [room.queue[target], room.queue[index]];
    emitRoom(room);
  });
  socket.on('queue_play_next', () => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || !canControl(member)) return sendError(socket, 'Only the host or a moderator can play the next video.');
    advanceQueue(room);
  });
  socket.on('video_ended', ({ videoId } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || !canControl(member)) return;
    if (videoId !== room.videoId || room.lastEndedVideoId === videoId || !room.queue.length || Date.now() - room.lastAdvanceAt < 1500) return;
    room.lastEndedVideoId = videoId;
    advanceQueue(room, true);
  });
  socket.on('playback_action', ({ action, time, videoId } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || !member) return sendError(socket, 'Join a room before controlling playback.');
    if (!canControl(member)) return sendError(socket, 'Only the host or a moderator can control playback.');
    if (action === 'play' || action === 'pause') room.playState = action === 'play' ? 'playing' : 'paused';
    else if (action === 'seek') {
      if (!Number.isFinite(Number(time)) || Number(time) < 0) return sendError(socket, 'Invalid seek position.');
      room.currentTime = Number(time);
    } else if (action === 'change_video') {
      const parsed = validVideoId(videoId);
      if (!parsed) return sendError(socket, 'Enter a valid YouTube video URL or video ID.');
      room.videoId = parsed; room.currentTime = 0; room.playState = 'paused'; room.lastEndedVideoId = null;
    } else return sendError(socket, 'Unsupported playback action.');
    room.updatedAt = Date.now();
    io.to(room.id).emit('sync_state', { videoId: room.videoId, playState: room.playState, currentTime: room.currentTime, action, actorId: socket.id, updatedAt: room.updatedAt });
  });
  socket.on('room_settings_update', ({ name } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || member?.role !== 'host') return sendError(socket, 'Only the host can update room settings.');
    const parsedName = validRoomName(name);
    if (!parsedName) return sendError(socket, 'Room names must be between 2 and 60 characters.');
    room.name = parsedName;
    emitRoom(room);
  });
  socket.on('assign_role', ({ userId, role } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || member?.role !== 'host') return sendError(socket, 'Only the host can assign roles.');
    if (userId === socket.id) return sendError(socket, 'The host cannot change their own role.');
    if (!['participant', 'moderator'].includes(role)) return sendError(socket, 'Role must be participant or moderator.');
    const target = room.participants.get(userId);
    if (!target) return sendError(socket, 'Participant is no longer in this room.');
    target.role = role; emitRoom(room, 'role_assigned');
  });
  socket.on('remove_participant', ({ userId } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || member?.role !== 'host') return sendError(socket, 'Only the host can remove participants.');
    if (userId === socket.id) return sendError(socket, 'The host cannot remove themselves.');
    const target = room.participants.get(userId);
    if (!target) return sendError(socket, 'Participant is no longer in this room.');
    room.participants.delete(userId);
    const targetSocket = io.sockets.sockets.get(userId);
    if (targetSocket) { targetSocket.leave(room.id); targetSocket.data.roomId = null; targetSocket.emit('removed_from_room', { roomId: room.id }); }
    emitRoom(room, 'participant_removed');
  });
  socket.on('leave_room', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => leaveCurrentRoom(socket));
});
function addRoomMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > 100) room.messages.shift();
  io.to(room.id).emit('chat_message', message);
}
function addSystemMessage(room, text) {
  addRoomMessage(room, { id: randomUUID(), username: 'WatchTogether', text, timestamp: Date.now(), system: true });
}
function advanceQueue(room, autoplay = false) {
  const next = room.queue.shift();
  if (!next) return;
  const endedVideoId = room.videoId;
  room.lastAdvanceAt = Date.now();
  room.lastEndedVideoId = endedVideoId;
  room.videoId = next.videoId;
  room.currentTime = 0;
  room.playState = autoplay ? 'playing' : 'paused';
  room.updatedAt = room.lastAdvanceAt;
  io.to(room.id).emit('sync_state', { videoId: room.videoId, playState: room.playState, currentTime: 0, action: 'change_video', updatedAt: room.updatedAt });
  emitRoom(room);
  addSystemMessage(room, `Now playing the next queued video, suggested by ${next.suggestedBy}.`);
}
function leaveCurrentRoom(socket) {
  const id = socket.data.roomId;
  if (!id) return;
  const room = rooms.get(id); socket.data.roomId = null;
  if (!room) return;
  const member = room.participants.get(socket.id);
  room.participants.delete(socket.id); socket.leave(id);
  if (member) addSystemMessage(room, `${member.username} left the room.`);
  if (room.participants.size === 0) rooms.delete(id);
  else {
    // If host leaves, assign host to the longest-connected remaining participant.
    if (![...room.participants.values()].some(p => p.role === 'host')) {
      const next = room.participants.values().next().value;
      if (next) next.role = 'host';
    }
    emitRoom(room, 'user_left');
  }
}
function validVideoId(input) {
  const value = String(input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') return url.pathname.slice(1).split('/')[0].match(/^[\w-]{11}$/)?.[0] || null;
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
      const id = url.searchParams.get('v') || url.pathname.match(/\/(?:embed|shorts)\/([\w-]{11})/)?.[1];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
  } catch {}
  return null;
}
function validRoomName(input) {
  const name = String(input || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.length >= 2 && name.length <= 60 ? name : null;
}
const port = Number(process.env.PORT || 4000);
server.listen(port, () => console.log(`Watch Party server running on port ${port}`));
