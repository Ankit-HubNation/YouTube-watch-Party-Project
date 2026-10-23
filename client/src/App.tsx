import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { ArrowRight, Check, Copy, Crown, Link2, LogOut, MessageCircle, Play, Shield, Users, Youtube } from 'lucide-react';

type Role = 'host' | 'moderator' | 'participant';
type Person = { id: string; username: string; role: Role };
type Room = { roomId: string; videoId: string; playState: 'playing' | 'paused'; currentTime: number; participants: Person[] };
type Sync = { videoId: string; playState: 'playing' | 'paused'; currentTime: number; action?: string; actorId?: string; updatedAt?: number };
const SERVER = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<any>(null);
  const lastObservedTimeRef = useRef<number | null>(null);
  const suppressSeekUntilRef = useRef<number>(0);
  const roomRef = useRef<Room | null>(null);
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCode] = useState(new URLSearchParams(location.search).get('room') || '');
  const [videoInput, setVideoInput] = useState('');
  const [room, setRoom] = useState<Room | null>(null);
  const [myId, setMyId] = useState('');
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);
  const [chat, setChat] = useState<string[]>(['Welcome. Share the room link to watch together.']);
  const [chatInput, setChatInput] = useState('');
  const [pendingSync, setPendingSync] = useState<Sync | null>(null);
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
    s.on('sync_state', (state: Sync) => { setPendingSync(state); setRoom(prev => prev ? { ...prev, videoId: state.videoId, playState: state.playState, currentTime: state.currentTime } : prev); });
    s.on('app_error', ({ message }: { message: string }) => setNotice(message));
    s.on('removed_from_room', () => { setRoom(null); roomRef.current = null; setMyId(''); setNotice('You were removed from the room by the host.'); history.replaceState({}, '', location.pathname); });
    return () => { s.disconnect(); socketRef.current = null; };
  }, []);

  useEffect(() => {
    if (!pendingSync || !playerRef.current || !room) return;
    const player = playerRef.current;
    suppressSeekUntilRef.current = Date.now() + 1400;
    lastObservedTimeRef.current = pendingSync.currentTime;
    if (player.getVideoData?.().video_id !== pendingSync.videoId) player.loadVideoById(pendingSync.videoId, pendingSync.currentTime);
    else if (Math.abs((player.getCurrentTime?.() || 0) - pendingSync.currentTime) > 2) player.seekTo(pendingSync.currentTime, true);
    if (pendingSync.playState === 'playing') player.playVideo(); else player.pauseVideo();
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
        onReady: (event: any) => { if (roomRef.current?.playState === 'playing') event.target.playVideo(); },
        onStateChange: (event: any) => {
          const currentRoom = roomRef.current; const s = socketRef.current;
          if (!currentRoom || !s || !canControl || event.data === 3 || event.data === -1 || event.data === 5) return;
          if (event.data === 1) s.emit('playback_action', { action: 'play' });
          if (event.data === 2) s.emit('playback_action', { action: 'pause' });
        }
      }});
    };
    const check = setInterval(() => { if ((window as any).YT?.Player) { clearInterval(check); init(); } }, 100);
    return () => { clearInterval(check); if (playerRef.current) { playerRef.current.destroy?.(); playerRef.current = null; } };
  }, [room?.roomId]);

  const createRoom = () => {
    if (!username.trim()) return setNotice('Enter your name first.');
    socketRef.current?.emit('create_room', { username, videoId: extractVideoId(videoInput) || undefined }, (result: any) => {
      if (result?.error) return setNotice(result.error);
      setMyId(result.userId); setRoom(result.room); roomRef.current = result.room; history.replaceState({}, '', `?room=${result.room.roomId}`); setNotice('Room created. Share the code with your friends.');
    });
  };
  const joinRoom = () => {
    if (!username.trim() || !roomCode.trim()) return setNotice('Enter your name and room code.');
    socketRef.current?.emit('join_room', { username, roomId: roomCode }, (result: any) => {
      if (result?.error) return setNotice(result.error);
      setMyId(result.userId); setRoom(result.room); roomRef.current = result.room; history.replaceState({}, '', `?room=${result.room.roomId}`); setNotice('Joined the watch party.');
    });
  };
  const action = useCallback((name: string, extra: Record<string, unknown> = {}) => {
    if (!canControl) return setNotice('Only the host or a moderator can control playback.');
    const time = name === 'seek' ? playerRef.current?.getCurrentTime?.() : undefined;
    socketRef.current?.emit('playback_action', { action: name, ...(time !== undefined ? { time } : {}), ...extra });
  }, [canControl]);
  const changeVideo = () => { const id = extractVideoId(videoInput); if (!id) return setNotice('Paste a valid YouTube URL or 11-character video ID.'); action('change_video', { videoId: id }); };
  const copyLink = async () => { await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${room?.roomId}`); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const leave = () => { socketRef.current?.emit('leave_room'); setRoom(null); roomRef.current = null; setMyId(''); playerRef.current?.destroy?.(); playerRef.current = null; history.replaceState({}, '', location.pathname); };
  const sendChat = (e: React.FormEvent) => { e.preventDefault(); if (!chatInput.trim()) return; setChat(prev => [...prev, `${username || 'You'}: ${chatInput.trim()}`]); setChatInput(''); };
  const assignRole = (userId: string, role: Role) => socketRef.current?.emit('assign_role', { userId, role });
  const removePerson = (userId: string) => socketRef.current?.emit('remove_participant', { userId });

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="/"><span className="brand-icon"><Youtube size={22}/></span><span>watch<span className="brand-light">together</span></span></a><div className="connection"><span className={connected ? 'dot online' : 'dot'} />{connected ? 'Connected' : 'Connecting...'}</div></header>
    {!room ? <section className="landing"><div className="hero-copy"><div className="eyebrow"><span className="live-dot"/> YOUR PEOPLE. ONE SCREEN.</div><h1>Watch together.<br/><span>Even when apart.</span></h1><p className="hero-sub">Create a room, invite your friends, and press play. Everyone stays in sync.</p><div className="feature-row"><span><Users size={16}/> Private rooms</span><span><Play size={16}/> Synced playback</span><span><Shield size={16}/> Host controls</span></div></div>
      <div className="entry-card"><div className="card-heading"><h2>Start a watch party</h2><p>Enter a name to create a room or join a friend.</p></div><label>Your display name</label><input value={username} onChange={e => setUsername(e.target.value)} placeholder="e.g. Ankit" maxLength={32}/><label>YouTube video <span className="optional">OPTIONAL</span></label><input value={videoInput} onChange={e => setVideoInput(e.target.value)} placeholder="Paste a YouTube link"/>
        <button className="primary-btn" onClick={createRoom}>Create a room <ArrowRight size={17}/></button><div className="or-divider"><span/>OR<span/></div><label>Have a room code?</label><div className="join-row"><input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} placeholder="ENTER CODE" maxLength={6}/><button className="join-btn" onClick={joinRoom}>Join <ArrowRight size={16}/></button></div><p className="secure-note"><Shield size={13}/> Your room is private to people with the code.</p></div>
      {notice && <div className="notice landing-notice">{notice}</div>}</section> : <section className="room-page"><div className="room-header"><div><div className="eyebrow"><span className="live-dot"/> WATCH PARTY IS LIVE</div><h1>Room <span className="room-code">{room.roomId}</span></h1><p className="room-sub">Send the invite link. Everyone can watch in sync.</p></div><div className="room-actions"><button className="secondary-btn" onClick={copyLink}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? 'Copied' : 'Copy invite'}</button><button className="icon-btn" onClick={leave} title="Leave room"><LogOut size={17}/></button></div></div>
      {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
      <div className="room-grid"><section className="watch-column"><div className="player-frame"><div id="youtube-player"/><div className="player-overlay" style={{ display: 'none' }} /></div><div className="player-footer"><div className="playing-status"><span className={room.playState === 'playing' ? 'live-dot' : 'pause-dot'}/>{room.playState === 'playing' ? 'NOW PLAYING' : 'READY TO PLAY'}</div><div className="control-hint">{canControl ? 'You can control playback' : 'Only host and moderators can control playback'}</div></div>
        {canControl && <div className="video-change"><Link2 size={17}/><input value={videoInput} onChange={e => setVideoInput(e.target.value)} placeholder="Paste another YouTube video URL"/><button onClick={changeVideo}>Change video</button></div>}
        <div className="sync-note"><span className="sync-symbol">↔</span><div><strong>Playback stays in sync</strong><p>Play, pause, or seek the video. Other participants follow automatically.</p></div></div>
      </section><aside className="side-column"><section className="panel people-panel"><div className="panel-title"><div><Users size={17}/><h3>In this room</h3></div><span className="count-pill">{room.participants.length}</span></div><div className="people-list">{room.participants.map((person, index) => <div className="person-row" key={person.id}><div className={`avatar avatar-${index % 5}`}>{person.username.trim().charAt(0).toUpperCase()}</div><div className="person-info"><strong>{person.username}{person.id === myId ? ' (you)' : ''}</strong><span>{person.role === 'host' ? <><Crown size={12}/> Host</> : person.role === 'moderator' ? <><Shield size={12}/> Moderator</> : 'Participant'}</span></div>{isHost && person.id !== myId && <div className="person-menu"><select aria-label={`Role for ${person.username}`} value={person.role} onChange={e => assignRole(person.id, e.target.value as Role)}><option value="participant">Participant</option><option value="moderator">Moderator</option></select><button title="Remove participant" onClick={() => removePerson(person.id)}>×</button></div>}</div>)}</div><div className="role-legend"><Shield size={14}/><p>Host and moderators control playback. The host manages roles.</p></div></section>
      <section className="panel chat-panel"><div className="panel-title"><div><MessageCircle size={17}/><h3>Room chat</h3></div><span className="optional">BASIC</span></div><div className="chat-messages">{chat.map((line, i) => <p key={i}>{line}</p>)}</div><form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder="Say something..."/><button aria-label="Send message"><ArrowRight size={17}/></button></form><p className="chat-disclaimer">Chat is local to this browser in this MVP.</p></section></aside></div>
    </section>}
    <footer><span>WATCHTOGETHER</span><span>Built for shared moments.</span></footer>
  </main>;
}
function extractVideoId(value: string): string | null {
  const input = value.trim(); if (/^[\w-]{11}$/.test(input)) return input;
  try { const url = new URL(input); if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1).split('/')[0].match(/^[\w-]{11}$/)?.[0] || null; if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(url.hostname)) { const id = url.searchParams.get('v') || url.pathname.match(/\/(?:embed|shorts)\/([\w-]{11})/)?.[1]; return id && /^[\w-]{11}$/.test(id) ? id : null; } } catch {} return null;
}
