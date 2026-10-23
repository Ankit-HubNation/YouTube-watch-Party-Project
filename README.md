# WatchTogether: YouTube Watch Party

A React, TypeScript, Express, and Socket.IO application for watching YouTube videos together in synchronized rooms.

## Features

- Create named rooms with collision-checked share codes and copyable invitation links.
- Join a room by code or invitation URL.
- Synchronize play, pause, seek, video changes, initial player state, and queue-driven transitions.
- Host and moderator playback controls; only the host can assign roles, remove participants, and rename the room.
- Room-scoped real-time chat with server-side payload validation, a 500-character limit, a per-user rate limit, and recent in-memory message history.
- Shared queue with YouTube ID/URL validation, duplicate prevention, suggestions, removal, moderator reordering, host/moderator next-video control, and guarded automatic advancement.
- Responsive room panels for participants, chat, and queue.
- Browser-local recent room and video lists. These are optional convenience history, not server persistence.

## Requirements

Node.js 20 or newer and npm.

## Run locally

From the project root:

```bash
npm install
npm install --prefix server
npm install --prefix client
```

Copy `server/.env.example` to `server/.env`, then start both services:

```bash
npm run dev
```

On Windows PowerShell:

```powershell
Copy-Item server/.env.example server/.env
npm run dev
```

Frontend: http://localhost:5173  
Backend health: http://localhost:4000/health

## Tests and build

Run the backend Socket.IO integration tests and frontend TypeScript/production build:

```bash
npm test --prefix server
npm run build --prefix client
```

There is no separate lint script configured.

## Configuration

Backend `server/.env`:

- `PORT=4000`
- `CLIENT_ORIGIN=http://localhost:5173`

Frontend `client/.env` for deployment:

- `VITE_SERVER_URL=https://YOUR-BACKEND-URL`

Do not put server secrets in `VITE_` variables.

## Deployment

Deploy the backend as a Node web service with `server` as its root directory, install command `npm install`, and start command `npm start`. Set `CLIENT_ORIGIN` to the exact deployed frontend origin and configure HTTPS/WebSocket support in the host.

Deploy the frontend as a static site with `client` as its root directory, build command `npm install && npm run build`, and publish directory `dist`. Set `VITE_SERVER_URL` to the deployed backend URL and rebuild. Verify `/health` and test a room with at least two browsers.

No live environment is changed by this project setup.

## Architecture and limits

The server owns room membership, roles, playback state, chat broadcast, and the shared queue. The YouTube IFrame API renders playback in the client; authorized playback events update server state, which is broadcast to room members. Participants cannot control playback by manually emitting client events.

Room, queue, and recent chat state live in server memory and are cleared when the backend restarts. Recent room/video history lives in the current browser only. Socket IDs identify participants, so there is no account authentication or reconnect identity restoration. Room codes are invitations, not authentication. Video titles are not fetched from the YouTube Data API; the queue shows a video ID and thumbnail. Chat rate limits are per active socket and are not a substitute for production abuse controls. Private rooms/passwords and database persistence are not implemented.

## Manual multi-user checklist

1. Open the app in two browsers, create a room in one, then join by invitation URL or code in the other.
2. Confirm both clients show the same participants and current video, including when the joining client arrives after playback has started.
3. Send chat messages from both clients; confirm both receive them and that a separate room does not receive them.
4. As a participant, attempt playback, room rename, and queue advancement; confirm the server rejects unauthorized actions.
5. Add videos to the shared queue, reorder as host/moderator, play next, and confirm duplicate video-ended events advance only once.
6. Promote a participant, verify moderator playback control, then remove a participant as host.
7. Resize to phone width and switch between People, Chat, and Queue panels; verify there is no horizontal overflow.
