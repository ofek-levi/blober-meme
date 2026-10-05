import { useRef, useState, type FormEvent } from 'react';
import { useGame } from '../game';
import { MemeCard } from '../components/MemeCard';
import { Timer } from '../components/Timer';
import { MAX_TEXT_LENGTH, cleanText } from '../types';

export function Editor() {
  const { state, playerId, isHost, secondsLeft, phaseTotalSeconds, submitMeme, skipPhase } = useGame();
  const [topText, setTopText] = useState('');
  const [bottomText, setBottomText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  const bottomInput = useRef<HTMLInputElement>(null);

  if (!state) return null;
  const room = state;

  /** The photo the host dealt us. Null for anyone who arrived after the deal. */
  const mine = room.assignments.find((a) => a.playerId === playerId) ?? null;
  const submitted = room.submittedIds.includes(playerId);
  // submittedIds covers away seats too, so both halves of the count have to be the same set
  // of people -- otherwise it reads "3 of 3 sent" while the phase is still waiting on someone.
  // Only a player holding a photo can send one, so a late joiner is not in the count either.
  const dealtIds = new Set(room.assignments.map((a) => a.playerId));
  const hereIds = new Set(
    room.players.filter((p) => p.connected && dealtIds.has(p.id)).map((p) => p.id),
  );
  const sent = room.submittedIds.filter((id) => hereIds.has(id)).length;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!mine || sending) return;
    setSendError(null);
    setSending(true);
    const res = await submitMeme({ topText, bottomText });
    setSending(false);
    if (!res.ok) setSendError(res.error);
  }

  async function onSkip() {
    setSkipError(null);
    setSkipping(true);
    const res = await skipPhase();
    setSkipping(false);
    if (!res.ok) setSkipError(res.error);
  }

  return (
    <form className="screen" onSubmit={onSubmit}>
      <div className="screen-head">
        <Timer
          secondsLeft={secondsLeft}
          totalSeconds={phaseTotalSeconds}
          label={mine ? 'Build your meme' : 'Sitting this one out'}
        />
      </div>

      <div className="screen-body stack">
        {mine === null ? (
          <div className="empty">
            <p className="subtitle">You walked in after the deal.</p>
            <p className="hint">
              The photos were dealt before you got here. Next round you get one too — stick around
              and judge these ones first.
            </p>
          </div>
        ) : (
          <>
            <MemeCard imageUrl={mine.imageUrl} topText={topText} bottomText={bottomText} />
            <p className="hint">You didn't pick it. That's the whole game.</p>

            <label className="label" htmlFor="top-text">
              Top line
            </label>
            <input
              id="top-text"
              className="input"
              value={topText}
              onChange={(e) => setTopText(cleanText(e.target.value))}
              maxLength={MAX_TEXT_LENGTH}
              placeholder="WHEN YOU…"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              // The key says "next", so do that -- otherwise the form's implicit submit fires and
              // sends a half-written meme the moment you reach for the bottom line.
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                bottomInput.current?.focus();
              }}
            />

            <label className="label" htmlFor="bottom-text">
              Bottom line
            </label>
            <input
              id="bottom-text"
              ref={bottomInput}
              className="input"
              value={bottomText}
              onChange={(e) => setBottomText(cleanText(e.target.value))}
              maxLength={MAX_TEXT_LENGTH}
              placeholder="…AND IT ACTUALLY WORKS"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
            />
          </>
        )}
      </div>

      <div className="screen-foot stack">
        {submitted && (
          <div className="row">
            <span className="badge">Submitted ✓</span>
            <span className="hint">Keep fiddling with it until the timer runs out.</span>
          </div>
        )}

        <p className="progress-note">
          {sent} of {hereIds.size} sent
        </p>

        {mine !== null && (
          <>
            <button className="btn btn-primary btn-block" type="submit" disabled={sending}>
              {sending ? (
                <>
                  <span className="spinner" />
                  Sending…
                </>
              ) : submitted ? (
                'Update'
              ) : (
                'Send it'
              )}
            </button>
            {sendError && (
              <p className="error" role="alert">
                {sendError}
              </p>
            )}
          </>
        )}

        {isHost && (
          <>
            <button type="button" className="btn btn-ghost btn-block" onClick={onSkip} disabled={skipping}>
              {skipping ? (
                <>
                  <span className="spinner" />
                  Skipping…
                </>
              ) : (
                'Skip to voting'
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
    </form>
  );
}
