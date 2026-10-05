/**
 * Transport and HTTP: the in-memory image route, /health, the optional client build, the
 * Socket.IO server, and the mapping of socket events onto game.ts. No game rules here.
 */

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import {
  cleanCode,
  type Ack,
  type AddImagePayload,
  type ClientToServerEvents,
  type JoinPayload,
  type RoomSettings,
  type ServerToClientEvents,
  type SubmitMemePayload,
} from './types.js';
import { createRoom, getRoom, joinRoom, type Room } from './rooms.js';
import {
  addImage,
  attach,
  backToLobby,
  castVote,
  dealImages,
  playerArrived,
  playerDisconnected,
  playerLeft,
  removeImage,
  skipPhase,
  startRound,
  submitMeme,
  updateSettings,
  type GameServer,
} from './game.js';

/* ---------------------------------------------------------------------- http */

const app = express();

// Resolved from this file, not the cwd, so `npm start` works from anywhere.
const clientDist = fileURLToPath(new URL('../../client/dist', import.meta.url));
const hasClientBuild = existsSync(join(clientDist, 'index.html'));

app.get('/health', (_req, res) => {
  res.type('text/plain').send('ok');
});

/**
 * This round's pool, straight out of the room objects -- the server never touches the
 * filesystem for them. The URL carries ?v=<round>, so a long cache is safe.
 */
app.get('/img/:code/:imageId', (req, res) => {
  const room = getRoom(cleanCode(req.params.code));
  // Servable for the whole round: the host previews their own picks during `upload` and
  // everyone needs the photo they were dealt. Only the captions are secret, and `publicState`
  // is what keeps those back -- the photos themselves give nothing away.
  const open = room !== undefined && room.phase !== 'lobby';
  const stored = open ? room.pool.get(req.params.imageId) : undefined;
  if (!stored) {
    // no-store so a browser can't hang on to a 404 from before the image existed
    res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('no image');
    return;
  }
  res.set('Content-Type', stored.mime);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(stored.image);
});

if (hasClientBuild) {
  app.use(express.static(clientDist));
  // SPA fallback: anything that isn't one of our own paths renders the client shell.
  app.use((req, res, next) => {
    const isOurs =
      req.path === '/health' || req.path.startsWith('/img/') || req.path.startsWith('/socket.io');
    if (req.method !== 'GET' || isOurs) {
      next();
      return;
    }
    res.sendFile(join(clientDist, 'index.html'));
  });
}

/* -------------------------------------------------------------------- socket */

const httpServer = createServer(app);
const io: GameServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  // addImage carries one compressed photo as a binary frame.
  maxHttpBufferSize: 2_000_000,
  // Reflect the caller's origin so the Vite dev server and a separately hosted client work.
  cors: { origin: true },
});
attach(io);

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Which seat a socket is sitting in. Seats are keyed by playerId; socket ids come and go. */
const seats = new Map<string, { code: string; playerId: string }>();

/** Clients can send anything; coerce at the edge so the rules only ever see strings. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The protocol's `Ack<T>` defaults T to `Record<string, never>`, which no object literal is
 * assignable to, so every reply goes through this one cast to `Ack<unknown>` (the same
 * callback with a shape we can actually pass). It also shrugs off a missing callback instead
 * of throwing inside a handler.
 */
function reply<T = unknown>(ack: unknown): Ack<T> {
  return typeof ack === 'function' ? (ack as Ack<T>) : () => {};
}

function sit(socket: GameSocket, room: Room, playerId: string): void {
  const previous = seats.get(socket.id);
  if (previous && previous.code !== room.code) {
    socket.leave(previous.code);
    // Give up the old seat too. Left behind it stays `connected` with a socket id nothing
    // will ever disconnect, so the old room waits on a player who is never coming back.
    const old = getRoom(previous.code);
    if (old) playerLeft(old, previous.playerId);
  }
  seats.set(socket.id, { code: room.code, playerId });
  socket.join(room.code);
}

/**
 * Every in-room action has the same shape: find the caller's seat, apply a rule, ack it.
 * `T` is whatever extra the ack carries back, so a plain ok/error result is the default.
 */
