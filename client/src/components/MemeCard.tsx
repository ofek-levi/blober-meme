import type { ReactElement, ReactNode } from 'react';

/**
 * The meme itself. `.meme` is a size container and `.meme-text` sizes in `cqw`, so the
 * same component reads correctly as a full-width preview and as a small grid tile.
 */
export function MemeCard({
  imageUrl,
  topText,
  bottomText,
  className,
  children,
}: {
  imageUrl: string | null;
  topText: string;
  bottomText: string;
  className?: string;
  /** Overlay badges, e.g. a vote count. */
  children?: ReactNode;
}): ReactElement {
  return (
    <div className={className ? `meme ${className}` : 'meme'}>
      {imageUrl === null ? (
        <div className="meme-empty" />
      ) : (
        <img className="meme-img" src={imageUrl} alt="" />
      )}
      {/* Uppercasing is done in CSS so the author's own casing survives in the input. */}
      {topText.trim() !== '' && <span className="meme-text top">{topText}</span>}
      {bottomText.trim() !== '' && <span className="meme-text bottom">{bottomText}</span>}
      {children}
    </div>
  );
}
