/**
 * The game engine: phase transitions, the one timer per room, and scoring.
 *
 * Every rule lives here and returns an ack-shaped `Result` instead of throwing, and every
 * mutation ends with a broadcast of the sanitised state. index.ts only translates socket
 * events into these calls.
 */

import type { Server } from 'socket.io';
import {
  ALLOWED_IMAGE_TYPES,
  CREATE_SECONDS_OPTIONS,
  MAX_IMAGE_BYTES,
  MIN_PLAYERS_TO_START,
  VOTE_SECONDS_OPTIONS,
  cleanText,
  type ClientToServerEvents,
  type RoomSettings,
  type ServerToClientEvents,
  type SubmitMemePayload,
} from './types.js';
import {
  OK,
  connectedPlayers,
  deleteRoom,
  fail,
  markAway,
  publicState,
  removePlayer,
  rooms,
  voteCounts,
  type Result,
  type Room,
  type RoomPlayer,
} from './rooms.js';

export type GameServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** How long a disconnected player keeps a seat in the lobby. */
const LOBBY_DROP_MS = 15_000;
/** How long a room with nobody connected survives -- a whole group in a lift gets back in. */
const EMPTY_ROOM_MS = 90_000;
/** A skip that arrives this soon after a phase change was aimed at the phase before it. */
const SKIP_GRACE_MS = 1_000;

/** Widened once so a client-supplied string can be checked against it. */
const ALLOWED_MIMES: readonly string[] = ALLOWED_IMAGE_TYPES;

let io: GameServer | null = null;

export function attach(server: GameServer): void {
  io = server;
}

export function broadcast(room: Room): void {
  io?.to(room.code).emit('state', publicState(room));
}

/* --------------------------------------------------------------------- timers */

function clearPhaseTimer(room: Room): void {
  if (!room.phaseTimer) return;
  clearTimeout(room.phaseTimer);
  room.phaseTimer = null;
}

/** Exactly one phase timer per room: arming always clears whatever was running. */
function armPhaseTimer(room: Room, seconds: number): void {
  clearPhaseTimer(room);
  const ms = seconds * 1000;
  room.phaseStartedAt = Date.now();
  room.endsAt = Date.now() + ms;
  const phase = room.phase;
  const round = room.round;
  room.phaseTimer = setTimeout(() => {
    room.phaseTimer = null;
    // A late timer must do nothing if its room or its phase has already moved on.
    if (rooms.get(room.code) !== room || room.phase !== phase || room.round !== round) return;
    endPhase(room);
  }, ms);
}

function clearDropTimer(room: Room, playerId: string): void {
  const timer = room.dropTimers.get(playerId);
  if (!timer) return;
  clearTimeout(timer);
  room.dropTimers.delete(playerId);
}

function armDropTimer(room: Room, playerId: string): void {
  clearDropTimer(room, playerId);
  const timer = setTimeout(() => {
    room.dropTimers.delete(playerId);
    const player = room.players.get(playerId);
    if (rooms.get(room.code) !== room || !player || player.connected || room.phase !== 'lobby') {
      return;
    }
    removePlayer(room, playerId);
    broadcast(room);
  }, LOBBY_DROP_MS);
  room.dropTimers.set(playerId, timer);
}

function clearEmptyTimer(room: Room): void {
  if (!room.emptyTimer) return;
  clearTimeout(room.emptyTimer);
  room.emptyTimer = null;
}

function armEmptyTimer(room: Room): void {
  if (room.emptyTimer) return; // already counting down
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    if (rooms.get(room.code) !== room || connectedPlayers(room).length > 0) return;
    closeRoom(room, 'The room went quiet and closed.');
  }, EMPTY_ROOM_MS);
}

function clearAllTimers(room: Room): void {
  clearPhaseTimer(room);
  clearEmptyTimer(room);
  for (const timer of room.dropTimers.values()) clearTimeout(timer);
  room.dropTimers.clear();
}

export function closeRoom(room: Room, reason: string): void {
  clearAllTimers(room);
  io?.to(room.code).emit('roomClosed', { reason });
  // Codes get recycled, so don't leave stale sockets sitting in this one.
  io?.in(room.code).socketsLeave(room.code);
  deleteRoom(room);
}

/* ------------------------------------------------------------- phase machine */

/** The one path out of a timed phase: the timer, `skipPhase` and the early-advance checks. */
function endPhase(room: Room): void {
  if (room.phase === 'create') endCreate(room);
  else if (room.phase === 'vote') enterResults(room);
}

