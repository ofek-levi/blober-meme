# blober-meme

A tiny multiplayer meme game for a group of friends. Everyone gets the same two minutes to
pick a photo off their phone, slap a caption on it, and submit. Then you all vote for the
funniest one and someone wins a point.

No accounts, no database, no app to install — one person runs the server, everyone else opens
a link and types a name.

```
Room  K7PQ

  Ofek   ♛  3
  Daniel     2
  Tom        2
  Avi        0
```

## Layout

Two completely separate apps that happen to share a repo. There is no root `package.json`, no
workspaces and no shared package — each app is installed, run and deployed on its own.

```
client/    Vite + React + TypeScript     the thing you play on
server/    Express + Socket.IO + tsx     the thing that holds the game
```

The Socket.IO protocol is duplicated as `client/src/types.ts` and `server/src/types.ts`. The
two files are identical apart from their header comment and `SubmitMemePayload.image` (the
server's copy also accepts a Node `Buffer`). **If you change one, change the other** — that
duplication is the price of keeping the apps independent.

## Running it

Install once, in each app:

```bash
cd server && npm install
cd ../client && npm install
```

Then two terminals:

```bash
cd server && npm run dev     # http://localhost:3001
cd client && npm run dev     # http://localhost:5173
```

Open http://localhost:5173. That's it — Vite proxies `/socket.io` and `/img` through to the
server, so nothing needs configuring.

### Playing from phones

This is the whole point, and it needs one extra step: your phone has to reach **your
computer**, not its own localhost.

1. Find your machine's LAN IP (`ipconfig` on Windows — the IPv4 address on your wifi adapter,
   something like `192.168.1.50`).
2. On every phone, open `http://192.168.1.50:5173`.
3. Everyone has to be on the same wifi.

The dev server already listens on the LAN (`server.host: true` in `vite.config.ts`), so no
config change is needed. If a phone can't connect, it's almost always Windows Firewall
prompting about Node — allow it on private networks.

### One process instead of two

Build the client and the server will serve it, so there's a single port to share:

```bash
cd client && npm run build
cd ../server && npm start        # http://localhost:3001 — game and API together
```

The server checks for `../client/dist` at boot and logs which mode it's in. It runs fine
without it; the client build is optional.

If you ever host the two halves on different domains, set `VITE_SERVER_URL` when building the
client and it will point its socket there instead of at its own origin.

## Deploying to Render + Vercel

Server on Render, client on Vercel. **Deploy the server first** — you need its URL to build
the client.

### 1. Server → Render

New **Web Service**, pointed at this repo:

| Setting | Value |
| --- | --- |
| Root directory | `server` |
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/health` |

No environment variables needed — Render injects `PORT` and the server reads it. Copy the
resulting URL, e.g. `https://blober-meme.onrender.com`.

### 2. Client → Vercel

Import the same repo:

| Setting | Value |
| --- | --- |
| Root directory | `client` |
| Framework preset | Vite (auto-detected) |
| Build command | `npm run build` (default) |
| Output directory | `dist` (default) |

Add one environment variable:

```
VITE_SERVER_URL = https://blober-meme.onrender.com
```

**It must be `https://`** (a Vercel page can't talk to a plain-http server) **and it is baked
in at build time**, not read at runtime — so if you ever change it, redeploy the client.

That's all the configuration. Socket.IO reflects the caller's origin (`cors: { origin: true }`),
so the Vercel domain is accepted without listing it anywhere, and the client rewrites the
server's relative image paths onto `VITE_SERVER_URL` so memes load across the two domains.

### Render's free tier, and what it costs you

A free Render service **spins down after about 15 minutes with no traffic**, and the whole game
lives in memory. So:

- The first person to open the game after a quiet spell waits ~50s for a cold start.
- **A spin-down ends every game in progress.** Players get bounced to the home screen and have
  to make a new room — scores are gone.

For a game night that's usually fine: once someone's playing, traffic keeps it awake. If it
annoys you, the paid instance type removes the spin-down. Don't bother with an external pinger
to keep it alive — on the free tier that just burns your monthly hours.

## How a round works

The server owns the game. Clients render what they're told and send intents — nothing
important is decided on a phone.

1. **Lobby** — someone creates a room and shares the 4-character code. The host can set the
   two timers. Two players minimum.
2. **Upload** — the host alone picks the photos, as many as they like, and nobody else gets a
   say. Photos are resized and compressed in the browser before upload, so a 4MB phone photo
   goes up as ~400KB. No clock on this one; the host taps "Deal them out" when the pile looks
   right.
3. **Create** — every photo is dealt out at random before any photo is dealt twice, so with
   fewer photos than players some get shared, and with more the spares go unused. You caption
   whatever you were handed. The phase ends early the moment everybody has submitted; you can
   keep editing until it does.
4. **Vote** — all the memes, shuffled, with the authors hidden. You can't vote for your own.
   Ends early once everyone who can vote has.
5. **Results** — winner, the rest ranked by votes, and the running scoreboard. +1 per vote
   received. The host starts another round or goes back to the lobby; scores carry over. The
   next round starts from an empty pile — spare photos are not kept.

Phases also advance on their timers, and the server re-checks "is everyone done?" when someone
disconnects, so one person losing signal can't stall the round.

### Dropped connections

Phones suspend background tabs constantly, so this is handled rather than ignored. Your
identity is a random `playerId` in `sessionStorage`, not your socket — reconnect and you get
your seat, score and submission back. Mid-game you keep your seat for the whole game; in the
lobby you're dropped after 15 seconds. If the host vanishes, the host role moves to someone
still connected. A room with nobody in it is deleted after 90 seconds.

Refreshing the page rejoins you automatically. Opening a *new tab* makes you a new player.

## Knobs

Everything tunable lives at the top of the two `types.ts` files — round lengths, max players,
name and caption lengths, image size caps and the allowed image types. Change both copies.

```ts
MAX_PLAYERS = 12          MAX_NAME_LENGTH = 16       MAX_TEXT_LENGTH = 80
MAX_IMAGE_DIMENSION = 1000       TARGET_IMAGE_BYTES = 400_000
DEFAULT_CREATE_SECONDS = 120     DEFAULT_VOTE_SECONDS = 60
```

Images are JPG, PNG or WebP. iPhone HEIC photos get converted by the browser's file picker in
most cases; if one doesn't, the editor says so instead of failing silently.

## Deliberately not here

No database, no accounts, no login, no persistence, no analytics, no tests, no Docker, no
cloud storage. Rooms and photos live in server memory and nothing is written to disk — photos
exist only for the round they belong to.

**Restarting the server ends every game in progress.** That's fine; tell everyone to rejoin.