function action<T = unknown>(
  socket: GameSocket,
  ack: unknown,
  run: (room: Room, playerId: string) => ({ ok: true } & T) | { ok: false; error: string },
): void {
  const done = reply<T>(ack);
  const seat = seats.get(socket.id);
  const room = seat ? getRoom(seat.code) : undefined;
  if (!seat || !room) {
    done({ ok: false, error: 'You are not in a room any more.' });
    return;
  }
  done(run(room, seat.playerId));
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload, ack) => {
    const done = reply<{ code: string }>(ack);
    const p: Partial<JoinPayload> = payload ?? {};
    const playerId = asString(p.playerId);
    if (!playerId) {
      done({ ok: false, error: 'Your browser did not send a player id.' });
      return;
    }
    const created = createRoom(playerId, asString(p.name), socket.id);
    if (!created.ok) {
      done(created);
      return;
    }
    sit(socket, created.room, playerId);
    playerArrived(created.room, playerId);
    done({ ok: true, code: created.room.code });
  });

  socket.on('joinRoom', (payload, ack) => {
    const done = reply<{ code: string }>(ack);
    const p: Partial<JoinPayload & { code: string }> = payload ?? {};
    const playerId = asString(p.playerId);
    if (!playerId) {
      done({ ok: false, error: 'Your browser did not send a player id.' });
      return;
    }
    const room = getRoom(cleanCode(asString(p.code)));
    if (!room) {
      done({ ok: false, error: 'No room with that code. Check the letters?' });
      return;
    }
    // Same playerId joining again is a reconnect: the seat, score and meme come back.
    const joined = joinRoom(room, playerId, asString(p.name), socket.id);
    if (!joined.ok) {
      done(joined);
      return;
    }
    sit(socket, room, playerId);
    playerArrived(room, playerId);
    done({ ok: true, code: room.code });
  });

  socket.on('leaveRoom', () => {
    const seat = seats.get(socket.id);
    if (!seat) return;
    seats.delete(socket.id);
    socket.leave(seat.code);
    const room = getRoom(seat.code);
    if (room) playerLeft(room, seat.playerId);
  });

  socket.on('startRound', (ack) => action(socket, ack, startRound));
  socket.on('skipPhase', (ack) => action(socket, ack, skipPhase));
  socket.on('backToLobby', (ack) => action(socket, ack, backToLobby));

  socket.on('updateSettings', (payload, ack) => {
    const patch: Partial<RoomSettings> = payload ?? {};
    action(socket, ack, (room, playerId) => updateSettings(room, playerId, patch));
  });

  socket.on('addImage', (payload, ack) => {
    const p: Partial<AddImagePayload> = payload ?? {};
    action<{ id: string }>(socket, ack, (room, playerId) =>
      addImage(room, playerId, { image: p.image, mimeType: asString(p.mimeType) }),
    );
  });

  socket.on('removeImage', (payload, ack) => {
    const p: Partial<{ id: string }> = payload ?? {};
    action(socket, ack, (room, playerId) => removeImage(room, playerId, asString(p.id)));
  });

  socket.on('dealImages', (ack) => action(socket, ack, dealImages));

  socket.on('submitMeme', (payload, ack) => {
    const p: Partial<SubmitMemePayload> = payload ?? {};
    action(socket, ack, (room, playerId) =>
      submitMeme(room, playerId, {
        topText: asString(p.topText),
        bottomText: asString(p.bottomText),
      }),
    );
  });

  socket.on('castVote', (payload, ack) => {
    const p: Partial<{ submissionId: string }> = payload ?? {};
    action(socket, ack, (room, playerId) => castVote(room, playerId, asString(p.submissionId)));
  });

  socket.on('disconnect', () => {
    const seat = seats.get(socket.id);
    if (!seat) return;
    seats.delete(socket.id);
    const room = getRoom(seat.code);
    const player = room?.players.get(seat.playerId);
    // A reconnect can land before the old socket's disconnect does, so only the socket that
    // still owns the seat may mark it away.
    if (!room || !player || player.socketId !== socket.id) return;
    playerDisconnected(room, seat.playerId);
  });
});

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, () => {
  console.log(`blober-meme server on http://localhost:${port}`);
  console.log(
    hasClientBuild
      ? `serving the client build from ${clientDist}`
      : 'no client build found, running API only (start the client with Vite)',
  );
});
