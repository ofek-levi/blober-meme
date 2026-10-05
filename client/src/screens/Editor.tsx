import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useGame } from '../game';
import { MemeCard } from '../components/MemeCard';
import { Timer } from '../components/Timer';
import { prepareImage, releasePreview, type PreparedImage } from '../lib/image';
import { MAX_TEXT_LENGTH, cleanText } from '../types';

/** One id, two labels: the big drop target and the small "Change photo" button. */
const PHOTO_INPUT_ID = 'meme-photo';

export function Editor() {
  const { state, playerId, isHost, secondsLeft, phaseTotalSeconds, submitMeme, skipPhase } = useGame();
  const [photo, setPhoto] = useState<PreparedImage | null>(null);
  /** The preview URL the server already has bytes for, so an edit can re-send text only. */
  const [sentUrl, setSentUrl] = useState<string | null>(null);
  const [topText, setTopText] = useState('');
  const [bottomText, setBottomText] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  const liveUrl = useRef<string | null>(null);
  const bottomInput = useRef<HTMLInputElement>(null);

  // Preview object URLs are ours to free, or a few rounds of photos leak the whole time.
  useEffect(
    () => () => {
      releasePreview(liveUrl.current);
    },
    [],
  );

  if (!state) return null;
  const room = state;

  const submitted = room.submittedIds.includes(playerId);
  // submittedIds covers away seats too, so both halves of the count have to be the same set
  // of people -- otherwise it reads "3 of 3 sent" while the phase is still waiting on someone.
  const hereIds = new Set(room.players.filter((p) => p.connected).map((p) => p.id));
  const sent = room.submittedIds.filter((id) => hereIds.has(id)).length;

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ''; // so picking the same file twice still fires change
    if (!file || preparing) return;
    setPhotoError(null);
    setPreparing(true);
    try {
      const next = await prepareImage(file);
      releasePreview(liveUrl.current);
      liveUrl.current = next.previewUrl;
      setPhoto(next);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "That photo didn't work out.");
    } finally {
      setPreparing(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!photo || preparing || sending) return;
    setSendError(null);
    setSending(true);
    const res = await submitMeme({
      image: photo.previewUrl === sentUrl ? null : photo.bytes,
      mimeType: photo.mimeType,
      topText,
      bottomText,
    });
    setSending(false);
    if (res.ok) setSentUrl(photo.previewUrl);
    else setSendError(res.error);
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
        <Timer secondsLeft={secondsLeft} totalSeconds={phaseTotalSeconds} label="Build your meme" />
      </div>

      <div className="screen-body stack">
        {photo ? (
          <>
            <MemeCard imageUrl={photo.previewUrl} topText={topText} bottomText={bottomText} />
            <div className="row spread">
              {preparing ? (
                <span className="hint">
                  <span className="spinner" />
                  Squeezing photo…
                </span>
              ) : (
                <label className="btn btn-ghost btn-sm" htmlFor={PHOTO_INPUT_ID}>
                  Change photo
                </label>
              )}
            </div>
          </>
        ) : (
          <label className="file-drop" htmlFor={PHOTO_INPUT_ID}>
            {preparing ? (
              <>
                <span className="spinner" />
                <span className="title">Squeezing photo…</span>
                <span className="hint">Shrinking it so it uploads before the timer does.</span>
              </>
            ) : (
              <>
                <span className="title">📷 Pick a photo</span>
                <span className="hint">Camera roll, screenshot, cursed selfie — anything goes.</span>
              </>
            )}
          </label>
        )}

        <input
          id={PHOTO_INPUT_ID}
          type="file"
          accept="image/*"
          onChange={onPick}
          hidden
        />

        {photoError && (
          <p className="error" role="alert">
            {photoError}
          </p>
        )}

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

        <button className="btn btn-primary btn-block" type="submit" disabled={!photo || preparing || sending}>
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
        {!photo && <p className="hint">Pick a photo and the button wakes up.</p>}
        {sendError && (
          <p className="error" role="alert">
            {sendError}
          </p>
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
