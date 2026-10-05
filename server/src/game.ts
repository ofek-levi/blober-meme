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
  MAX_POOL_IMAGES,
  MIN_PLAYERS_TO_START,
  VOTE_SECONDS_OPTIONS,
  cleanText,
  type AddImagePayload,
  type ClientToServerEvents,
  type RoomSettings,
  type ServerToClientEvents,
} from './types.js';
import {
  OK,
  connectedPlayers,
  deleteRoom,
  fail,
  markAway,
  newImageId,
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
  // Someone who joined after the deal holds no photo and so can never submit: waiting on
  // them would hang the phase until the clock runs out.
  const dealt = here.filter((p) => p.imageId !== null);
  // Too few people left who can actually play the round out: let the clock or the host end it,
  // instead of cutting straight to an unvotable results screen the moment somebody's phone
  // drops. Counted over the dealt players, not everyone here, so a late joiner cannot make up
  // the numbers and cut the phase short for someone who is still reconnecting.
  if (dealt.length < MIN_PLAYERS_TO_START) return false;
  if (dealt.some((p) => !p.submission)) return false;
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
  room.pool.clear(); // drops last round's photo Buffers
  for (const player of room.players.values()) {
    player.imageId = null;
    player.submission = null;
    player.votedFor = null;
  }
  room.phase = 'upload';
  // No clock while the host rummages through their camera roll, so the phase bookkeeping
  // `armPhaseTimer` usually does has to happen by hand.
  room.phaseStartedAt = Date.now();
  room.endsAt = null;
  broadcast(room);
  return OK;
}

export interface ImageInput {
  image: AddImagePayload['image'] | undefined;
  mimeType: string;
}

/**
 * Widened like `rooms.createRoom`: this is the one action that acks a value back, so it
 * cannot use `fail()`.
 */
export function addImage(
  room: Room,
  playerId: string,
  input: ImageInput,
): { ok: true; id: string } | { ok: false; error: string } {
  if (room.hostId !== playerId) return { ok: false, error: 'Only the host can pick the photos.' };
  if (room.phase !== 'upload') return { ok: false, error: 'Photos are not being picked right now.' };
  // A flat cap, not one per player: the pile is allowed to be smaller or larger than the
  // room, so all that is left to limit is how many photo Buffers one room holds in memory.
  if (room.pool.size >= MAX_POOL_IMAGES) {
    return { ok: false, error: `The pile is full at ${MAX_POOL_IMAGES} photos.` };
  }

  const image = toBuffer(input.image);
  if (!image) return { ok: false, error: 'That image did not arrive in a format I can read.' };
  if (!ALLOWED_MIMES.includes(input.mimeType)) {
    return { ok: false, error: 'That kind of image is not supported.' };
  }
  if (image.byteLength === 0) return { ok: false, error: 'That image came through empty.' };
  if (image.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: 'That image is too big.' };

  const id = newImageId();
  room.pool.set(id, { image, mime: input.mimeType });
  broadcast(room);
  return { ok: true, id };
}

export function removeImage(room: Room, playerId: string, imageId: string): Result {
  if (room.hostId !== playerId) return fail('Only the host can drop a photo.');
  if (room.phase !== 'upload') return fail('Photos are not being picked right now.');
  if (!room.pool.delete(imageId)) return fail('That photo is not in this round.');
  broadcast(room);
  return OK;
}

export function dealImages(room: Room, playerId: string): Result {
  if (room.hostId !== playerId) return fail('Only the host can deal the photos.');
  if (room.phase !== 'upload') return fail('Photos are not being picked right now.');
  if (room.pool.size === 0) return fail('You need at least one photo to deal.');

  // Everyone with a seat gets one, connected right now or not: `upload` has no clock, so a
  // locked phone is the normal case and the photo should be waiting when it wakes up.
  const seats = [...room.players.values()];
  // `startRound` checked this a phase ago, but `upload` is untimed -- the room can drain to one
  // person in between, and a solo round is a dead end nobody asked for.
  if (seats.length < MIN_PLAYERS_TO_START) {
    return fail(`You need ${MIN_PLAYERS_TO_START} players in the room to deal.`);
  }

  // Deal into a clean round, so nobody keeps a photo or a caption from an earlier attempt.
  for (const player of seats) {
    player.imageId = null;
    player.submission = null;
    player.votedFor = null;
  }
  // The seats are shuffled too, not just the pile: `dealOrder` hands out whole passes of the
  // pile, so dealing in seat order would guarantee the first few seats different photos from
  // each other and leave the repeats always landing on the same seats.
  const order = shuffled(seats);
  const deal = dealOrder([...room.pool.keys()], order.length);
  order.forEach((player, i) => {
    player.imageId = deal[i];
  });

  room.phase = 'create';
  armPhaseTimer(room, room.settings.createSeconds);
  broadcast(room);
  return OK;
}

/**
 * One image id per player: which photo the player at each position of the deal gets.
 *
 * The pile can be any size next to the room, and every photo must be dealt once before any
 * photo is dealt twice. So the pile is dealt in whole passes -- a fresh shuffle of all of it,
 * appended until there are enough ids, then cut to the number of players. Each complete pass
 * contributes every photo exactly once, so coverage and a balanced split fall out of that
 * (3 photos to 7 players is 3-2-2, never 4-2-1), and reshuffling per pass is what keeps both
 * the spares that go unused and the photo that gets the extra use random.
 */
function dealOrder(imageIds: readonly string[], players: number): string[] {
  const deal: string[] = [];
  // `dealImages` rejects an empty pile before here; this keeps the loop below from spinning
  // forever for any other caller.
  if (imageIds.length === 0) return deal;
  while (deal.length < players) deal.push(...shuffled(imageIds));
  return deal.slice(0, players);
}

/** Fisher-Yates. Used for the pile and for the seats, hence generic. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface MemeInput {
  topText: string;
  bottomText: string;
}

export function submitMeme(room: Room, playerId: string, input: MemeInput): Result {
  if (room.phase !== 'create') return fail('Memes are closed right now.');
  const player = room.players.get(playerId);
  if (!player) return fail('You are not in this room.');
  // A late joiner has nothing to caption: they are in for the vote and the next round.
  if (!player.imageId) return fail('You were not dealt a photo this round.');

  player.submission = {
    topText: cleanText(input.topText),
    bottomText: cleanText(input.bottomText),
  };

  if (!endCreateIfEveryoneSubmitted(room)) broadcast(room);
  return OK;
}

/** Socket.IO hands binary over as a Buffer, but a client could send an ArrayBuffer. */
function toBuffer(image: ImageInput['image']): Buffer | null {
  if (!image) return null;
  if (Buffer.isBuffer(image)) return image;
  if (image instanceof ArrayBuffer) return Buffer.from(new Uint8Array(image));
  return null;
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
  // Also the only way out of `upload`: that phase has no clock, no skip and no timer settings,
  // so without this an accidental "Pick the photos" tap strands the whole room there.
  if (room.phase !== 'results' && room.phase !== 'upload') {
    return fail('You can only do that from the results or while picking photos.');
  }
  clearPhaseTimer(room);
  room.phase = 'lobby';
  room.phaseStartedAt = Date.now();
  room.endsAt = null;
  room.pool.clear(); // the round is over: let its photo Buffers go now, not next round
  for (const player of room.players.values()) {
    player.imageId = null;
    player.submission = null;
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
