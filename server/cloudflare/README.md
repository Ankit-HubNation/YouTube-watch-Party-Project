# Cloudflare Watch Party API

This is the Cloudflare Workers replacement for the legacy Express/Socket.IO API. Each room is a SQLite-backed Durable Object. The object owns room membership, roles, chat history, queue, and authoritative playback state. Browsers connect using native WebSockets; no Socket.IO server or long-lived process is required.

## Local development

From the repository root:

```powershell
npm install --prefix server/cloudflare
npm install --prefix client
npm run dev
```

The Worker runs at `http://localhost:8787`, and Vite runs at `http://localhost:5173`. Localhost origins are allowed only when the Worker request hostname is localhost; production has no default allowed origin.

Run the Cloudflare-runtime integration suite and client build:

```powershell
npm test --prefix server/cloudflare
npm run build --prefix client
```

## Deploy the API

1. Sign in to Cloudflare and connect the GitHub repository, or authenticate Wrangler with `npx wrangler login`.
2. From `server/cloudflare`, run `npm install` and `npm run deploy`.
3. In the Cloudflare dashboard, set the Worker variable `CLIENT_ORIGIN` to the exact published Pages origin, for example `https://watch-party-web.pages.dev`. Do not use `*` for a production deployment.
4. Redeploy the Worker after setting the origin. Check `https://<worker-name>.<account-subdomain>.workers.dev/health`.
5. On Cloudflare Pages, connect this repository with root directory `client`, build command `npm install && npm run build`, and output directory `dist`. Set the build environment variable `VITE_SERVER_URL` to the Worker URL, then deploy/rebuild.

Cloudflare Workers Free currently includes daily limits for Worker requests and SQLite-backed Durable Objects. Durable Objects support WebSockets; this implementation uses the hibernation API and a brief reconnect grace period. Check current account quotas before inviting larger groups. A connected Durable Object can incur duration usage while active, and free-tier overages are rejected rather than silently billed.

## Protocol and security

- `POST /api/rooms` creates a room and issues a random, session-bound token.
- `POST /api/rooms/:roomId/join` joins an existing room and issues a participant token.
- `GET /api/rooms/:roomId/ws?token=...` upgrades to the room WebSocket after validating that token against Durable Object state.
- Room actions travel as JSON envelopes `{ event, payload, requestId? }`; the UI-facing event names match the previous Socket.IO contract.
- Tokens are random, scoped to one room, and never used to assign roles. Membership and authorization are checked again for every command.
- Rooms and chat persist in Durable Object SQLite; room deletion occurs after the final participant leaves or their reconnect grace expires.

The legacy Express backend remains at `server/src/index.js` and can still be run with `npm run dev:legacy` from the repository root.