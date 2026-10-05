import { useState } from 'react';
import { useGame } from '../game';
import { MemeCard } from '../components/MemeCard';
import { Timer } from '../components/Timer';

export function Vote() {
  const { state, playerId, isHost, secondsLeft, phaseTotalSeconds, castVote, skipPhase } = useGame();
  const [picked, setPicked] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);

  if (!state) return null;
  const room = state;

  const voted = room.votedIds.includes(playerId);
  // votedIds covers away seats too, so both halves of the count have to be the same set of
  // people -- otherwise it reads "2 of 2 voted" to someone who has not voted yet.
  const hereIds = new Set(room.players.filter((p) => p.connected).map((p) => p.id));
  const votesIn = room.votedIds.filter((id) => hereIds.has(id)).length;

  // Authors stay anonymous until results, so the only label is a position. It has to be the
  // absolute position in the server's one shared order, or "meme 2" means a different meme on
  // every phone and the table votes for the wrong things.
  const tiles = room.submissions.map((s, i) => {
    const mine = s.id === playerId;
    return { sub: s, mine, label: mine ? `Meme ${i + 1} · yours` : `Meme ${i + 1}` };
  });
  const votable = tiles.filter((t) => !t.mine).length;

  async function onConfirm() {
    if (!picked || sending) return;
    setVoteError(null);
    setSending(true);
    const res = await castVote(picked);
    setSending(false);
    if (!res.ok) setVoteError(res.error);
  }

  async function onSkip() {
    setSkipError(null);
    setSkipping(true);
    const res = await skipPhase();
    setSkipping(false);
    if (!res.ok) setSkipError(res.error);
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <Timer secondsLeft={secondsLeft} totalSeconds={phaseTotalSeconds} label="Pick the funniest" />
      </div>

      <div className="screen-body stack">
        {tiles.length === 0 ? (
          <p className="empty">Not one meme made it in. Everyone just watched the clock, apparently.</p>
        ) : (
          <div className="meme-grid">
            {tiles.map(({ sub, mine, label }) => {
              const chosen = picked === sub.id;
              const dimmed = mine || (voted && !chosen);
              return (
                <button
                  key={sub.id}
                  type="button"
                  aria-pressed={chosen}
                  disabled={mine || voted || sending}
                  className={'meme-tile' + (chosen ? ' selected' : '') + (dimmed ? ' disabled' : '')}
                  onClick={() => {
                    setVoteError(null);
                    setPicked(sub.id);
                  }}
                >
                  <MemeCard imageUrl={sub.imageUrl} topText={sub.topText} bottomText={sub.bottomText} />
                  <span className="vote-label">{label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="screen-foot stack">
        {voted ? (
          <p className="hint">{picked ? 'Vote locked in. No take-backs. 🔒' : 'Your vote is already in.'}</p>
        ) : votable === 0 ? (
          <p className="hint">Nothing here but your own meme. Sit this one out and look humble.</p>
        ) : (
          <button type="button" className="btn btn-primary btn-block" disabled={!picked || sending} onClick={onConfirm}>
            {sending ? (
              <>
                <span className="spinner" />
                Voting…
              </>
            ) : picked ? (
              'Lock in this one'
            ) : (
              'Tap a meme to vote'
            )}
          </button>
        )}
        {voteError && (
          <p className="error" role="alert">
            {voteError}
          </p>
        )}

        <p className="progress-note">
          {votesIn} of {hereIds.size} voted
        </p>

        {isHost && (
          <>
            <button type="button" className="btn btn-ghost btn-block" onClick={onSkip} disabled={skipping}>
              {skipping ? (
                <>
                  <span className="spinner" />
                  Skipping…
                </>
              ) : (
                'Skip to results'
              )}
            </button>
            {skipError && (
              <p className="error" role="alert">
                {skipError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
