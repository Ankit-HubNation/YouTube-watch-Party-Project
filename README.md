# WatchTogether — YouTube Watch Party

A React + TypeScript frontend and Express + Socket.IO backend for synchronized YouTube watch rooms.

## Features
- Create rooms with a short shareable code and URL.
- Join rooms as a participant.
- Synchronize play, pause, seek, and video changes through Socket.IO.
- Host can promote participants to moderators, demote them, and remove participants.
- Backend validates playback and role-management permissions.
- Responsive dark interface with participant list and a basic local-only chat placeholder.
- Host is reassigned if they leave. Room state is in memory for the MVP.

## Requirements
Node.js 20 or newer and npm.

## Run locally
Open a terminal in this folder:

```bash
npm install
npm install --prefix server
npm install --prefix client
cp server/.env.example server/.env
npm run dev
```

Frontend: http://localhost:5173  
Backend health: http://localhost:4000/health

On Windows PowerShell, copy the env example with:

```powershell
Copy-Item server/.env.example server/.env
```

## Environment variables
Backend (`server/.env`):

- `PORT=4000`
- `CLIENT_ORIGIN=http://localhost:5173`

Frontend (`client/.env` for deployment):

- `VITE_SERVER_URL=https://YOUR-BACKEND-URL`

## Deployment outline
1. Deploy `server` as a Node web service on Render. Build command: `npm install`; start command: `npm start`. Set `CLIENT_ORIGIN` to the deployed frontend URL.
2. Deploy `client` as a static site on Render or Vercel. Build command: `npm install && npm run build`; publish directory: `dist`. Set `VITE_SERVER_URL` to the deployed backend URL.
3. Redeploy the frontend after setting `VITE_SERVER_URL`, then test with two browsers/devices.

## Architecture
The browser embeds the YouTube IFrame Player API. A user's player action emits a Socket.IO event to Express. The server checks the user's role, updates the in-memory room state, and broadcasts `sync_state` to every socket in that room. Clients load the new video, seek to the shared time, and play/pause accordingly. Roles are validated on the server, not only hidden in the UI.

## Limitations / next steps
- Room state is in memory; server restart clears all rooms.
- Chat is a frontend-only placeholder, not shared over sockets.
- User identity is tied to the current Socket.IO connection; this MVP does not implement account authentication or reconnect identity.
- Production should validate YouTube embed availability, handle player state loops carefully, add rate limiting, persistence, and integration tests.
