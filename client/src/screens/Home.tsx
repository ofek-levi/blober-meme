import { useRef, useState, type FormEvent } from 'react';
import { useGame } from '../game';
import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH, cleanCode, cleanName } from '../types';

/** game.tsx stores the last name used in sessionStorage, so a refresh pre-fills it. */
function rememberedName(): string {
  try {
    return sessionStorage.getItem('blober:name') ?? '';
  } catch {
    // Safari private mode throws on storage access rather than returning null.
    return '';
  }
}

export function Home() {
  const { connected, notice, dismissNotice, createRoom, joinRoom } = useGame();
  const [name, setName] = useState(rememberedName);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const niceName = cleanName(name);
  const locked = busy !== null || !connected;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setJoinError(null);
    if (!niceName) {
      setCreateError('Pop your name in first.');
      nameInput.current?.focus();
      return;
    }
    setBusy('create');
    const res = await createRoom(niceName);
    setBusy(null);
    if (!res.ok) setCreateError(res.error);
  }

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setJoinError(null);
    if (!niceName) {
      setJoinError('Pop your name in first.');
      nameInput.current?.focus();
      return;
    }
    if (code.length < ROOM_CODE_LENGTH) {
      setJoinError(`A room code is ${ROOM_CODE_LENGTH} characters.`);
      return;
    }
    setBusy('join');
    const res = await joinRoom(code, niceName);
    setBusy(null);
    if (!res.ok) setJoinError(res.error);
  }

  return (
    <div className="screen">
      <div className="screen-head stack">
        <h1 className="title">blober meme</h1>
        <p className="subtitle">Bad photos. Worse captions. One winner.</p>
      </div>

      <div className="screen-body center">
        <div className="stack">
          {notice && (
            <div className="notice">
              <span className="grow">{notice}</span>
              <button type="button" className="link-btn" onClick={dismissNotice}>
                Dismiss
              </button>
            </div>
          )}

          <form className="stack" onSubmit={onCreate}>
            <label className="label" htmlFor="player-name">
              Your name
            </label>
            <input
              id="player-name"
              ref={nameInput}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
              placeholder="Blober"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="words"
              spellCheck={false}
              enterKeyHint="go"
            />
            {!niceName && <p className="hint">Everyone needs to know who to blame.</p>}
            <button className="btn btn-primary btn-block" type="submit" disabled={locked}>
              {busy === 'create' ? (
                <>
                  <span className="spinner" />
                  Opening a room…
                </>
              ) : (
                'Start a new game'
              )}
            </button>
            {createError && (
              <p className="error" role="alert">
                {createError}
              </p>
            )}
          </form>

          <p className="hint">…or hop into a friend's game</p>

          <form className="stack" onSubmit={onJoin}>
            <label className="label" htmlFor="room-code">
              Room code
            </label>
            <input
              id="room-code"
              className="input input-code"
              value={code}
              onChange={(e) => setCode(cleanCode(e.target.value))}
              maxLength={ROOM_CODE_LENGTH}
              placeholder="ABCD"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="go"
            />
            <button className="btn btn-block" type="submit" disabled={locked}>
              {busy === 'join' ? (
                <>
                  <span className="spinner" />
                  Knocking…
                </>
              ) : (
                'Join game'
              )}
            </button>
            {joinError && (
              <p className="error" role="alert">
                {joinError}
              </p>
            )}
          </form>
        </div>
      </div>

      <div className="screen-foot">
        {connected ? (
          <p className="hint">Best played with 4–8 friends and one very loud group chat.</p>
        ) : (
          <p className="hint danger-text">Offline — trying to reach the server…</p>
        )}
      </div>
    </div>
  );
}
