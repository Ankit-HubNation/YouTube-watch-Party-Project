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

## Deploy to Render

The repository includes a `render.yaml` Blueprint for both services. It automatically connects the frontend's `VITE_SERVER_URL` to the backend URL and the backend's `CLIENT_ORIGIN` to the frontend URL.

1. Push the project to GitHub and make sure `render.yaml` is on the branch you intend to deploy.
2. Sign in to Render, choose **New > Blueprint**, connect the GitHub repository, and select that branch.
3. Review the two services (`watch-party-api` and `watch-party-web`) and apply the Blueprint. No secret environment values are required.
4. Wait for both initial deploys to complete. Open the `watch-party-api` service's `/health` URL and confirm it returns `status: ok`.
5. Open the `watch-party-web` URL and test room creation, invitation joining, synchronized playback, chat, and queue with two browsers.

The server service is a persistent Node web service, so Socket.IO WebSockets work without serverless adaptation. The client is served as a static site. Render may put a free web service to sleep when idle; its first request after sleeping can take longer. In-memory rooms are lost whenever the backend restarts or sleeps, so this MVP is best for testing and small ephemeral watch parties rather than persistent rooms.

## Other hosting options

- **Railway:** deploy `server` as a Node service (`npm install`, `npm start`) and `client` as a static build (`npm install && npm run build`, output `dist`). Set `CLIENT_ORIGIN` to the public frontend URL and `VITE_SERVER_URL` to the public backend URL.
- **Vercel or Netlify:** suitable for the frontend static build, but keep the Express/Socket.IO backend on a persistent WebSocket-capable service such as Render or Railway. Configure the same two URLs above.

No hosting account or live environment is changed by this repository configuration.

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
