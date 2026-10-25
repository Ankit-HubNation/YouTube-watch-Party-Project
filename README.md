# WatchTogether: YouTube Watch Party

A React and TypeScript watch-party client with a Cloudflare Workers/Durable Objects backend for synchronized YouTube rooms. The original Express/Socket.IO backend remains available as a legacy fallback.

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
npm install --prefix server/cloudflare
npm install --prefix client
```

Start the Worker and frontend:

```bash
npm run dev
```

On Windows PowerShell:

```powershell
npm run dev
```

Full Working Website: https://watch-party-api.watch-party-cloudflare.workers.dev/

Frontend: http://localhost:5173  

Worker health: http://localhost:8787/health

To run the legacy Express backend instead, configure `server/.env` and run `npm run dev:legacy`.

## Tests and build

Run the Durable Object integration tests and frontend TypeScript/production build:

```bash
npm test --prefix server/cloudflare
npm run build --prefix client
```

There is no separate lint script configured.

## Configuration

Cloudflare Worker local config is in `server/cloudflare/wrangler.toml`. For production, set `CLIENT_ORIGIN` to the exact Cloudflare Pages URL in the Worker dashboard. The Worker rejects browser origins not explicitly listed.

Frontend `client/.env` for deployment:

- `VITE_SERVER_URL=https://YOUR-BACKEND-URL`

Do not put server secrets in `VITE_` variables.

## Deploy to Cloudflare

The Cloudflare API implementation and deployment guide are in [server/cloudflare](server/cloudflare/README.md). It uses Workers with SQLite-backed Durable Objects, so no always-on Node server is needed.

1. Deploy the Worker from `server/cloudflare` with Wrangler or the Cloudflare dashboard.
2. Set the Worker `CLIENT_ORIGIN` variable to your Pages origin.
3. Deploy the static `client` directory to Cloudflare Pages with build command `npm install && npm run build` and output directory `dist`.
4. Set Pages build variable `VITE_SERVER_URL` to the deployed Worker URL and rebuild.
5. Check the Worker `/health` endpoint, then test a room with two browsers.

Cloudflare Workers Free supports SQLite-backed Durable Objects and has daily usage limits. Durable Object WebSockets use hibernation and a reconnect grace period; active usage may still consume quota. Check the current Cloudflare limits before larger launches.

## Other hosting options

- **Render:** the pushed `render.yaml` Blueprint deploys the legacy Express backend and static frontend. Render requires payment information for this workspace.
- **Railway:** can host the legacy Express backend, but free usage is limited; monitor its current quota and billing requirements.
- **Vercel or Netlify:** suitable for the static frontend, paired with the Cloudflare Worker backend.

No live Cloudflare deployment is created automatically; authenticate Wrangler or connect the repository in the Cloudflare dashboard.

## Architecture and limits

The Worker owns room membership, roles, playback state, chat broadcast, and the shared queue in one Durable Object per room. The YouTube IFrame API renders playback in the client; authorized playback events update server state, which is broadcast to room members. Participants cannot control playback by manually emitting client events.

Cloudflare room, queue, and recent chat state persist in Durable Object SQLite. Reconnecting room sessions are token-bound and retained briefly during network interruptions. Recent room/video history remains browser-local. There is no account authentication; room codes are invitations, not authentication. Video titles are not fetched from YouTube Data API; the queue shows a video ID and thumbnail. Chat rate limits are per room session and are not a substitute for production abuse controls. Private rooms/passwords are not implemented. The legacy Express backend still uses in-memory room state and socket-ID membership.

## Manual multi-user checklist

1. Open the app in two browsers, create a room in one, then join by invitation URL or code in the other.
2. Confirm both clients show the same participants and current video, including when the joining client arrives after playback has started.
3. Send chat messages from both clients; confirm both receive them and that a separate room does not receive them.
4. As a participant, attempt playback, room rename, and queue advancement; confirm the server rejects unauthorized actions.
5. Add videos to the shared queue, reorder as host/moderator, play next, and confirm duplicate video-ended events advance only once.
6. Promote a participant, verify moderator playback control, then remove a participant as host.
7. Resize to phone width and switch between People, Chat, and Queue panels; verify there is no horizontal overflow.
