import { useState } from 'react';
import { useGame } from '../game';
import { MemeCard } from '../components/MemeCard';

function votes(n: number): string {
  return `${n} ${n === 1 ? 'vote' : 'votes'}`;
}

export function Results() {
  const { state, playerId, isHost, startRound, backToLobby } = useGame();
  const [busy, setBusy] = useState<'next' | 'lobby' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!state) return null;
  const room = state;

  const host = room.players.find((p) => p.id === room.hostId);
  const ranked = [...room.submissions].sort((a, b) => b.votes - a.votes);
  const topVotes = ranked.reduce((max, s) => Math.max(max, s.votes), 0);
  const winners = topVotes > 0 ? ranked.filter((s) => s.votes === topVotes) : [];
  const rest = ranked.filter((s) => !winners.includes(s));
  const totalVotes = ranked.reduce((sum, s) => sum + s.votes, 0);
  const scores = [...room.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const headline =
    ranked.length === 0
      ? 'A beautifully empty round.'
      : totalVotes === 0
        ? 'Zero votes cast. Tough crowd.'
        : `${votes(totalVotes)} counted.`;

  async function run(which: 'next' | 'lobby') {
    setError(null);
    setBusy(which);
    const res = which === 'next' ? await startRound() : await backToLobby();
    setBusy(null);
    if (!res.ok) setError(res.error);
  }

  return (
    <div className="screen">
      <div className="screen-head stack">
        <h2 className="title">Round {room.round}</h2>
        <p className="subtitle">{headline}</p>
      </div>

      <div className="screen-body stack">
        {ranked.length === 0 ? (
          <p className="empty">Nobody made a meme. A bold, unified statement — but no winner.</p>
        ) : winners.length === 0 ? (
          <p className="empty">Not a single vote. We'll call it a draw and never speak of it again.</p>
        ) : (
          <div className="winner">
            <span className="label">{winners.length > 1 ? `${winners.length}-way tie!` : 'Winner'}</span>
            {winners.map((w) => (
              <div className="stack" key={w.id}>
                <MemeCard imageUrl={w.imageUrl} topText={w.topText} bottomText={w.bottomText}>
                  {/* .meme-overlay only positions; the badge is what makes it readable
                      over a light photo. */}
                  <span className="meme-overlay">
                    <span className="badge">{votes(w.votes)}</span>
                  </span>
                </MemeCard>
                <div className="row spread">
                  <span className="player-name">{w.playerName}</span>
                  <span className="rank-votes">{votes(w.votes)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {rest.length > 0 && (
          <div className="stack">
            <span className="label">{winners.length > 0 ? 'Also ran' : 'Tonight’s memes'}</span>
            {rest.map((s) => (
              <div className="rank-row" key={s.id}>
                <span className="player-name grow">{s.playerName}</span>
                <span className="rank-votes">{votes(s.votes)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="stack">
          <span className="label">Scores</span>
          <ul className="score-list">
            {scores.map((p) => (
              <li key={p.id} className={p.connected ? 'player' : 'player muted'}>
                <span className={p.connected ? 'player-dot' : 'player-dot off'} aria-hidden="true" />
                <span className="player-name grow">{p.name}</span>
                {p.id === room.hostId && (
                  <span className="crown" title="Host">
                    👑
                  </span>
                )}
                {p.id === playerId && <span className="badge">you</span>}
                <span className="player-score">{p.score}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="screen-foot stack">
        {isHost ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={busy !== null}
              onClick={() => run('next')}
            >
              {busy === 'next' ? (
                <>
                  <span className="spinner" />
                  Dealing…
                </>
              ) : (
                'Next round'
              )}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              disabled={busy !== null}
              onClick={() => run('lobby')}
            >
              {busy === 'lobby' ? (
                <>
                  <span className="spinner" />
                  Heading back…
                </>
              ) : (
                'Back to lobby'
              )}
            </button>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          <p className="progress-note">Waiting for {host ? host.name : 'the host'} to deal the next round…</p>
        )}
      </div>
    </div>
  );
}