function endCreate(room: Room): void {
  // Nothing anyone could vote on (no memes, or one meme and its author is alone here).
  if (eligibleVoters(room).length === 0) {
    enterResults(room);
    return;
  }
  room.phase = 'vote';
  armPhaseTimer(room, room.settings.voteSeconds);
  broadcast(room);
}

function enterResults(room: Room): void {
  clearPhaseTimer(room);
  room.phase = 'results';
  room.phaseStartedAt = Date.now();
  room.endsAt = null;
  // Scoring happens exactly here, so it can only be applied once per round.
  for (const [authorId, votes] of voteCounts(room)) {
    const author = room.players.get(authorId);
    if (author) author.score += votes;
  }
  broadcast(room);
}

function countSubmissions(room: Room): number {
  let total = 0;
  for (const player of room.players.values()) if (player.submission) total++;
  return total;
}

/** You can vote if there is at least one meme in the round that is not your own. */
function eligibleVoters(room: Room): RoomPlayer[] {
  const total = countSubmissions(room);
  return connectedPlayers(room).filter((p) => total - (p.submission ? 1 : 0) > 0);
}

/** Returns true when it advanced the phase (and therefore already broadcast). */
function endCreateIfEveryoneSubmitted(room: Room): boolean {
  if (room.phase !== 'create') return false;
  const here = connectedPlayers(room);
  // Too few people left to play the round out: let the clock or the host end it, instead of
  // cutting straight to an unvotable results screen the moment somebody's phone drops.
  if (here.length < MIN_PLAYERS_TO_START) return false;
  if (here.some((p) => !p.submission)) return false;
  endCreate(room);
  return true;
}

/** Returns true when it advanced the phase (and therefore already broadcast). */
function endVoteIfEveryoneVoted(room: Room): boolean {
  if (room.phase !== 'vote') return false;
  if (connectedPlayers(room).length === 0) return false;
  const voters = eligibleVoters(room);
  if (voters.some((p) => !p.votedFor)) return false;
  // An empty voter list means nobody here can vote at all, so waiting would just hang.
  enterResults(room);
  return true;
}

/** Losing or gaining a player can complete a phase: whoever is left may all be done. */
function advanceAfterRosterChange(room: Room): boolean {
  if (room.phase === 'create') return endCreateIfEveryoneSubmitted(room);
  if (room.phase === 'vote') return endVoteIfEveryoneVoted(room);
  return false;
}

/* ------------------------------------------------------------------- actions */

export function startRound(room: Room, playerId: string): Result {
  if (room.hostId !== playerId) return fail('Only the host can start a round.');
  if (room.phase !== 'lobby' && room.phase !== 'results') return fail('A round is already running.');
  if (connectedPlayers(room).length < MIN_PLAYERS_TO_START) {
    return fail(`You need ${MIN_PLAYERS_TO_START} players in the room to start.`);
  }

  clearPhaseTimer(room);
  room.round += 1;
  for (const player of room.players.values()) {
    player.submission = null; // drops last round's image Buffer
    player.votedFor = null;
  }
  room.phase = 'create';
  armPhaseTimer(room, room.settings.createSeconds);
  broadcast(room);
  return OK;
}

export interface MemeInput {
  image: SubmitMemePayload['image'] | undefined;
  mimeType: string;
  topText: string;
  bottomText: string;
}

export function submitMeme(room: Room, playerId: string, input: MemeInput): Result {
  if (room.phase !== 'create') return fail('Memes are closed right now.');
  const player = room.players.get(playerId);
  if (!player) return fail('You are not in this room.');

  const image = toBuffer(input.image);
  if (image === 'unusable') return fail('That image did not arrive in a format I can read.');

  const topText = cleanText(input.topText);
  const bottomText = cleanText(input.bottomText);

  if (image) {
    if (!ALLOWED_MIMES.includes(input.mimeType)) return fail('That kind of image is not supported.');
    if (image.byteLength === 0) return fail('That image came through empty.');
    if (image.byteLength > MAX_IMAGE_BYTES) return fail('That image is too big.');
    player.submission = { image, mime: input.mimeType, topText, bottomText };
  } else {
    // A null image means "keep the photo I already sent" -- a text-only edit.
    const existing = player.submission;
    if (!existing) return fail('Pick a photo first.');
    player.submission = { ...existing, topText, bottomText };
  }

  if (!endCreateIfEveryoneSubmitted(room)) broadcast(room);
  return OK;
}

