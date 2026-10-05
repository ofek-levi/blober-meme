/**
 * The whole client/server relationship in one file: the socket singleton, the room
 * state it produces, and the actions the screens call. No UI lives here.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  cleanCode,
  cleanName,
  ROOM_CODE_LENGTH,
  type ClientToServerEvents,
  type Player,
  type RoomSettings,
  type RoomState,
  type ServerToClientEvents,
  type SubmitMemePayload,
} from './types';

export type ActionResult = { ok: true } | { ok: false; error: string };

export interface Game {
  connected: boolean;
  playerId: string;
  state: RoomState | null;
  me: Player | null;
  isHost: boolean;
  secondsLeft: number | null;
  phaseTotalSeconds: number;
  notice: string | null;
  dismissNotice(): void;

  createRoom(name: string): Promise<ActionResult & { code?: string }>;
  joinRoom(code: string, name: string): Promise<ActionResult & { code?: string }>;
  leaveRoom(): void;
  startRound(): Promise<ActionResult>;
  skipPhase(): Promise<ActionResult>;
  backToLobby(): Promise<ActionResult>;
  updateSettings(s: Partial<RoomSettings>): Promise<ActionResult>;
  submitMeme(p: SubmitMemePayload): Promise<ActionResult>;
  castVote(submissionId: string): Promise<ActionResult>;
}

type CodeResult = ActionResult & { code?: string };
type Failure = { ok: false; error: string };
/** What createRoom/joinRoom actually get back, as a plain union so `res.ok` narrows. */
type JoinAck = { ok: true; code: string } | Failure;

const KEY_PLAYER_ID = 'blober:playerId';
const KEY_NAME = 'blober:name';
const KEY_CODE = 'blober:code';

/** How long we wait for an ack before telling the UI something went wrong. */
const ACK_TIMEOUT_MS = 8000;
const NO_ANSWER = 'The server is not answering. Check your connection and try again.';
const OFFLINE = 'You are offline — that did not go through.';

/* ------------------------------------------------------------------ storage */
// Safari in private mode throws on every sessionStorage access, so each one is guarded.

function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* no persistence available; this tab still plays fine, it just cannot rejoin */
  }
}

function clearStored(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}

/**
 * crypto.randomUUID only exists in a secure context, and phones reach the dev server
 * over plain http://192.168.x.x, so fall back to getRandomValues (available everywhere).
 */
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function loadPlayerId(): string {
  const stored = readStored(KEY_PLAYER_ID);
  if (stored) return stored;
  const fresh = randomId();
  writeStored(KEY_PLAYER_ID, fresh);
  return fresh;
}

/* ------------------------------------------------------------------- socket */

const playerId = loadPlayerId();

const serverUrl = import.meta.env.VITE_SERVER_URL;
/** One socket per page load, shared by everything. */
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = serverUrl
  ? io(serverUrl)
  : io();

