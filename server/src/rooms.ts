/**
 * The room store: one Map of in-memory rooms, the membership rules, and the single
 * sanitised projection (`publicState`) that clients are allowed to see.
 *
 * Nothing here knows about sockets or timers -- game.ts owns the clock, index.ts owns the
 * transport. Players are keyed by `playerId`, never by socket id, so a dropped socket can
 * reclaim its seat.
 */

import {
  DEFAULT_CREATE_SECONDS,
  DEFAULT_VOTE_SECONDS,
  MAX_PLAYERS,
  ROOM_CODE_LENGTH,
  cleanName,
  type Phase,
  type Player,
  type PublicSubmission,
  type RoomSettings,
  type RoomState,
} from './types.js';

/** Ack-shaped result; game.ts and index.ts hand these straight back to the client. */
export type Result = { ok: true } | { ok: false; error: string };

export const OK: Result = { ok: true };

export function fail(error: string): Result {
  return { ok: false, error };
}

export interface StoredSubmission {
  /** Memory only, never disk. Served by GET /img/:code/:playerId. */
  image: Buffer;
  mime: string;
  topText: string;
  bottomText: string;
}

export interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  /** Changes on every reconnect; only used to tell two sockets of one seat apart. */
  socketId: string | null;
  /** This round's meme, or null. */
  submission: StoredSubmission | null;
  /** The playerId they voted for this round, or null. */
  votedFor: string | null;
}

export interface Room {
  code: string;
  hostId: string;
  phase: Phase;
  round: number;
  /** Insertion ordered, keyed by playerId. */
  players: Map<string, RoomPlayer>;
  settings: RoomSettings;
  endsAt: number | null;
  /**
   * When the current phase began. `skipPhase` carries no phase in the protocol, so this is
   * how a host tap that crossed a phase boundary in flight is told from a deliberate one.
   */
  phaseStartedAt: number;
  /** The one phase timer. game.ts arms and clears it. */
  phaseTimer: ReturnType<typeof setTimeout> | null;
  /** Lobby-only "they are not coming back" timers, per player. */
  dropTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Armed while nobody is connected; deletes the room when it fires. */
  emptyTimer: ReturnType<typeof setTimeout> | null;
}

export const rooms = new Map<string, Room>();

/** No O/0/I/1: codes get read out loud and typed on phones. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function newPlayer(id: string, name: string, socketId: string): RoomPlayer {
  return { id, name, connected: true, score: 0, socketId, submission: null, votedFor: null };
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code);
}

export function connectedPlayers(room: Room): RoomPlayer[] {
  return [...room.players.values()].filter((p) => p.connected);
}

export function createRoom(
  playerId: string,
  rawName: string,
  socketId: string,
): { ok: true; room: Room } | { ok: false; error: string } {
  const name = cleanName(rawName);
  if (!name) return { ok: false, error: 'Type a name first.' };

  const room: Room = {
    code: newCode(),
    hostId: playerId,
    phase: 'lobby',
    round: 0,
    players: new Map(),
    settings: { createSeconds: DEFAULT_CREATE_SECONDS, voteSeconds: DEFAULT_VOTE_SECONDS },
    endsAt: null,
    phaseStartedAt: Date.now(),
    phaseTimer: null,
    dropTimers: new Map(),
    emptyTimer: null,
  };
  room.players.set(playerId, newPlayer(playerId, name, socketId));
  rooms.set(room.code, room);
  return { ok: true, room };
}

/** Joining is also how reconnecting works: the same playerId reclaims its seat. */
export function joinRoom(room: Room, playerId: string, rawName: string, socketId: string): Result {
  const name = cleanName(rawName);
  if (!name) return fail('Type a name first.');

  const nameTaken = [...room.players.values()].some(
    (p) => p.id !== playerId && p.name.toLowerCase() === name.toLowerCase(),
  );
  if (nameTaken) return fail('Someone in that room is already called that.');

  const seated = room.players.get(playerId);
  if (seated) {
    // Reclaiming: keep the score, the meme and the vote, just take the new socket.
    seated.name = name;
    seated.connected = true;
    seated.socketId = socketId;
    reassignHost(room);
    return OK;
  }

  if (room.players.size >= MAX_PLAYERS) return fail('That room is full.');
  room.players.set(playerId, newPlayer(playerId, name, socketId));
  reassignHost(room);
  return OK;
}

