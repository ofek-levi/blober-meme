import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useGame } from '../game';
import { prepareImage, releasePreview } from '../lib/image';
import { MIN_PLAYERS_TO_START } from '../types';

/** One hidden input, pointed at by the big drop target and by every empty slot. */
const PHOTO_INPUT_ID = 'pool-photo';

export function Upload() {
  const { state, isHost, connected, addImage, removeImage, dealImages, backToLobby, leaveRoom } =
    useGame();
  /**
   * Object URLs of the photos we squeezed ourselves, keyed by the id the pool filed each one
   * under, so a thumbnail shows up instantly instead of being fetched back off the server.
   */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [dealing, setDealing] = useState(false);
  const [dealError, setDealError] = useState<string | null>(null);
  const [backing, setBacking] = useState(false);
  const [backError, setBackError] = useState<string | null>(null);
  const livePreviews = useRef<Record<string, string>>({});

  useEffect(() => {
    livePreviews.current = previews;
  }, [previews]);

  // A whole round's worth of previews is ours to free, and the host does this every round.
  useEffect(
    () => () => {
      for (const url of Object.values(livePreviews.current)) releasePreview(url);
    },
    [],
  );

  const poolIds = (state?.pool ?? []).map((img) => img.id).join(' ');
  const poolNeeded = state?.poolNeeded ?? 0;

  // A photo that has left the pool -- removed, or the round moved on -- takes its blob with it.
  useEffect(() => {
    const live = new Set(poolIds === '' ? [] : poolIds.split(' '));
    setPreviews((prev) => {
      const next: Record<string, string> = {};
      let dropped = false;
      for (const [id, url] of Object.entries(prev)) {
        if (live.has(id)) next[id] = url;
        else {
          releasePreview(url);
          dropped = true;
        }
      }
      return dropped ? next : prev;
    });
  }, [poolIds]);

  // A refused deal is always about the pile and the table disagreeing, so the moment either
  // side moves the message is describing a room that no longer exists.
  useEffect(() => {
    setDealError(null);
  }, [poolIds, poolNeeded]);

  if (!state) return null;
  const room = state;

  const host = room.players.find((p) => p.id === room.hostId);
  const have = room.pool.length;
  // Read live every render: a player joining or leaving moves the target under the host.
  const needed = poolNeeded;
  /** Negative once someone has left and the pile is bigger than the table. */
  const missing = needed - have;
  const emptySlots = Math.max(0, missing);
  const count = `${have} of ${needed} photo${needed === 1 ? '' : 's'}`;
  /** The server re-checks this at the deal, so don't offer a button it is going to refuse. */
  const tooFew = needed < MIN_PLAYERS_TO_START;

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // so picking the same file twice still fires change
    if (files.length === 0 || uploading) return;
    // The camera roll can sit open while someone leaves the room, so the slots we were counting
    // on may be gone by the time the photos come back. Say so rather than swallow the pick.
    const slots = Math.max(0, missing);
    if (slots === 0) {
      setPhotoError('The pile is full now — drop one before adding another.');
      return;
    }
    setPhotoError(null);
    setUploading(true);
    try {
      // Free slots are counted once per batch: the server is the real gatekeeper, this only
      // saves us squeezing photos it is about to refuse.
      for (const file of files.slice(0, slots)) {
        // One bad pick -- a GIF out of the gallery, a refused ack, a timeout on a weak uplink --
        // must not throw away the rest of a batch the host chose on purpose.
        try {
          const photo = await prepareImage(file);
          const res = await addImage({ image: photo.bytes, mimeType: photo.mimeType });
          if (!res.ok) {
            releasePreview(photo.previewUrl);
            setPhotoError(res.error);
            continue;
          }
          const id = res.id;
          // Without an id there is nothing to key the preview to, so let the server's own copy
          // fill the thumbnail instead of holding a blob we can never match up again.
          if (id) {
            releasePreview(livePreviews.current[id]); // a reused id must not orphan a blob
            setPreviews((prev) => ({ ...prev, [id]: photo.previewUrl }));
          } else {
            releasePreview(photo.previewUrl);
          }
        } catch (err) {
          setPhotoError(err instanceof Error ? err.message : "That photo didn't work out.");
        }
      }
    } finally {
      setUploading(false);
    }
  }

  // The preview URL is freed by the effect watching the pool, so a refused remove keeps its
  // thumbnail exactly as it was.
  async function onRemove(id: string) {
    if (uploading || removingId !== null || dealing) return;
    setPhotoError(null);
    setRemovingId(id);
    const res = await removeImage(id);
    setRemovingId(null);
    if (!res.ok) setPhotoError(res.error);
  }

  async function onDeal() {
    if (dealing) return;
    setDealError(null);
    setDealing(true);
    const res = await dealImages();
    setDealing(false);
    if (!res.ok) setDealError(res.error);
  }

  // The one way out of a phase with no clock: a mistaken tap on "Pick the photos", or a timer
  // the host wants to change after all, should not strand the whole room here.
  async function onBack() {
    if (backing) return;
    setBackError(null);
    setBacking(true);
    const res = await backToLobby();
    setBacking(false);
    if (!res.ok) setBackError(res.error);
  }

  if (!isHost) {
    return (
      <div className="screen">
        <div className="screen-head stack">
          <span className="label">Round {room.round}</span>
          <h1 className="title">Incoming photos</h1>
        </div>

        <div className="screen-body stack">
          <div className="empty">
            <span className="spinner" />
            <p className="subtitle">
              {host ? host.name : 'The host'} is picking the photos… {have} of {needed}
            </p>
            <p className="hint">
              One each, dealt at random. You find out which one you got when the clock starts.
            </p>
          </div>
        </div>

        <div className="screen-foot stack">
          <p className="progress-note">
            No clock on this bit — go get a drink, your photo will be waiting.
          </p>
          <button type="button" className="link-btn" onClick={leaveRoom}>
            Leave game
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="screen-head stack">
        <span className="label">Round {room.round}</span>
        <h1 className="title">Pick the photos</h1>
        <p className="subtitle">One per player, dealt at random. Nobody gets to choose.</p>
      </div>

      <div className="screen-body stack">
        {emptySlots > 0 && (
          <label className="file-drop" htmlFor={PHOTO_INPUT_ID}>
            {uploading ? (
              <>
                <span className="spinner" />
                <span className="title">Squeezing photo…</span>
                <span className="hint">Shrinking it so it lands before anyone loses interest.</span>
              </>
            ) : (
              <>
                <span className="title">📷 Add photos</span>
                <span className="hint">
                  Camera roll, screenshots, cursed selfies — anything goes. Grab a few at once if
                  you like.
                </span>
              </>
            )}
          </label>
        )}

        {/* Disabled while a batch is in flight: a label cannot activate a disabled control, so
            the big target goes inert instead of opening a picker whose photo we would drop. */}
        <input
          id={PHOTO_INPUT_ID}
          type="file"
          accept="image/*"
          multiple
          disabled={uploading}
          onChange={onPick}
          hidden
        />

        <div className="row spread">
          <span className="label">The pile</span>
          <span className="pill">{count}</span>
        </div>

        <div className="x-photo-grid">
          {room.pool.map((img, i) => (
            <div className="x-photo" key={img.id}>
              <img className="x-photo-img" src={previews[img.id] ?? img.imageUrl} alt="" />
              <button
                type="button"
                className="x-photo-remove"
                aria-label={`Remove photo ${i + 1}`}
                disabled={uploading || removingId !== null || dealing}
                onClick={() => onRemove(img.id)}
              >
                ✕
              </button>
            </div>
          ))}
          {/* Every slot this round needs is on screen from the start, so the grid does not
              shuffle itself about as photos land one by one. Each one is another label for the
              same input: a dashed "+" box that did nothing would be a trap, and once the host
              has scrolled down to the pile it is the only "add" affordance in view. */}
          {Array.from({ length: emptySlots }, (_, i) => (
            <label
              className="x-photo-slot"
              htmlFor={PHOTO_INPUT_ID}
              key={`slot-${i}`}
              aria-label="Add a photo"
            >
              +
            </label>
          ))}
        </div>

        {have > 0 && <p className="hint">Tap ✕ on one you regret.</p>}
      </div>

      <div className="screen-foot stack">
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={missing !== 0 || tooFew || uploading || dealing || !connected}
          onClick={onDeal}
        >
          {dealing ? (
            <>
              <span className="spinner" />
              Dealing…
            </>
          ) : (
            'Deal them out'
          )}
        </button>
        {tooFew ? (
          <p className="hint">
            Everyone else left — wait for someone to come back, or head back to the lobby.
          </p>
        ) : (
          <>
            {missing > 0 && (
              <p className="hint">
                {missing === 1 ? 'One more photo' : `${missing} more photos`} and the button wakes
                up.
              </p>
            )}
            {missing < 0 && (
              <p className="hint">
                Fewer players than photos now — drop {-missing === 1 ? 'one' : -missing} and the
                button wakes up.
              </p>
            )}
          </>
        )}
        {/* Every error lands in the footer, photo ones included: the body is the only scroller,
            and once the host has scrolled down to the pile anything above it is off screen. */}
        {photoError && (
          <p className="error" role="alert">
            {photoError}
          </p>
        )}
        {dealError && (
          <p className="error" role="alert">
            {dealError}
          </p>
        )}
        {backError && (
          <p className="error" role="alert">
            {backError}
          </p>
        )}
        <button type="button" className="link-btn" onClick={onBack} disabled={backing}>
          {backing ? 'Going back…' : 'Back to lobby'}
        </button>
      </div>
    </div>
  );
}
