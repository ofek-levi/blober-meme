import { useEffect, useRef, useState } from 'react';
import { useGame } from '../game';
import {
  CREATE_SECONDS_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  VOTE_SECONDS_OPTIONS,
  type RoomSettings,
} from '../types';

function secondsLabel(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}:${String(rest).padStart(2, '0')}`;
}

export function Lobby() {
  const { state, playerId, isHost, connected, startRound, updateSettings, leaveRoom } = useGame();
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const noteTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    },
    [],
  );

  if (!state) return null;
  const room = state;

  const players = room.players;
  const host = players.find((p) => p.id === room.hostId);
  // Counted the way the server counts it, or the button offers a start it will then refuse.
  const canStart = players.filter((p) => p.connected).length >= MIN_PLAYERS_TO_START;

  function flashNote(message: string) {
    setCopyNote(message);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setCopyNote(null), 1800);
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room.code);
      flashNote('Copied!');
    } catch {
      // The clipboard API rejects on plain-http origins; no drama, just say so.
      flashNote('Copy blocked — read it out loud');
    }
  }

  async function saveSettings(patch: Partial<RoomSettings>) {
    setSettingsError(null);
    setSaving(true);
    const res = await updateSettings(patch);
    setSaving(false);
    if (!res.ok) setSettingsError(res.error);
  }

  async function onStart() {
    setStartError(null);
    setStarting(true);
    const res = await startRound();
    setStarting(false);
    if (!res.ok) setStartError(res.error);
  }

  return (
    <div className="screen">
      <div className="screen-head stack">
        <span className="label">Room code</span>
        <button
          type="button"
          className="code-badge"
          onClick={copyCode}
          aria-label={`Room code ${room.code.split('').join(' ')} — tap to copy`}
        >
          <span className="code-chars mono">{room.code}</span>
        </button>
        {copyNote ? <span className="badge">{copyNote}</span> : <span className="hint">Tap the code to copy it</span>}
      </div>

      <div className="screen-body stack">
        <div className="row spread">
          <span className="label">Who's in</span>
          <span className="pill">
            {players.length} / {MAX_PLAYERS} players
          </span>
        </div>

        <ul className="player-list">
          {players.map((p) => (
            <li key={p.id} className={p.connected ? 'player' : 'player muted'}>
              <span className={p.connected ? 'player-dot' : 'player-dot off'} aria-hidden="true" />
              <span className="player-name grow">{p.name}</span>
              {p.id === room.hostId && (
                <span className="crown" title="Host">
                  👑
                </span>
              )}
              {p.id === playerId && <span className="badge">you</span>}
              {!p.connected && <span className="pill">away</span>}
              <span className="player-score">{p.score}</span>
            </li>
          ))}
        </ul>

        {isHost ? (
          <div className="stack">
            <span className="label">Time to build a meme</span>
            <div className="seg">
              {CREATE_SECONDS_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={room.settings.createSeconds === s ? 'seg-btn on' : 'seg-btn'}
                  disabled={saving || !connected}
                  onClick={() => saveSettings({ createSeconds: s })}
                >
                  {secondsLabel(s)}
                </button>
              ))}
            </div>

            <span className="label">Time to vote</span>
            <div className="seg">
              {VOTE_SECONDS_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={room.settings.voteSeconds === s ? 'seg-btn on' : 'seg-btn'}
                  disabled={saving || !connected}
                  onClick={() => saveSettings({ voteSeconds: s })}
                >
                  {secondsLabel(s)}
                </button>
              ))}
            </div>

            {settingsError && (
              <p className="error" role="alert">
                {settingsError}
              </p>
            )}
          </div>
        ) : (
          <p className="progress-note">
            {secondsLabel(room.settings.createSeconds)} to build · {secondsLabel(room.settings.voteSeconds)} to vote
          </p>
        )}
      </div>

      <div className="screen-foot stack">
        {isHost ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={!canStart || starting || !connected}
              onClick={onStart}
            >
              {starting ? (
                <>
                  <span className="spinner" />
                  Starting…
                </>
              ) : (
                'Start the round'
              )}
            </button>
            {!canStart && (
              <p className="hint">
                Needs {MIN_PLAYERS_TO_START} players to start — send that code to someone.
              </p>
            )}
            {startError && (
              <p className="error" role="alert">
                {startError}
              </p>
            )}
          </>
        ) : (
          <p className="progress-note">Waiting for {host ? host.name : 'the host'} to start…</p>
        )}
        <button type="button" className="link-btn" onClick={leaveRoom}>
          Leave game
        </button>
      </div>
    </div>
  );
}