/** Their socket went away, but the seat (score, meme, vote) stays. */
export function markAway(room: Room, playerId: string): void {
  const player = room.players.get(playerId);
  if (!player) return;
  player.connected = false;
  player.socketId = null;
  reassignHost(room);
}

/** Gone for good: `leaveRoom`, or a lobby no-show whose grace ran out. */
export function removePlayer(room: Room, playerId: string): void {
  const player = room.players.get(playerId);
  if (player) player.submission = null; // let the image Buffer go
  room.players.delete(playerId);
  reassignHost(room);
}

/** The host has to be someone who is actually here. */
export function reassignHost(room: Room): void {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  const next = connectedPlayers(room)[0];
  // With nobody connected the stale hostId is harmless: whoever comes back takes over.
  if (next) room.hostId = next.id;
}

export function deleteRoom(room: Room): void {
  for (const player of room.players.values()) player.submission = null;
  room.players.clear();
  rooms.delete(room.code);
}

/** Votes received per author, counting only memes still in the round. */
export function voteCounts(room: Room): Map<string, number> {
  const counts = new Map<string, number>();
  for (const voter of room.players.values()) {
    if (!voter.votedFor) continue;
    const author = room.players.get(voter.votedFor);
    if (!author || !author.submission) continue;
    counts.set(author.id, (counts.get(author.id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Deterministic but deliberately not join order: everyone sees the same list, and a
 * position in it says nothing about who made the meme.
 */
export function roundSubmissions(
  room: Room,
): Array<{ player: RoomPlayer; submission: StoredSubmission }> {
  const entries = [...room.players.values()].flatMap((player) =>
    player.submission
      ? [{ player, submission: player.submission, key: shuffleKey(room.round, player.id) }]
      : [],
  );
  entries.sort((a, b) => a.key - b.key || a.player.id.localeCompare(b.player.id));
  return entries.map(({ player, submission }) => ({ player, submission }));
}

/** FNV-1a over "round:playerId" -- a stable shuffle that reshuffles every round. */
function shuffleKey(round: number, playerId: string): number {
  const seed = `${round}:${playerId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function idsWhere(room: Room, match: (p: RoomPlayer) => boolean): string[] {
  return [...room.players.values()].filter(match).map((p) => p.id);
}

/**
 * The only thing ever broadcast. Memes stay hidden until voting, live tallies stay hidden
 * until results, and image bytes are never in here -- only round-versioned URLs.
 */
export function publicState(room: Room): RoomState {
  const players: Player[] = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    score: p.score,
  }));

  const reveal = room.phase === 'vote' || room.phase === 'results';
  const counts = room.phase === 'results' ? voteCounts(room) : null;
  const submissions: PublicSubmission[] = reveal
    ? roundSubmissions(room).map(({ player, submission }) => ({
        id: player.id,
        playerName: player.name,
        imageUrl: `/img/${room.code}/${player.id}?v=${room.round}`,
        topText: submission.topText,
        bottomText: submission.bottomText,
        votes: counts?.get(player.id) ?? 0,
      }))
    : [];

  const inRound = room.phase !== 'lobby';
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    players,
    settings: { ...room.settings },
    endsAt: room.phase === 'create' || room.phase === 'vote' ? room.endsAt : null,
    serverNow: Date.now(),
    submittedIds: inRound ? idsWhere(room, (p) => p.submission !== null) : [],
    votedIds: inRound ? idsWhere(room, (p) => p.votedFor !== null) : [],
    submissions,
  };
}
