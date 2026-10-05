import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useGame } from '../game';
import { prepareImage, releasePreview } from '../lib/image';
import { MAX_POOL_IMAGES, MIN_PLAYERS_TO_START } from '../types';

/** One hidden input, pointed at by the big drop target and by the slot at the end of the pile. */
const PHOTO_INPUT_ID = 'pool-photo';

/**
 * What this particular pile will do once it is dealt, in one sentence. Every photo is dealt
 * before any photo repeats, so the outcome follows from these two numbers alone -- and the host
 * should never have to work it out from them.
 */
function dealNote(have: number, players: number): string {
  if (have === 0) return 'Nothing in it yet — one photo is enough to play.';
  if (have === 1) return '1 photo — everyone captions the same one.';
  const pile = `${have} photos for ${players} player${players === 1 ? '' : 's'}`;
  if (have < players) return `${pile} — some photos get shared.`;
  if (have === players) return `${pile} — everyone gets their own.`;
  // Only ever a claim about this round: the pile is emptied at the next "Next round", so the
  // spares are not banked for later and must not sound like they are.
  const spare = have - players;
  return `${pile} — everyone gets their own, and ${spare} ${spare === 1 ? 'goes' : 'go'} unused.`;
}

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
  /** Read live every render: someone joining or leaving changes what the pile will do. */
  const playerCount = state?.players.length ?? 0;

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

  // A refused deal is always about the pile or the table, so the moment either side moves the
  // message is describing a room that no longer exists.
  useEffect(() => {
    setDealError(null);
  }, [poolIds, playerCount]);

  if (!state) return null;
  const room = state;

  const host = room.players.find((p) => p.id === room.hostId);
  const have = room.pool.length;
  /** The only hard number left: there is no pile size to reach, just one not to pass. */
  const full = have >= MAX_POOL_IMAGES;
  const count = `${have} photo${have === 1 ? '' : 's'}`;
  /** The server re-checks this at the deal, so don't offer a button it is going to refuse. */
  const tooFew = playerCount < MIN_PLAYERS_TO_START;
  /**
   * Not a requirement any more -- just the number a host who wants one each is aiming for, so it
   * only earns its place once there is a pile to compare against. On an empty screen it reads as
   * the target this change exists to remove.
   */
  const uniqueHint =
    !tooFew && have > 0 && have < playerCount
      ? `Make it ${playerCount} and everyone gets a different one.`
      : null;

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // so picking the same file twice still fires change
    if (files.length === 0 || uploading) return;
    // Nothing offers the picker once the pile is full, but a pick already in the air deserves a
    // sentence rather than photos squeezed only for the server to turn them down.
    const slots = MAX_POOL_IMAGES - have;
    if (slots <= 0) {
      setPhotoError(`The pile is full at ${MAX_POOL_IMAGES} — drop one before adding another.`);
      return;
    }
    // A multi-select bigger than the room left in the pile loses its tail below, and a batch with
    // a bad photo in it can end under the cap -- so the only honest moment to say so is now.
    const dropped = files.length - slots;
    setPhotoError(
      dropped > 0
        ? `Only ${slots} more would fit — ${dropped} ${dropped === 1 ? 'photo was' : 'photos were'} left out.`
        : null,
    );
    setUploading(true);
    try {
      // Room left in the pile is counted once per batch: the server is the real gatekeeper, this
      // only saves us squeezing photos it is about to refuse.
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
              {host ? host.name : 'The host'} is picking the photos…{' '}
              {have === 0 ? 'nothing yet' : `${have} so far`}
            </p>
            <p className="hint">
              Dealt at random once the host is happy with the pile. You find out which photo you
              got when the clock starts.
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
        <p className="subtitle">As many as you like, dealt at random. Nobody gets to choose.</p>
      </div>

      <div className="screen-body stack">
        {/* The picker stays put through a batch that fills the pile, because the squeezing state
            lives inside it. */}
        {(!full || uploading) && (
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

        {/* Stands in the picker's shoes, height and all: a host culling a full pile is scrolled
            down in the grid, and 200px vanishing above it would move the next ✕ under their
            thumb onto a different photo. */}
        {full && !uploading && (
          <div className="x-drop-note">
            <p className="hint">
              The pile is full — {MAX_POOL_IMAGES} photos is the limit. Drop one to make room for
              another.
            </p>
          </div>
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

        <p className="hint">{dealNote(have, playerCount)}</p>
        {uniqueHint && <p className="hint">{uniqueHint}</p>}

        {have > 0 && (
          <div className="x-photo-grid">
            {room.pool.map((img, i) => (
              <div className="x-photo" key={img.id}>
                {/* The fallback is a full-size photo in a 160px square, and a reload that loses
                    every preview would otherwise fetch 20 of them at once. */}
                <img
                  className="x-photo-img"
                  src={previews[img.id] ?? img.imageUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
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
            {/* One more label for the same input, sitting at the end of the pile: there is no
                size to fill in any more, and once the host has scrolled down here the big target
                above is off screen. A dashed "+" box that did nothing would be a trap. */}
            {!full && (
              <label className="x-photo-slot" htmlFor={PHOTO_INPUT_ID} aria-label="Add a photo">
                +
              </label>
            )}
          </div>
        )}

        {have > 0 && <p className="hint">Tap ✕ on one you regret.</p>}
      </div>

      <div className="screen-foot stack">
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={have === 0 || tooFew || uploading || dealing || !connected}
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
        {tooFew && (
          <p className="hint">
            Everyone else left — wait for someone to come back, or head back to the lobby.
          </p>
        )}
        {!tooFew && have === 0 && <p className="hint">One photo and the button wakes up.</p>}
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
