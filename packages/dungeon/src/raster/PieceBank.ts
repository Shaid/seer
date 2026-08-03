/**
 * Decodes a game's RGBA sprite atlas into one indexed pixel buffer plus a
 * derived local palette, once, up front. `PieceBank` has no PNG-decoding
 * or DOM dependency — the caller decodes the atlas PNG to raw RGBA bytes
 * however suits its environment (`pngjs` in Node/Vitest, `<canvas>` in the
 * browser) and hands the pixels here.
 *
 * ## Why a "local palette" derived from the PNG, not a real indexed source
 *
 * The committed atlas (`dungeon-bcdfx.png`) is a plain RGBA export, not
 * already palette-indexed — a proper indexed re-export (serving every
 * accent ramp a tileset needs, per the walker plan) is later, out-of-scope
 * Phase C work. Until then, `PieceBank.fromRGBA` inventories the distinct
 * RGBA colors actually present in whatever atlas it's given and assigns
 * each an index — a real, reusable decode path (any RGBA atlas in, an
 * indexed buffer + palette out), not a one-off hack for this milestone.
 *
 * ## Mask derivation
 *
 * Investigated `dungeon-bcdfx.png` directly: every pixel's alpha is either
 * 0 or 255 (no partial values anywhere in the image), opaque-art frames
 * (front walls, ceiling, floor) are alpha=255 across their entire bounding
 * box, and masked frames (side walls, and per the doc's 7-plane
 * "mask-first" format, doors/pillars/etc.) have real alpha=0 holes within
 * their bounding box (roughly 5% of pixels, in the side-wall frames
 * sampled). So the PNG's own alpha channel already IS the mask plane the
 * doc describes — no separate mask convention needed for this atlas.
 * `fromRGBA` derives `mask` straight from `alpha !== 0`.
 *
 * Palette index 0 is reserved as the surface-background sentinel (see
 * `palette.ts`) and is never assigned to a real atlas color; every
 * alpha=0 (transparent) source pixel maps to index 0 too, since it's never
 * drawn (mask blits skip it, and non-mask blits shouldn't be sourcing
 * transparent pixels in the first place).
 */
import type { AtlasFrame, AtlasMeta } from '@seer/core';
import type { BlitSource } from './IndexedSurface.ts';
import { BACKGROUND_COLOR, type RGBAColor } from './palette.ts';

export interface PieceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_PALETTE_SIZE = 256;

export class PieceBank {
  readonly width: number;
  readonly height: number;
  readonly index: Uint8Array;
  readonly mask: Uint8Array;
  readonly palette: RGBAColor[];
  private readonly frames: Map<string, PieceRect>;

  private constructor(width: number, height: number, index: Uint8Array, mask: Uint8Array, palette: RGBAColor[], frames: Map<string, PieceRect>) {
    this.width = width;
    this.height = height;
    this.index = index;
    this.mask = mask;
    this.palette = palette;
    this.frames = frames;
  }

  /**
   * Decode `rgba` (interleaved R,G,B,A bytes, `width * height * 4` long)
   * plus its atlas metadata into a `PieceBank`.
   */
  static fromRGBA(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, atlas: AtlasMeta): PieceBank {
    const pixelCount = width * height;
    if (rgba.length !== pixelCount * 4) {
      throw new Error(`PieceBank.fromRGBA: expected ${pixelCount * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}`);
    }

    const index = new Uint8Array(pixelCount);
    const mask = new Uint8Array(pixelCount);
    const palette: RGBAColor[] = [BACKGROUND_COLOR];
    const colorToIndex = new Map<string, number>();

    for (let i = 0; i < pixelCount; i++) {
      const o = i * 4;
      const r = rgba[o] as number;
      const g = rgba[o + 1] as number;
      const b = rgba[o + 2] as number;
      const a = rgba[o + 3] as number;

      if (a === 0) {
        // Transparent source pixel: never drawn, so it doesn't need its
        // own palette entry — collapse it onto the reserved background index.
        index[i] = 0;
        mask[i] = 0;
        continue;
      }

      mask[i] = 1;
      const key = `${r},${g},${b},${a}`;
      let idx = colorToIndex.get(key);
      if (idx === undefined) {
        if (palette.length >= MAX_PALETTE_SIZE) {
          throw new Error(`PieceBank.fromRGBA: atlas has more than ${MAX_PALETTE_SIZE} distinct colors, cannot fit a local Uint8 palette`);
        }
        idx = palette.length;
        palette.push({ r, g, b, a });
        colorToIndex.set(key, idx);
      }
      index[i] = idx;
    }

    const frames = new Map<string, PieceRect>();
    for (const f of atlas.frames as AtlasFrame[]) {
      frames.set(f.name, { x: f.x, y: f.y, w: f.w, h: f.h });
    }

    return new PieceBank(width, height, index, mask, palette, frames);
  }

