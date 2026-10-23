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

function makeRoomId() { return randomBytes(3).toString('hex').toUpperCase(); }
function publicRoom(room) {
  return { roomId: room.id, videoId: room.videoId, playState: room.playState, currentTime: room.currentTime,
    participants: [...room.participants.values()].map(({ id, username, role }) => ({ id, username, role })) };
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
  socket.on('create_room', ({ username, videoId } = {}, ack = () => {}) => {
    const name = String(username || '').trim().slice(0, 32);
    if (!name) return ack({ error: 'Enter a display name.' });
    const id = makeRoomId();
    const room = { id, videoId: validVideoId(videoId) || 'dQw4w9WgXcQ', playState: 'paused', currentTime: 0, updatedAt: Date.now(), participants: new Map() };
    room.participants.set(socket.id, { id: socket.id, username: name, role: 'host' });
    rooms.set(id, room); socket.join(id); socket.data.roomId = id;
    ack({ room: publicRoom(room), userId: socket.id }); emitRoom(room);
  });
  socket.on('join_room', ({ roomId, username } = {}, ack = () => {}) => {
    const id = String(roomId || '').trim().toUpperCase();
    const name = String(username || '').trim().slice(0, 32);
    const room = rooms.get(id);
    if (!name) return ack({ error: 'Enter a display name.' });
    if (!room) return ack({ error: 'Room not found. Check the code and try again.' });
    room.participants.set(socket.id, { id: socket.id, username: name, role: 'participant' });
    socket.join(id); socket.data.roomId = id;
    ack({ room: publicRoom(room), userId: socket.id });
    emitRoom(room, 'user_joined');
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
      room.videoId = parsed; room.currentTime = 0; room.playState = 'paused';
    } else return sendError(socket, 'Unsupported playback action.');
    room.updatedAt = Date.now();
    io.to(room.id).emit('sync_state', { videoId: room.videoId, playState: room.playState, currentTime: room.currentTime, action, actorId: socket.id, updatedAt: room.updatedAt });
  });
  socket.on('assign_role', ({ userId, role } = {}) => {
    const { room, member } = getMember(socket, socket.data.roomId);
    if (!room || member?.role !== 'host') return sendError(socket, 'Only the host can assign roles.');
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
function leaveCurrentRoom(socket) {
  const id = socket.data.roomId;
  if (!id) return;
  const room = rooms.get(id); socket.data.roomId = null;
  if (!room) return;
  room.participants.delete(socket.id); socket.leave(id);
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
const port = Number(process.env.PORT || 4000);
server.listen(port, () => console.log(`Watch Party server running on port ${port}`));
