/**
 * Amiga planar bitmap decoding — the shared implementation the cross-repo
 * audit (docs/common-tooling-candidates.md §1) calls for, unifying the
 * per-game `decodePlanar` copies in crawl, sorcery, strike, wyrm, nicodemus
 * and middilgard behind one layout-parameterised decoder.
 *
 * Three layouts cover every Amiga/Atari-ST planar arrangement seen across
 * those repos:
 *
 * - `plane-major`: whole planes stored one after another (crawl's Black
 *   Crypt, strike's `decodeSequentialPlanar`, sprite banks with a trailing
 *   mask plane).
 * - `row-interleaved`: each scanline stores all its planes contiguously —
 *   row 0 plane 0, row 0 plane 1, … (ILBM BODY, strike's Jungle Strike
 *   screens).
 * - `word-interleaved`: planes interleaved every `interleave` bytes within
 *   a row (Atari ST's native layout, default interleave 2 = one word;
 *   nicodemus's Phantasie III containers).
 *
 * All three reduce to one byte-offset formula (nicodemus
 * `bitplaneByteOffset`'s generalisation): the decoders here never throw on
 * short input — bytes past the end of `data` read as 0, matching
 * `@seer-project/core`'s non-throwing `r8`/`r16`/`r32` position that
 * speculative probing at unconfirmed offsets should degrade, not abort.
 */

export type PlanarLayout = 'plane-major' | 'row-interleaved' | 'word-interleaved';

export interface PlanarConfig {
  /** Width in pixels. Amiga hardware bitmaps are word-aligned (width % 16 === 0); this decoder only requires width % 8 === 0. */
  width: number;
  height: number;
  /** Bitplane count, 1–8. Plane 0 is the least significant index bit. */
  planes: number;
  layout: PlanarLayout;
  /** Byte offset into `data` where the bitmap starts. Default 0. */
  offset?: number;
  /**
   * Bytes per row per plane. Default `width / 8` (tight). Set larger when
   * rows carry padding — e.g. a screen-wide buffer holding a narrower
   * image, or planes padded to an even word.
   */
  rowBytes?: number;
  /**
   * `plane-major` only: bytes between consecutive plane starts. Default
   * `rowBytes * height` (tight). Set larger when planes are padded — the
   * `planar-plane-padding-vs-tight-stride` failure mode, where a tight
   * decode of padded planes shears every plane after the first.
   */
  planeStride?: number;
  /** `word-interleaved` only: bytes per interleave unit. Default 2 (one word, the Atari ST layout). */
  interleave?: number;
}

/**
 * Byte offset (relative to `config.offset`) of the byte holding pixel byte
 * column `byteX` (= `x >> 3`), row `y`, plane `plane`.
 */
export function planarByteOffset(
  byteX: number,
  y: number,
  plane: number,
  config: PlanarConfig,
): number {
  const rowBytes = config.rowBytes ?? config.width >> 3;
  switch (config.layout) {
    case 'plane-major': {
      const planeStride = config.planeStride ?? rowBytes * config.height;
      return plane * planeStride + y * rowBytes + byteX;
    }
    case 'row-interleaved':
      return y * rowBytes * config.planes + plane * rowBytes + byteX;
    case 'word-interleaved': {
      const ilv = config.interleave ?? 2;
      return (
        y * rowBytes * config.planes +
        Math.floor(byteX / ilv) * config.planes * ilv +
        plane * ilv +
        (byteX % ilv)
      );
    }
  }
}

/**
 * Total bytes one bitmap occupies at this config — the span from the first
 * byte to one past the last, including any rowBytes/planeStride padding.
 */
export function planarByteLength(config: PlanarConfig): number {
  const rowBytes = config.rowBytes ?? config.width >> 3;
  if (config.layout === 'plane-major') {
    const planeStride = config.planeStride ?? rowBytes * config.height;
    return (config.planes - 1) * planeStride + config.height * rowBytes;
  }
  return config.height * rowBytes * config.planes;
}

/**
 * Decode a planar bitmap into one palette-index byte per pixel, row-major
 * (`width * height` bytes, index = `y * width + x`). Bits are MSB-first
 * within each byte (Amiga/ST convention); bytes beyond `data`'s end read
 * as 0 rather than throwing.
 */
export function decodePlanar(data: Uint8Array, config: PlanarConfig): Uint8Array {
  const { width, height, planes } = config;
  const base = config.offset ?? 0;
  const out = new Uint8Array(width * height);
  const bytesPerRow = width >> 3;

  for (let plane = 0; plane < planes; plane++) {
    const bit = 1 << plane;
    for (let y = 0; y < height; y++) {
      const rowOut = y * width;
      for (let byteX = 0; byteX < bytesPerRow; byteX++) {
        const byte = data[base + planarByteOffset(byteX, y, plane, config)] ?? 0;
        if (byte === 0) continue;
        const xOut = rowOut + (byteX << 3);
        for (let b = 0; b < 8; b++) {
          if ((byte >> (7 - b)) & 1) out[xOut + b] |= bit;
        }
      }
    }
  }
  return out;
}
