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

## How a round works

The server owns the game. Clients render what they're told and send intents — nothing
important is decided on a phone.

1. **Lobby** — someone creates a room and shares the 4-character code. The host can set the
   two timers. Two players minimum.
2. **Create** — everyone picks a photo and types a top and bottom caption. Photos are resized
   and compressed in the browser before upload, so a 4MB phone photo goes up as ~400KB. The
   phase ends early the moment everybody has submitted; you can keep editing until it does.
3. **Vote** — all the memes, shuffled, with the authors hidden. You can't vote for your own.
   Ends early once everyone who can vote has.
4. **Results** — winner, the rest ranked by votes, and the running scoreboard. +1 per vote
   received. The host starts another round or goes back to the lobby; scores carry over.

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
