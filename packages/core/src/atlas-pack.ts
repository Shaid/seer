/**
 * Shelf-packing layout for the `AtlasFrame[]`/`AtlasMeta` shapes declared
 * in `atlas.js` — given a list of named rectangle sizes (or already-decoded
 * RGBA images), computes (x, y) placement for each into a bounded-width
 * atlas, growing height as needed.
 *
 * Not space-optimal (no bin-packing search) — good enough for offline
 * pipeline atlases where build time matters more than a few percent of
 * wasted pixels. This was independently reimplemented, byte-for-byte
 * identically in two projects and near-identically in a third, before
 * being promoted here — reuse this instead of writing a new packer per
 * project.
 */
import type { AtlasFrame, AtlasMeta } from './atlas.js';

export interface ShelfPackInput {
  name: string;
  width: number;
  height: number;
}

/**
 * Shelf-pack rectangles left-to-right into rows no wider than `maxWidth`,
 * starting a new row (a "shelf") once the current one would overflow.
 * Input order is preserved within each shelf; sort by descending height
 * first if you want tighter packing.
 */
export function shelfPack(items: ShelfPackInput[], maxWidth: number, padding = 1): AtlasMeta {
  const frames: AtlasFrame[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let shelfHeight = 0;
  let atlasWidth = 0;

  for (const item of items) {
    if (cursorX > 0 && cursorX + item.width > maxWidth) {
      cursorX = 0;
      cursorY += shelfHeight + padding;
      shelfHeight = 0;
    }
    frames.push({ name: item.name, x: cursorX, y: cursorY, w: item.width, h: item.height });
    cursorX += item.width + padding;
    shelfHeight = Math.max(shelfHeight, item.height);
    atlasWidth = Math.max(atlasWidth, cursorX - padding);
  }

  return { frames, width: atlasWidth, height: cursorY + shelfHeight };
}

export interface PackableImage {
  name: string;
  width: number;
  height: number;
  /** RGBA pixels, row-major, length === width * height * 4. */
  rgba: Uint8Array;
}

export interface PackedAtlas extends AtlasMeta {
  rgba: Uint8Array;
}

/**
 * Shelf-pack a list of already-decoded RGBA images into one atlas image,
 * blitting each into place and returning both the composited pixels and
 * the `AtlasFrame[]` sidecar the runtime/viewer expect. Images are placed
 * in input order, not size-sorted.
 */
export function packAtlasRgba(images: PackableImage[], maxWidth = 1024, padding = 1): PackedAtlas {
  const { frames, width, height } = shelfPack(images, maxWidth, padding);
  const rgba = new Uint8Array(width * height * 4);

  for (let i = 0; i < images.length; i++) {
    const { width: w, height: h, rgba: src } = images[i];
    const { x, y } = frames[i];
    for (let row = 0; row < h; row++) {
      const dstStart = ((y + row) * width + x) * 4;
      const srcStart = row * w * 4;
      rgba.set(src.subarray(srcStart, srcStart + w * 4), dstStart);
    }
  }

  return { frames, width, height, rgba };
}
