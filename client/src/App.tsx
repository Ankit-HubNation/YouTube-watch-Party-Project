import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { ArrowRight, Check, Copy, Crown, Link2, LogOut, MessageCircle, Play, Shield, Users, Youtube } from 'lucide-react';

type Role = 'host' | 'moderator' | 'participant';
type Person = { id: string; username: string; role: Role };
type ChatMessage = { id: string; username: string; text: string; timestamp: number; system: boolean };
type QueueItem = { id: string; videoId: string; suggestedBy: string; addedAt: number };
type Room = { roomId: string; name: string; videoId: string; playState: 'playing' | 'paused'; currentTime: number; participants: Person[]; queue: QueueItem[] };
type RecentRoom = { roomId: string; name: string; visitedAt: number };
type RecentVideo = { videoId: string; watchedAt: number };
type Sync = { videoId: string; playState: 'playing' | 'paused'; currentTime: number; action?: string; actorId?: string; updatedAt?: number };
const SERVER = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

function readLocalHistory<T extends { [key: string]: unknown }>(key: string, isValid: (item: T) => boolean): T[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((item): item is T => Boolean(item && typeof item === 'object' && isValid(item as T))).slice(0, 12) : [];
  } catch { return []; }
}
function writeLocalHistory<T>(key: string, value: T[]): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<any>(null);
  const lastObservedTimeRef = useRef<number | null>(null);
  const suppressSeekUntilRef = useRef<number>(0);
  const roomRef = useRef<Room | null>(null);
  const [username, setUsername] = useState('');
  const [roomName, setRoomName] = useState('Movie night');
  const [roomCode, setRoomCode] = useState(new URLSearchParams(location.search).get('room') || '');
  const [videoInput, setVideoInput] = useState('');
  const [room, setRoom] = useState<Room | null>(null);
  const [myId, setMyId] = useState('');
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [queueInput, setQueueInput] = useState('');
  const [pendingSync, setPendingSync] = useState<Sync | null>(null);
  const [activePanel, setActivePanel] = useState<'chat' | 'people' | 'queue'>('chat');
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => readLocalHistory<RecentRoom>('watchtogether.rooms', item => typeof item.roomId === 'string' && typeof item.name === 'string' && Number.isFinite(item.visitedAt)));
  const [recentVideos, setRecentVideos] = useState<RecentVideo[]>(() => readLocalHistory<RecentVideo>('watchtogether.videos', item => /^[\w-]{11}$/.test(item.videoId) && Number.isFinite(item.watchedAt)));
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const me = room?.participants.find(p => p.id === myId);
  const canControl = me?.role === 'host' || me?.role === 'moderator';
  const isHost = me?.role === 'host';
  const socket = socketRef.current;

  useEffect(() => {
    const s = io(SERVER, { transports: ['websocket', 'polling'] }); socketRef.current = s;
    s.on('connect', () => setConnected(true)); s.on('disconnect', () => setConnected(false));
    s.on('room_updated', (r: Room) => { setRoom(r); roomRef.current = r; });
    s.on('user_joined', (r: Room) => { setRoom(r); roomRef.current = r; setNotice('A participant joined the room.'); });
    s.on('user_left', (r: Room) => { setRoom(r); roomRef.current = r; setNotice('A participant left the room.'); });
    s.on('role_assigned', (r: Room) => { setRoom(r); roomRef.current = r; setNotice('Participant roles updated.'); });
    s.on('participant_removed', (r: Room) => { setRoom(r); roomRef.current = r; });
    s.on('sync_state', (state: Sync) => { if (state.action === 'change_video') rememberVideo(state.videoId); setPendingSync(state); setRoom(prev => prev ? { ...prev, videoId: state.videoId, playState: state.playState, currentTime: state.currentTime } : prev); });
    s.on('chat_message', (message: ChatMessage) => setChat(prev => [...prev.slice(-99), message]));
    s.on('app_error', ({ message }: { message: string }) => setNotice(message));
    s.on('removed_from_room', () => { setRoom(null); roomRef.current = null; setMyId(''); setNotice('You were removed from the room by the host.'); history.replaceState({}, '', location.pathname); });
    return () => { s.disconnect(); socketRef.current = null; };
  }, []);

  useEffect(() => {
    const element = chatMessagesRef.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 100) element.scrollTop = element.scrollHeight;
  }, [chat]);

  useEffect(() => { writeLocalHistory('watchtogether.rooms', recentRooms.slice(0, 8)); }, [recentRooms]);
  useEffect(() => { writeLocalHistory('watchtogether.videos', recentVideos.slice(0, 12)); }, [recentVideos]);

  const rememberRoom = (nextRoom: Room) => setRecentRooms(previous => [{ roomId: nextRoom.roomId, name: nextRoom.name, visitedAt: Date.now() }, ...previous.filter(item => item.roomId !== nextRoom.roomId)].slice(0, 8));
  const rememberVideo = (videoId: string) => setRecentVideos(previous => [{ videoId, watchedAt: Date.now() }, ...previous.filter(item => item.videoId !== videoId)].slice(0, 12));
  const applyPlaybackState = (state: Sync) => {
    const player = playerRef.current;
    if (!player) return;
    suppressSeekUntilRef.current = Date.now() + 1500;
    lastObservedTimeRef.current = state.currentTime;
    if (player.getVideoData?.().video_id !== state.videoId) player.loadVideoById(state.videoId, state.currentTime);
    else if (Math.abs((player.getCurrentTime?.() || 0) - state.currentTime) > 2) player.seekTo(state.currentTime, true);
    if (state.playState === 'playing') player.playVideo(); else player.pauseVideo();
  };

  useEffect(() => {
    if (!pendingSync || !playerRef.current || !room) return;
    applyPlaybackState(pendingSync);
    setPendingSync(null);
  }, [pendingSync, room]);

  useEffect(() => {
    if (!room || !canControl) return;
    const interval = window.setInterval(() => {
      const player = playerRef.current;
      if (!player?.getCurrentTime || player.getPlayerState?.() === -1) return;
      const current = Number(player.getCurrentTime());
      if (!Number.isFinite(current)) return;
      const previous = lastObservedTimeRef.current;
      if (previous !== null && Math.abs(current - previous) > 2.5 && Date.now() > suppressSeekUntilRef.current) {
        socketRef.current?.emit('playback_action', { action: 'seek', time: current });
        suppressSeekUntilRef.current = Date.now() + 1200;
      }
      lastObservedTimeRef.current = current;
    }, 500);
    return () => window.clearInterval(interval);
  }, [room?.roomId, canControl]);

  useEffect(() => {
    if (!room) return;
    const existing = document.getElementById('youtube-iframe-api');
    if (!existing) { const tag = document.createElement('script'); tag.id = 'youtube-iframe-api'; tag.src = 'https://www.youtube.com/iframe_api'; document.body.appendChild(tag); }
    const init = () => {
      const target = document.getElementById('youtube-player'); if (!target || playerRef.current) return;
      playerRef.current = new (window as any).YT.Player('youtube-player', { videoId: room.videoId, playerVars: { autoplay: 0, controls: canControl ? 1 : 0, rel: 0, modestbranding: 1 }, events: {
        onReady: () => { const currentRoom = roomRef.current; if (currentRoom) applyPlaybackState(currentRoom); },
        onStateChange: (event: any) => {
          const currentRoom = roomRef.current; const s = socketRef.current;
          if (!currentRoom || !s || !canControl || event.data === 3 || event.data === -1 || event.data === 5) return;
          if (event.data === 1) s.emit('playback_action', { action: 'play' });
          if (event.data === 2) s.emit('playback_action', { action: 'pause' });
          if (event.data === 0) s.emit('video_ended', { videoId: currentRoom.videoId });
        }
      }});
    };
    const check = setInterval(() => { if ((window as any).YT?.Player) { clearInterval(check); init(); } }, 100);
    return () => { clearInterval(check); if (playerRef.current) { playerRef.current.destroy?.(); playerRef.current = null; } };
  }, [room?.roomId]);

  const createRoom = () => {
    if (!username.trim()) return setNotice('Enter your name first.');
    socketRef.current?.emit('create_room', { username, roomName, videoId: extractVideoId(videoInput) || undefined }, (result: any) => {
      if (result?.error) return setNotice(result.error);
      setMyId(result.userId); setRoom(result.room); setRoomName(result.room.name); roomRef.current = result.room; rememberRoom(result.room); rememberVideo(result.room.videoId); setChat(result.messages || []); setPendingSync({ ...result.room }); history.replaceState({}, '', `?room=${result.room.roomId}`); setNotice('Room created. Share the code with your friends.');
    });
  };
  const joinRoom = () => {
    if (!username.trim() || !roomCode.trim()) return setNotice('Enter your name and room code.');
    socketRef.current?.emit('join_room', { username, roomId: roomCode }, (result: any) => {
      if (result?.error) return setNotice(result.error);
      setMyId(result.userId); setRoom(result.room); setRoomName(result.room.name); roomRef.current = result.room; rememberRoom(result.room); rememberVideo(result.room.videoId); setChat(result.messages || []); setPendingSync({ ...result.room }); history.replaceState({}, '', `?room=${result.room.roomId}`); setNotice('Joined the watch party.');
    });
  };
  const action = useCallback((name: string, extra: Record<string, unknown> = {}) => {
    if (!canControl) return setNotice('Only the host or a moderator can control playback.');
    const time = name === 'seek' ? playerRef.current?.getCurrentTime?.() : undefined;
    socketRef.current?.emit('playback_action', { action: name, ...(time !== undefined ? { time } : {}), ...extra });
  }, [canControl]);
  const changeVideo = () => { const id = extractVideoId(videoInput); if (!id) return setNotice('Paste a valid YouTube URL or 11-character video ID.'); action('change_video', { videoId: id }); };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${room?.roomId}`);
      setCopied(true); setNotice('Invitation link copied.'); window.setTimeout(() => setCopied(false), 1500);
    } catch { setNotice('Could not copy the invitation link. Copy the room code instead.'); }
  };
  const leave = () => { socketRef.current?.emit('leave_room'); setRoom(null); roomRef.current = null; setMyId(''); playerRef.current?.destroy?.(); playerRef.current = null; history.replaceState({}, '', location.pathname); };
  const sendChat = (e: React.FormEvent) => { e.preventDefault(); if (!chatInput.trim()) return; socketRef.current?.emit('chat_send', { text: chatInput }); setChatInput(''); };
  const addToQueue = (e: React.FormEvent) => { e.preventDefault(); const videoId = extractVideoId(queueInput); if (!videoId) return setNotice('Paste a valid YouTube URL or 11-character video ID.'); socketRef.current?.emit('queue_add', { videoId }); setQueueInput(''); };
  const updateRoomName = (e: React.FormEvent) => { e.preventDefault(); socketRef.current?.emit('room_settings_update', { name: roomName }); };
  const assignRole = (userId: string, role: Role) => socketRef.current?.emit('assign_role', { userId, role });
  const removePerson = (userId: string) => socketRef.current?.emit('remove_participant', { userId });

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="/"><span className="brand-icon"><Youtube size={22}/></span><span>watch<span className="brand-light">together</span></span></a><div className="connection"><span className={connected ? 'dot online' : 'dot'} />{connected ? 'Connected' : 'Connecting...'}</div></header>
    {!room ? <section className="landing"><div className="hero-copy"><div className="eyebrow"><span className="live-dot"/> YOUR PEOPLE. ONE SCREEN.</div><h1>Watch together.<br/><span>Even when apart.</span></h1><p className="hero-sub">Create a room, invite your friends, and press play. Everyone stays in sync.</p><div className="feature-row"><span><Users size={16}/> Private rooms</span><span><Play size={16}/> Synced playback</span><span><Shield size={16}/> Host controls</span></div></div>
      <div className="entry-card"><div className="card-heading"><h2>Start a watch party</h2><p>Enter a name to create a room or join a friend.</p></div><label>Your display name</label><input value={username} onChange={e => setUsername(e.target.value)} placeholder="e.g. Ankit" maxLength={32}/><label>Room name</label><input value={roomName} onChange={e => setRoomName(e.target.value)} placeholder="Movie night" maxLength={60}/><label>YouTube video <span className="optional">OPTIONAL</span></label><input value={videoInput} onChange={e => setVideoInput(e.target.value)} placeholder="Paste a YouTube link"/>
        <button className="primary-btn" onClick={createRoom}>Create a room <ArrowRight size={17}/></button><div className="or-divider"><span/>OR<span/></div><label>Have a room code?</label><div className="join-row"><input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} placeholder="ENTER CODE" maxLength={12}/><button className="join-btn" onClick={joinRoom}>Join <ArrowRight size={16}/></button></div><p className="secure-note"><Shield size={13}/> Your room is private to people with the code.</p></div>
      {recentRooms.length > 0 && <div className="history-strip"><strong>Recent rooms</strong>{recentRooms.slice(0, 4).map(item => <button key={item.roomId} onClick={() => setRoomCode(item.roomId)}>{item.name} <span>{item.roomId}</span></button>)}</div>}{recentVideos.length > 0 && <div className="history-strip"><strong>Recently watched</strong>{recentVideos.slice(0, 5).map(item => <button key={item.videoId} onClick={() => { setVideoInput(item.videoId); setRoomCode(''); }}>{item.videoId}</button>)}</div>}{notice && <div className="notice landing-notice">{notice}</div>}</section> : <section className="room-page"><div className="room-header"><div><div className="eyebrow"><span className="live-dot"/> WATCH PARTY IS LIVE</div><h1>{room.name} <span className="room-code">{room.roomId}</span></h1><p className="room-sub">Send the invite link. Everyone can watch in sync.</p>{isHost && <form className="room-name-form" onSubmit={updateRoomName}><input value={roomName} onChange={e => setRoomName(e.target.value)} maxLength={60} aria-label="Room name"/><button type="submit">Save name</button></form>}</div><div className="room-actions"><button className="secondary-btn" onClick={copyLink}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? 'Copied' : 'Copy invite'}</button><button className="icon-btn" onClick={leave} title="Leave room"><LogOut size={17}/></button></div></div>
      {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
      <div className="room-grid"><section className="watch-column"><div className="player-frame"><div id="youtube-player"/><div className="player-overlay" style={{ display: 'none' }} /></div><div className="player-footer"><div className="playing-status"><span className={room.playState === 'playing' ? 'live-dot' : 'pause-dot'}/>{room.playState === 'playing' ? 'NOW PLAYING' : 'READY TO PLAY'}</div><div className="control-hint">{canControl ? 'You can control playback' : 'Only host and moderators can control playback'}</div></div>
        {canControl && <div className="video-change"><Link2 size={17}/><input value={videoInput} onChange={e => setVideoInput(e.target.value)} placeholder="Paste another YouTube video URL"/><button onClick={changeVideo}>Change video</button></div>}
        <div className="sync-note"><span className="sync-symbol">↔</span><div><strong>Playback stays in sync</strong><p>Play, pause, or seek the video. Other participants follow automatically.</p></div></div>
      </section><aside className="side-column"><nav className="room-tabs" aria-label="Room panels"><button className={activePanel === 'people' ? 'active' : ''} onClick={() => setActivePanel('people')}><Users size={15}/> People</button><button className={activePanel === 'chat' ? 'active' : ''} onClick={() => setActivePanel('chat')}><MessageCircle size={15}/> Chat</button><button className={activePanel === 'queue' ? 'active' : ''} onClick={() => setActivePanel('queue')}><Play size={15}/> Queue</button></nav>
      <section className={`panel people-panel room-panel ${activePanel === 'people' ? 'panel-active' : ''}`}><div className="panel-title"><div><Users size={17}/><h3>In this room</h3></div><span className="count-pill">{room.participants.length}</span></div><div className="people-list">{room.participants.map((person, index) => <div className="person-row" key={person.id}><div className={`avatar avatar-${index % 5}`}>{person.username.trim().charAt(0).toUpperCase()}</div><div className="person-info"><strong>{person.username}{person.id === myId ? ' (you)' : ''}</strong><span>{person.role === 'host' ? <><Crown size={12}/> Host</> : person.role === 'moderator' ? <><Shield size={12}/> Moderator</> : 'Participant'}</span></div>{isHost && person.id !== myId && <div className="person-menu"><select aria-label={`Role for ${person.username}`} value={person.role} onChange={e => assignRole(person.id, e.target.value as Role)}><option value="participant">Participant</option><option value="moderator">Moderator</option></select><button title="Remove participant" onClick={() => removePerson(person.id)}>×</button></div>}</div>)}</div><div className="role-legend"><Shield size={14}/><p>Host and moderators control playback. The host manages roles.</p></div></section>
      <section className={`panel chat-panel room-panel ${activePanel === 'chat' ? 'panel-active' : ''}`}><div className="panel-title"><div><MessageCircle size={17}/><h3>Room chat</h3></div><span className="optional">LIVE</span></div><div className="chat-messages" ref={chatMessagesRef}>{chat.length === 0 ? <p className="chat-empty">Messages for this room will appear here.</p> : chat.map(message => <p className={message.system ? 'system-message' : ''} key={message.id}><strong>{message.username}</strong> {message.text}<time>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></p>)}</div><form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder="Say something..." maxLength={500}/><button aria-label="Send message"><ArrowRight size={17}/></button></form><p className="chat-disclaimer">Messages are shared with everyone in this room.</p></section>
      <section className={`panel queue-panel room-panel ${activePanel === 'queue' ? 'panel-active' : ''}`}><div className="panel-title"><div><Play size={17}/><h3>Up next</h3></div><span className="count-pill">{room.queue.length}</span></div><form className="queue-form" onSubmit={addToQueue}><input value={queueInput} onChange={e => setQueueInput(e.target.value)} placeholder="Add a YouTube link or ID" aria-label="Video to add"/><button aria-label="Add video"><ArrowRight size={17}/></button></form>{canControl && room.queue.length > 0 && <button className="play-next-btn" onClick={() => socketRef.current?.emit('queue_play_next')}><Play size={14}/> Play next</button>}<div className="queue-list">{room.queue.length === 0 ? <p className="queue-empty">Suggest a video to add it to the shared queue.</p> : room.queue.map((item, index) => <div className="queue-item" key={item.id}><img src={`https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`} alt=""/><div><strong>{item.videoId}</strong><span>Suggested by {item.suggestedBy}</span></div><div className="queue-actions">{canControl && <><button title="Move up" disabled={index === 0} onClick={() => socketRef.current?.emit('queue_move', { itemId: item.id, direction: 'up' })}>↑</button><button title="Move down" disabled={index === room.queue.length - 1} onClick={() => socketRef.current?.emit('queue_move', { itemId: item.id, direction: 'down' })}>↓</button></>}<button title="Remove video" onClick={() => socketRef.current?.emit('queue_remove', { itemId: item.id })}>×</button></div></div>)}</div></section></aside></div>
    </section>}
    <footer><span>WATCHTOGETHER</span><span>Built for shared moments.</span></footer>
  </main>;
}
function extractVideoId(value: string): string | null {
  const input = value.trim(); if (/^[\w-]{11}$/.test(input)) return input;
  try { const url = new URL(input); if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1).split('/')[0].match(/^[\w-]{11}$/)?.[0] || null; if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(url.hostname)) { const id = url.searchParams.get('v') || url.pathname.match(/\/(?:embed|shorts)\/([\w-]{11})/)?.[1]; return id && /^[\w-]{11}$/.test(id) ? id : null; } } catch {} return null;
}
