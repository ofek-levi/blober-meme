/**
 * The client's copy of the wire protocol: socket events, room state and limits.
 *
 * The client and the server are two separate apps with no shared package, so this
 * file is mirrored at server/src/types.ts. If you change one, change the other.
 */

/* ------------------------------------------------------------------ limits */

export const MAX_NAME_LENGTH = 16;
export const MAX_TEXT_LENGTH = 80;
export const MAX_PLAYERS = 50;
export const MIN_PLAYERS_TO_START = 2;
export const ROOM_CODE_LENGTH = 4;

/**
 * Most photos the host may put in one round's pile. The pile is free to be smaller than the
 * room -- fewer photos than players just means some photos get dealt to more than one person.
 */
export const MAX_POOL_IMAGES = 30;

/** Hard cap the server enforces on an uploaded image, after client compression. */
export const MAX_IMAGE_BYTES = 1_500_000;
/** What the client aims for when compressing. */
export const TARGET_IMAGE_BYTES = 400_000;
/** Longest edge the client resizes down to before uploading. */
export const MAX_IMAGE_DIMENSION = 1000;

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export const DEFAULT_CREATE_SECONDS = 120;
export const DEFAULT_VOTE_SECONDS = 60;
export const CREATE_SECONDS_OPTIONS = [60, 90, 120, 180, 300];
export const VOTE_SECONDS_OPTIONS = [30, 45, 60, 90, 120];

/* ------------------------------------------------------------------- state */

export type Phase = 'lobby' | 'upload' | 'create' | 'vote' | 'results';

export interface Player {
  id: string;
  name: string;
  /** False while their socket is away; they keep their seat, score and submission. */
  connected: boolean;
  score: number;
}

export interface RoomSettings {
  createSeconds: number;
  voteSeconds: number;
}

/** One of the host's photos for this round, before it has been dealt to anyone. */
export interface PoolImage {
  id: string;
  /** Path on the server, already cache-busted for this round. */
  imageUrl: string;
}

/**
 * Which of the host's photos a player has to caption this round.
 *
 * Two players CAN share an `imageId`: when the pile holds fewer photos than there are
 * players, every photo is dealt once before any photo is dealt twice, so duplicates only
 * start after the whole pile is in play.
 */
export interface Assignment {
  playerId: string;
  imageId: string;
  imageUrl: string;
}

export interface PublicSubmission {
  /** One submission per player per round, so this is the player's id. */
  id: string;
  playerName: string;
  /** Path on the server, already cache-busted for this round. */
  imageUrl: string;
  topText: string;
  bottomText: string;
  /** Only filled in during `results`. */
  votes: number;
}

/**
 * The whole visible game. Broadcast to everyone in the room on every change,
 * so it must stay small: image bytes are never in here, only URLs.
 */
export interface RoomState {
  code: string;
  hostId: string;
  phase: Phase;
  round: number;
  players: Player[];
  settings: RoomSettings;

  /** Epoch ms when the current phase auto-advances, or null if it has no timer. */
  endsAt: number | null;
  /** Server clock at send time, so clients can correct for device clock skew. */
  serverNow: number;

  /**
   * During `upload`: the photos the host has picked so far. Any size from 1 to
   * `MAX_POOL_IMAGES` -- it does not have to match the number of players. Empty elsewhere.
   */
  pool: PoolImage[];
  /** During `create`: which photo each player was dealt. Empty in every other phase. */
  assignments: Assignment[];

  /** During `create`: who is already done. */
  submittedIds: string[];
  /** During `vote`: who has voted. */
  votedIds: string[];
  /** Filled in during `vote` and `results`; empty otherwise. */
  submissions: PublicSubmission[];
}

/* ------------------------------------------------------------------ events */

export type Ack<T = Record<string, never>> = (
  res: ({ ok: true } & T) | { ok: false; error: string }
) => void;

export interface JoinPayload {
  /** Stable per browser tab, so a dropped socket can reclaim its seat. */
  playerId: string;
  name: string;
}

export interface SubmitMemePayload {
  topText: string;
  bottomText: string;
}

export interface AddImagePayload {
  /** Raw compressed image bytes for one photo. */
  image: ArrayBuffer;
  mimeType: string;
}

export interface ClientToServerEvents {
  createRoom: (p: JoinPayload, ack: Ack<{ code: string }>) => void;
  joinRoom: (p: JoinPayload & { code: string }, ack: Ack<{ code: string }>) => void;
  leaveRoom: () => void;

  /** Host only: from `lobby` or `results` into `upload`, so the host can pick photos. */
  startRound: (ack: Ack) => void;
  /** Host only: stop waiting and move the phase along. */
  skipPhase: (ack: Ack) => void;
  /** Host only: from `results` back to the lobby. */
  backToLobby: (ack: Ack) => void;
  /** Host only, lobby only. */
  updateSettings: (p: Partial<RoomSettings>, ack: Ack) => void;

  /** Host only, `upload` phase: add one photo to this round's pool. */
  addImage: (p: AddImagePayload, ack: Ack<{ id: string }>) => void;
  /** Host only, `upload` phase: drop a photo again. */
  removeImage: (p: { id: string }, ack: Ack) => void;
  /** Host only, `upload` phase: deal the pool out at random and start the caption clock. */
  dealImages: (ack: Ack) => void;

  submitMeme: (p: SubmitMemePayload, ack: Ack) => void;
  castVote: (p: { submissionId: string }, ack: Ack) => void;
}

export interface ServerToClientEvents {
  state: (s: RoomState) => void;
  /** The room went away under us (server restart, everyone left, host closed it). */
  roomClosed: (p: { reason: string }) => void;
}

/* ----------------------------------------------------------------- helpers */

/** Normalise a display name the same way on both sides. */
export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/** Normalise a typed room code the same way on both sides. */
export function cleanCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function cleanText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trimStart().slice(0, MAX_TEXT_LENGTH);
}