/** Socket.IO hands binary over as a Buffer, but a client could send an ArrayBuffer. */
function toBuffer(image: MemeInput['image']): Buffer | null | 'unusable' {
  if (!image) return null;
  if (Buffer.isBuffer(image)) return image;
  if (image instanceof ArrayBuffer) return Buffer.from(new Uint8Array(image));
  return 'unusable';
}

export function castVote(room: Room, playerId: string, submissionId: string): Result {
  if (room.phase !== 'vote') return fail('Voting is not open right now.');
  const voter = room.players.get(playerId);
  if (!voter) return fail('You are not in this room.');
  if (voter.votedFor) return fail('You already voted.');

  // One meme per player per round, so a submission id is its author's playerId.
  const author = room.players.get(submissionId);
  if (!author || !author.submission) return fail('That meme is not in this round.');
  if (author.id === voter.id) return fail('You cannot vote for your own meme.');

  voter.votedFor = author.id;
  if (!endVoteIfEveryoneVoted(room)) broadcast(room);
  return OK;
}

export function skipPhase(room: Room, playerId: string): Result {
  if (room.hostId !== playerId) return fail('Only the host can skip ahead.');
  if (room.phase !== 'create' && room.phase !== 'vote') {
    return fail('There is nothing to skip right now.');
  }
  // `skipPhase` carries no phase, so a tap already in flight when the round moved on would
  // skip a phase nobody has seen yet. A skip this fresh was aimed at the phase before it.
  if (Date.now() - room.phaseStartedAt < SKIP_GRACE_MS) {
    return fail('Hang on — the round just moved on.');
  }
  endPhase(room);
  return OK;
}

export function backToLobby(room: Room, playerId: string): Result {
  if (room.hostId !== playerId) return fail('Only the host can go back to the lobby.');
  if (room.phase !== 'results') return fail('You can only do that from the results.');
  clearPhaseTimer(room);
  room.phase = 'lobby';
  room.phaseStartedAt = Date.now();
  room.endsAt = null;
  for (const player of room.players.values()) {
    player.submission = null; // the round is over: let its image Buffers go now, not next round
    // A seat that went away mid-round never got the lobby grace, so give it that grace here.
    // Otherwise it sits in the lobby forever and keeps the next round from ever starting.
    if (!player.connected) armDropTimer(room, player.id);
  }
  broadcast(room);
  return OK;
}

export function updateSettings(room: Room, playerId: string, patch: Partial<RoomSettings>): Result {
  if (room.hostId !== playerId) return fail('Only the host can change the timers.');
  if (room.phase !== 'lobby') return fail('Timers can only change in the lobby.');

  const { createSeconds, voteSeconds } = patch;
  if (createSeconds !== undefined) {
    if (!CREATE_SECONDS_OPTIONS.includes(createSeconds)) {
      return fail('That is not one of the timer options.');
    }
    room.settings.createSeconds = createSeconds;
  }
  if (voteSeconds !== undefined) {
    if (!VOTE_SECONDS_OPTIONS.includes(voteSeconds)) {
      return fail('That is not one of the timer options.');
    }
    room.settings.voteSeconds = voteSeconds;
  }
  broadcast(room);
  return OK;
}

/* -------------------------------------------------------- comings and goings */

/** A socket took a seat: a fresh join, or a reconnect reclaiming one. */
export function playerArrived(room: Room, playerId: string): void {
  clearDropTimer(room, playerId);
  clearEmptyTimer(room);
  broadcast(room);
}

export function playerDisconnected(room: Room, playerId: string): void {
  markAway(room, playerId);
  // The lobby list should stay honest, so a no-show loses their lobby seat. Mid-game a seat
  // (score, meme, vote) is kept for the rest of the game.
  if (room.phase === 'lobby') armDropTimer(room, playerId);
  if (connectedPlayers(room).length === 0) armEmptyTimer(room);
  if (!advanceAfterRosterChange(room)) broadcast(room);
}

export function playerLeft(room: Room, playerId: string): void {
  clearDropTimer(room, playerId);
  removePlayer(room, playerId);
  if (room.players.size === 0) {
    closeRoom(room, 'Everyone left the room.');
    return;
  }
  if (connectedPlayers(room).length === 0) armEmptyTimer(room);
  if (!advanceAfterRosterChange(room)) broadcast(room);
}
