/**
 * A palette-index framebuffer: one `Uint8Array` byte per pixel, holding an
 * index into some palette rather than a color directly (the classic
 * 8/16-bit-era indexed-bitmap convention these games were built around —
 * see the walker plan's "Key decision: indexed art" section).
 *
 * `blit` is the entire compositor primitive: every piece placement in
 * `raster/composite.ts` reduces to one call. Mirroring is exact pixel-order
 * reversal in index space (no resampling), and blit is defensively clipped
 * against both the source and destination bounds so a bad descriptor
 * coordinate can't corrupt memory outside the framebuffer.
 */
import type { BlendMode } from '../schema/slots.ts';

export type { BlendMode };

/**
 * A blittable source: a rectangular index buffer, plus an optional
 * same-shape opacity plane for `blend: 'mask'` draws (1 = opaque/draw,
 * 0 = transparent/skip). If `mask` is omitted, every source pixel is
 * treated as opaque — i.e. `'mask'` behaves like `'replace'`.
 */
export interface BlitSource {
  data: Uint8Array;
  width: number;
  height: number;
  mask?: Uint8Array;
}

export class IndexedSurface {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }

  /** Fill the whole surface with a single palette index (default 0 — the reserved background index). */
  clear(index = 0): void {
    this.data.fill(index);
  }

  /**
   * Copy a `sw`×`sh` rectangle from `(sx, sy)` in `src` to `(dx, dy)` in
   * this surface.
   *
   * - `mirrorX: true` reverses column order within the copied rectangle
   *   (exact pixel reversal, not a flipped read of the whole source image).
   * - `blend: 'replace'` overwrites destination pixels unconditionally.
   * - `blend: 'mask'` only writes where `src.mask` says the source pixel is
   *   opaque (or everywhere, if `src.mask` is absent).
   * - `blend: 'or'` bitwise-ORs the destination index with the source
   *   index. Black Crypt never uses this blend (see the walker plan); it
   *   exists for a later, W6-driven milestone and is not exercised by any
   *   M1 fixture.
   *
   * Both source and destination rectangles are clipped to their buffer
   * bounds — an out-of-range descriptor coordinate is silently cropped,
   * never a memory fault or wraparound.
   */
  blit(
    src: BlitSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    mirrorX: boolean,
    blend: BlendMode,
  ): void {
    for (let row = 0; row < sh; row++) {
      const srcY = sy + row;
      const destY = dy + row;
      if (srcY < 0 || srcY >= src.height || destY < 0 || destY >= this.height) continue;
      const srcRowBase = srcY * src.width;
      const destRowBase = destY * this.width;

      for (let col = 0; col < sw; col++) {
        const destX = dx + col;
        if (destX < 0 || destX >= this.width) continue;

        const srcCol = mirrorX ? sw - 1 - col : col;
        const srcX = sx + srcCol;
        if (srcX < 0 || srcX >= src.width) continue;

        const srcIdx = srcRowBase + srcX;

        if (blend === 'mask' && src.mask && src.mask[srcIdx] === 0) continue;

        const destIdx = destRowBase + destX;
        const value = src.data[srcIdx] as number;
        this.data[destIdx] = blend === 'or' ? ((this.data[destIdx] as number) | value) & 0xff : value;
      }
    }
  }
}
