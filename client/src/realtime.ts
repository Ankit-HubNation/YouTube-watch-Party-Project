type RoomSession = { roomId: string; token: string; userId: string };
type Listener = (payload?: any) => void;
type Ack = (result: any) => void;

export class RealtimeSocket {
  private readonly baseUrl: string;
  private listeners = new Map<string, Set<Listener>>();
  private connection: WebSocket | null = null;
  private session: RoomSession | null = null;
  private retryTimer: number | null = null;
  private retryCount = 0;
  private requestId = 0;
  private stopped = false;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    void this.checkHealth();
  }

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) || new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, payload: any = {}, ack?: Ack): this {
    if (event === 'create_room' || event === 'join_room') {
      void this.enterRoom(event, payload, ack);
      return this;
    }

    if (event === 'leave_room') {
      this.send(event, payload);
      this.session = null;
      this.closeConnection();
      return this;
    }

    this.send(event, payload, ack);
    return this;
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.closeConnection();
  }

  private dispatch(event: string, payload?: any): void {
    for (const listener of this.listeners.get(event) || []) listener(payload);
  }

  private async checkHealth(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      if (!response.ok) throw new Error('Backend health check failed.');
      this.dispatch('connect');
    } catch {
      this.dispatch('connect_error', { message: 'Could not reach the watch-party backend.' });
    }
  }

  private async enterRoom(event: 'create_room' | 'join_room', payload: any, ack?: Ack): Promise<void> {
    try {
      const isCreate = event === 'create_room';
      const endpoint = isCreate ? '/api/rooms' : `/api/rooms/${encodeURIComponent(String(payload.roomId || '').toUpperCase())}/join`;
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) {
        ack?.({ error: result.error || 'Could not enter the room.' });
        return;
      }

      this.session = { roomId: result.room.roomId, token: result.token, userId: result.userId };
      this.stopped = false;
      await this.openConnection(result, ack);
    } catch {
      ack?.({ error: 'Could not connect to the watch-party backend. Check your connection and try again.' });
    }
  }

  private openConnection(result?: any, ack?: Ack): Promise<void> {
    return new Promise((resolve, reject) => {
      const session = this.session;
      if (!session) return reject(new Error('No room session is active.'));
      const wsUrl = new URL(`${this.baseUrl}/api/rooms/${encodeURIComponent(session.roomId)}/ws`);
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(wsUrl);
      this.connection = socket;
      let settled = false;
      const authRequestId = `auth-${++this.requestId}`;

      socket.onopen = () => {
        socket.send(JSON.stringify({ event: 'authenticate', payload: { token: session.token }, requestId: authRequestId }));
      };

      socket.onmessage = message => {
        let envelope: any;
        try { envelope = JSON.parse(String(message.data)); } catch { return; }
        if (envelope.requestId === authRequestId) {
          settled = true;
          if (envelope.error) {
            this.stopped = true;
            this.session = null;
            ack?.({ error: envelope.error });
            reject(new Error(envelope.error));
            socket.close(1008, 'Room authentication failed');
            return;
          }
          this.retryCount = 0;
          this.dispatch('connect');
          if (result) ack?.({ ...result, userId: session.userId });
          resolve();
        } else if (envelope.requestId && this.pendingAcks.has(envelope.requestId)) {
          const callback = this.pendingAcks.get(envelope.requestId);
          this.pendingAcks.delete(envelope.requestId);
          callback?.(envelope.error ? { error: envelope.error } : envelope.result);
        }
        if (envelope.event) {
          if (envelope.event === 'removed_from_room') {
            this.session = null;
            this.stopped = true;
          }
          this.dispatch(envelope.event, envelope.payload);
        }
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket connection failed.'));
        }
      };

      socket.onclose = () => {
        if (this.connection === socket) this.connection = null;
        if (this.session) this.dispatch('disconnect');
        else if (!this.stopped) void this.checkHealth();
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket connection closed before joining the room.'));
        }
        if (!this.stopped && this.session) this.scheduleReconnect();
      };
    });
  }

  private pendingAcks = new Map<string, Ack>();

  private send(event: string, payload: any, ack?: Ack): void {
    if (this.connection?.readyState !== WebSocket.OPEN) {
      if (ack) ack({ error: 'Not connected to the room. Reconnecting; please try again.' });
      else this.dispatch('app_error', { message: 'Not connected to the room. Reconnecting; please try again.' });
      return;
    }
    const requestId = ack ? String(++this.requestId) : undefined;
    if (requestId && ack) this.pendingAcks.set(requestId, ack);
    this.connection.send(JSON.stringify({ event, payload, requestId }));
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null || !this.session || this.stopped) return;
    const delay = Math.min(500 * 2 ** this.retryCount, 10000);
    this.retryCount += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.openConnection().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private closeConnection(): void {
    const connection = this.connection;
    this.connection = null;
    if (connection && connection.readyState < WebSocket.CLOSING) connection.close(1000, 'Client left room');
  }
}