/** Every action is an emit with an ack, and no ack may hang the UI forever. */
function withAck<R>(send: (ack: (res: R) => void) => void): Promise<R | Failure> {
  /*
   * socket.io queues an emit made while disconnected and replays it the moment the socket is
   * back -- before the 'connect' handler below has reclaimed the seat, so the server answers
   * a seatless socket with "You are not in a room any more" and the action is simply lost.
   * Never queue: say so now instead of spinning for eight seconds and then lying.
   */
  if (!socket.connected) return Promise.resolve<R | Failure>({ ok: false, error: OFFLINE });
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: NO_ANSWER });
    }, ACK_TIMEOUT_MS);
    send((res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/* ------------------------------------------------------------------ context */

const GameContext = createContext<Game | null>(null);

export function useGame(): Game {
  const game = useContext(GameContext);
  if (!game) throw new Error('useGame() used outside <GameProvider>');
  return game;
}

export function GameProvider({ children }: { children: ReactNode }): ReactElement {
  const [connected, setConnected] = useState(socket.connected);
  const [state, setState] = useState<RoomState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  /** serverNow - Date.now() at the last update: the device clock is never trusted. */
  const clockOffset = useRef(0);

  useEffect(() => {
    const onState = (s: RoomState) => {
      clockOffset.current = s.serverNow - Date.now();
      setState(s);
      setNotice(null);
      writeStored(KEY_CODE, s.code);
    };

    const onRoomClosed = ({ reason }: { reason: string }) => {
      clearStored(KEY_CODE);
      setState(null);
      setSecondsLeft(null);
      setNotice(reason);
    };

    /**
     * Phones suspend tabs constantly, so a reconnect has to silently reclaim the seat
     * we already had. If the room is gone, drop back to Home and say why.
     */
    const reclaimSeat = async () => {
      const code = readStored(KEY_CODE);
      const name = readStored(KEY_NAME);
      if (!code || !name) return;
      const res = await withAck<JoinAck>((ack) =>
        socket.emit('joinRoom', { code, name, playerId }, ack)
      );
      if (!res.ok) {
        clearStored(KEY_CODE);
        setState(null);
        setSecondsLeft(null);
        setNotice(res.error);
      }
    };

    const onConnect = () => {
      setConnected(true);
      void reclaimSeat();
    };
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state', onState);
    socket.on('roomClosed', onRoomClosed);

    // The singleton may have connected before this mounted, so no 'connect' is coming.
    if (socket.connected) void reclaimSeat();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state', onState);
      socket.off('roomClosed', onRoomClosed);
    };
  }, []);

  const endsAt = state?.endsAt ?? null;

  useEffect(() => {
    if (endsAt === null) {
      setSecondsLeft(null);
      return;
    }
    const tick = () =>
      setSecondsLeft(
        Math.max(0, Math.round((endsAt - (Date.now() + clockOffset.current)) / 1000))
      );
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [endsAt]);

  const createRoom = async (rawName: string): Promise<CodeResult> => {
    const name = cleanName(rawName);
    if (!name) return { ok: false, error: 'Pick a name first.' };
    writeStored(KEY_NAME, name);
    const res = await withAck<JoinAck>((ack) =>
      socket.emit('createRoom', { playerId, name }, ack)
    );
    if (res.ok) writeStored(KEY_CODE, res.code);
    return res;
  };

  const joinRoom = async (rawCode: string, rawName: string): Promise<CodeResult> => {
    const name = cleanName(rawName);
    const code = cleanCode(rawCode);
    if (!name) return { ok: false, error: 'Pick a name first.' };
    if (code.length !== ROOM_CODE_LENGTH) {
      return { ok: false, error: `A room code is ${ROOM_CODE_LENGTH} characters.` };
    }
    writeStored(KEY_NAME, name);
    const res = await withAck<JoinAck>((ack) =>
      socket.emit('joinRoom', { code, name, playerId }, ack)
    );
    if (res.ok) writeStored(KEY_CODE, code);
    return res;
  };

  const leaveRoom = () => {
    socket.emit('leaveRoom');
    clearStored(KEY_CODE);
    setState(null);
    setSecondsLeft(null);
    setNotice(null);
  };

  const game: Game = {
    connected,
    playerId,
    state,
    me: state?.players.find((p) => p.id === playerId) ?? null,
    isHost: state !== null && state.hostId === playerId,
    secondsLeft,
    phaseTotalSeconds:
      state === null
        ? 0
        : state.phase === 'create'
          ? state.settings.createSeconds
          : state.phase === 'vote'
            ? state.settings.voteSeconds
            : 0,
    notice,
    dismissNotice: () => setNotice(null),

    createRoom,
    joinRoom,
    leaveRoom,
    startRound: () => withAck<ActionResult>((ack) => socket.emit('startRound', ack)),
    skipPhase: () => withAck<ActionResult>((ack) => socket.emit('skipPhase', ack)),
    backToLobby: () => withAck<ActionResult>((ack) => socket.emit('backToLobby', ack)),
    updateSettings: (s) => withAck<ActionResult>((ack) => socket.emit('updateSettings', s, ack)),
    submitMeme: (p) => withAck<ActionResult>((ack) => socket.emit('submitMeme', p, ack)),
    castVote: (submissionId) =>
      withAck<ActionResult>((ack) => socket.emit('castVote', { submissionId }, ack)),
  };

  return <GameContext.Provider value={game}>{children}</GameContext.Provider>;
}