  /**
   * Decode a *true palette-indexed* atlas — `scripts/export_dungeon_tileset_
   * indexed.py`'s `dungeon-<name>-indexed.png` (+ `-indexed-mask.png`) — into
   * a `PieceBank` whose `.index` values are the game's own raw EHB palette
   * indices (0-63), not an arbitrary per-atlas dedup like `fromRGBA`. That
   * portable index domain is exactly what every one of a tileset's
   * `palettes/dungeon-<name>-ramp<N>.json` files shares (M4, `walker-plan.md`
   * "ramp-aware rendering") — swap which ramp array a presenter's `.present()`
   * uses and the same index buffer renders correctly under any ramp,
   * unlike `fromRGBA`'s locally-derived palette which is meaningless outside
   * the one atlas it was built from.
   *
   * `rgba`/`maskRgba` are the two PNGs already decoded to interleaved RGBA
   * bytes by whatever decoder the caller has (Node `pngjs`, or a browser
   * `<canvas>` readback — both work identically here, unlike a "give me the
   * raw index bytes" API would: a `<canvas>` round-trip always rasterizes a
   * PNG to RGBA, discarding a color-type-3 PNG's own index identity before
   * `getImageData` can see it). The index is instead *recovered* by matching
   * each decoded pixel's exact RGB against `basePalette` — the same ramp the
   * PNG's own embedded palette was baked with (the export script's "primary
   * ramp", always ramp index 0 for any tileset that serves it) — which is
   * exact because the PNG has no lossy recompression between export and
   * decode. `maskRgba`'s value is read from its red channel (a grayscale
   * 0/255 image — R=G=B), thresholded at 128.
   */
  static fromIndexedRGBA(
    rgba: Uint8Array | Uint8ClampedArray,
    maskRgba: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    atlas: AtlasMeta,
    basePalette: RGBAColor[],
  ): PieceBank {
    const pixelCount = width * height;
    if (rgba.length !== pixelCount * 4) {
      throw new Error(`PieceBank.fromIndexedRGBA: expected ${pixelCount * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}`);
    }
    if (maskRgba.length !== pixelCount * 4) {
      throw new Error(`PieceBank.fromIndexedRGBA: mask image must be ${width}x${height} too (${pixelCount * 4} RGBA bytes), got ${maskRgba.length}`);
    }

    const colorToIndex = new Map<string, number>();
    basePalette.forEach((c, i) => {
      const key = `${c.r},${c.g},${c.b}`;
      if (!colorToIndex.has(key)) colorToIndex.set(key, i); // first index wins on a duplicate color
    });

    const index = new Uint8Array(pixelCount);
    const mask = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const o = i * 4;
      const key = `${rgba[o]},${rgba[o + 1]},${rgba[o + 2]}`;
      const idx = colorToIndex.get(key);
      if (idx === undefined) {
        const x = i % width;
        const y = Math.floor(i / width);
        throw new Error(
          `PieceBank.fromIndexedRGBA: pixel (${x},${y}) color (${rgba[o]},${rgba[o + 1]},${rgba[o + 2]}) isn't in basePalette — wrong ramp paired with this atlas?`,
        );
      }
      index[i] = idx;
      mask[i] = (maskRgba[o] as number) > 127 ? 1 : 0;
    }

    const frames = new Map<string, PieceRect>();
    for (const f of atlas.frames as AtlasFrame[]) {
      frames.set(f.name, { x: f.x, y: f.y, w: f.w, h: f.h });
    }

    return new PieceBank(width, height, index, mask, [...basePalette], frames);
  }

  hasFrame(name: string): boolean {
    return this.frames.has(name);
  }

  frame(name: string): PieceRect {
    const rect = this.frames.get(name);
    if (!rect) throw new Error(`PieceBank: unknown frame "${name}"`);
    return rect;
  }

  /** The whole decoded atlas as an `IndexedSurface.blit` source; frame rects index into this. */
  source(): BlitSource {
    return { data: this.index, width: this.width, height: this.height, mask: this.mask };
  }
}
