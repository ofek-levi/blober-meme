/**
 * Turn whatever the phone's photo picker handed us into something small enough to
 * push down a socket: resized, re-encoded as JPEG, and under TARGET_IMAGE_BYTES.
 *
 * Every Error thrown here is written to be shown to the player verbatim.
 */
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  TARGET_IMAGE_BYTES,
} from '../types';

export interface PreparedImage {
  /** The exact bytes to send with submitMeme. */
  bytes: ArrayBuffer;
  mimeType: string;
  /** Object URL of the compressed result, so the preview is what everyone else sees. */
  previewUrl: string;
}

/** Tried in order, stopping as soon as the blob fits; the last one is the floor. */
const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.42];

const UNSUPPORTED = "That file type isn't supported — use a JPG, PNG or WebP.";
const UNREADABLE = "That image couldn't be read — try another photo.";
const TOO_BIG = 'That photo is still too big after compressing — try a smaller one.';

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(UNSUPPORTED);
  }

  const source = await decode(file);
  let blob: Blob;
  try {
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(UNREADABLE);
    ctx.drawImage(source.image, 0, 0, width, height);

    blob = await encodeJpeg(canvas, QUALITY_STEPS[0]);
    for (let i = 1; i < QUALITY_STEPS.length && blob.size > TARGET_IMAGE_BYTES; i++) {
      blob = await encodeJpeg(canvas, QUALITY_STEPS[i]);
    }
  } finally {
    source.release();
  }

  // We ran out of quality steps rather than loop forever, so the floor may still be too big.
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(TOO_BIG);

  return {
    bytes: await blob.arrayBuffer(),
    mimeType: 'image/jpeg',
    previewUrl: URL.createObjectURL(blob),
  };
}

/** Hand back a previewUrl once the preview is gone, so the blob can be collected. */
export function releasePreview(previewUrl: string | null | undefined): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
}

interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

async function decode(file: File): Promise<DecodedImage> {
  // createImageBitmap applies EXIF orientation, so photos off a phone are not sideways.
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(UNREADABLE);
    }
    return {
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    return {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(UNREADABLE));
    img.src = url;
  });
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(UNREADABLE))),
      'image/jpeg',
      quality
    );
  });
}
