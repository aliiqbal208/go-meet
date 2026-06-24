# go-meet

A Google Meet-style multi-party video conferencing app: a Go [Pion](https://github.com/pion/webrtc)
SFU that fans out each participant's audio and video to everyone else in the same room,
with a React + TypeScript frontend.

Features: multi-party audio/video, Meet-style meeting links (start a meeting, share the
link, others join the same room), in-call chat, mute and camera-off indicators,
active-speaker highlight, and a pre-join device preview with camera/mic selection.
See [UPGRADE.md](UPGRADE.md) for architecture and history.

## Prerequisites

- Go 1.26+
- Node 20+ and npm

## Run

```sh
git clone https://github.com/aliiqbal208/go-meet.git
cd go-meet
```

### Development (two terminals, hot reload)

```sh
# Terminal 1 — backend (Go SFU)
cd server
PORT=8088 go run .

# Terminal 2 — frontend (Vite dev server)
cd frontend
npm install        # first time only
npm run dev        # http://localhost:5173
```

Open http://localhost:5173, click **Start a new meeting**, then **Copy link** and open
that link in another tab (or send it to someone). Everyone who opens the link joins the
same room. Use **different display names** per participant.

### Production (single process)

```sh
cd frontend && npm run build      # outputs frontend/dist
cd ../server && PORT=8088 go run .  # Go serves the built frontend at /
# open http://localhost:8088
```

## Configuration

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `PORT` | server | `8088` | HTTP / WebSocket listen port |
| `VITE_SFU_TARGET` | frontend dev | `http://localhost:8088` | Backend the Vite `/ws` proxy points at |

## Project layout

```
server/     Go SFU — main.go (routes + signaling), sfu.go (rooms + fan-out), signal.go (WS types)
frontend/   React app — src/sfu.ts (client), src/App.tsx (UI), src/index.css (styles)
```

## Notes

This is a demo. Before production, restrict the WebSocket `CheckOrigin`, add
authentication, and configure a TURN server for restrictive NATs. See the
"Known limitations" in [UPGRADE.md](UPGRADE.md).
