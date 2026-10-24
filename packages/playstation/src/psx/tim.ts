/**
 * PSX standard "TIM" texture format -- a self-describing bitmap container
 * used by the PSY-Q SDK's GPU library (LoadImage-shaped structures) across
 * many PS1 titles, platform-standard rather than specific to any one game.
 *
 * Layout (all little-endian):
 *   u32 magic       = 0x00000010
 *   u32 flag        bits 0-1: pixel mode (0=4bpp,1=8bpp,2=16bpp,3=24bpp)
 *                    bit 3:   CLUT (palette) block present
 *   [if CLUT]:
 *     u32 clutLength (bytes, includes this 12-byte sub-header)
 *     u16 clutX, clutY, clutW, clutH   (VRAM placement; clutW/H count 16-bit
 *                                       halfwords, i.e. clutW == paletteEntries
 *                                       when clutH == 1)
 *     u16[clutW*clutH] palette entries, each a BGR555 word
 *   image block:
 *     u32 imgLength  (bytes, includes this 12-byte sub-header)
 *     u16 imgX, imgY, imgW, imgH        (VRAM placement; imgW is in 16-bit
 *                                        halfword units, NOT pixels -- the
 *                                        real pixel width depends on pixel
 *                                        mode)
 *     pixel data, tightly packed halfwords
 *
 * Real pixel width = imgW * pixelsPerHalfword(pmode):
 *   4bpp  -> imgW * 4   (4 pixels/halfword)
 *   8bpp  -> imgW * 2   (2 pixels/halfword)
 *   16bpp -> imgW * 1   (1 pixel/halfword, already BGR555)
 *   24bpp -> imgW * 2/3 (3 bytes/pixel packed across halfwords; imgW is
 *                        always a multiple of 3 in real files so this divides
 *                        evenly)
 *
 * This module ships **two independent decode pipelines**, both real and both
 * empirically verified against different games' actual rendered output --
 * they are kept separate rather than merged onto one BGR555->RGB scaling
 * because they disagree on it, and unifying them without new evidence would
 * be an unverified behavior change to whichever side lost:
 *
 *  - `tryParseTim`/`scanTimImages`/`decodeTimToRGBA` (returning `TimRecord`):
 *    a structural, offset-located parse (does not require knowing the TIM's
 *    position up front -- `scanTimImages` finds every self-consistent record
 *    in a blob), decoding via `decodeBGR555`'s `round(c*255/31)` channel
 *    scaling. Confirmed against Parasite Eve's `PE.IMG`: a magic+flag+
 *    self-consistent-length scan across the whole 206MB file found 562
 *    candidates with zero overlaps. Also the only path with 24bpp support.
 *  - `parseTim`/`parseTimIndexed` (returning `TimImage`/`TimIndexed`): a
 *    parse-at-a-known-offset decode via `bgr555ToRgba`'s `c << 3` channel
 *    scaling and context-sensitive (palette-row-relative) key-color
 *    transparency. Confirmed against a real 8bpp/CLUT UI icon decode. Also
 *    the only path with multi-row-CLUT support (`TimIndexed`, `renderTimRow`)
 *    and texture-page/CLUT-selector resolution (`TexPageRef`,
 *    `resolveTexPageRef`, `texRefSourcePixel`) for the standard PSX GPU
 *    tpage/clut addressing scheme primitives (`POLY_FT4`-family and similar)
 *    encode into their vertex/attribute data.
 */

import { dataViewOf } from '@seer-project/core';

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

// ---------------------------------------------------------------------------
// Pipeline 1: offset-located structural parse + scan (decodeBGR555 scaling).
// ---------------------------------------------------------------------------

export type PixelMode = 0 | 1 | 2 | 3;

export interface TimClut {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Raw BGR555 palette entries, w*h of them. */
  colors: Uint16Array;
}

/** A TIM record located by `tryParseTim`/`scanTimImages`, with its pixel payload still packed per `pmode` (not yet expanded to indices/RGBA) -- see `decodeTimToRGBA` to finish decoding it. */
export interface TimRecord {
  /** Byte offset of the magic word within the source buffer. */
  start: number;
  /** Byte offset one past the end of this TIM's image block (its total size). */
  end: number;
  flag: number;
  pmode: PixelMode;
  clut: TimClut | null;
  x: number;
  y: number;
  /** Real pixel width (already adjusted for pixel mode). */
  width: number;
  /** Real pixel height (rows), taken directly from the header field. */
  height: number;
  /** Raw pixel payload, still packed per pmode (not yet expanded to indices/RGBA). */
  pixelData: Uint8Array;
}

export function pixelsPerHalfword(pmode: PixelMode): number {
  switch (pmode) {
    case 0:
      return 4;
    case 1:
      return 2;
    case 2:
      return 1;
    case 3:
      return 2 / 3;
  }
}

/**
 * Try to parse a TIM record at an exact byte offset. Returns null if the
 * magic/flag/length invariants don't hold (caller decides whether that's an
 * error or just "not a TIM here").
 */
export function tryParseTim(data: Uint8Array, offset: number): TimRecord | null {
  const view = dataViewOf(data);
  if (offset + 8 > data.length) return null;
  const magic = view.getUint32(offset, true);
  if (magic !== 0x10) return null;
  const flag = view.getUint32(offset + 4, true);
  if ((flag & ~0xb) !== 0) return null; // only pmode bits (0-1) + CLUT bit (3) may be set
  const pmode = (flag & 0x3) as PixelMode;
  const hasClut = (flag & 0x8) !== 0;

  let pos = offset + 8;
  let clut: TimClut | null = null;

  if (hasClut) {
    if (pos + 12 > data.length) return null;
    const clutLength = view.getUint32(pos, true);
    const cx = view.getUint16(pos + 4, true);
    const cy = view.getUint16(pos + 6, true);
    const cw = view.getUint16(pos + 8, true);
    const ch = view.getUint16(pos + 10, true);
    if (cw === 0 || ch === 0 || clutLength !== 12 + cw * ch * 2 || pos + clutLength > data.length) return null;
    const colors = new Uint16Array(cw * ch);
    for (let i = 0; i < colors.length; i++) colors[i] = view.getUint16(pos + 12 + i * 2, true);
    clut = { x: cx, y: cy, w: cw, h: ch, colors };
    pos += clutLength;
  }

  if (pos + 12 > data.length) return null;
  const imgLength = view.getUint32(pos, true);
  const ix = view.getUint16(pos + 4, true);
  const iy = view.getUint16(pos + 6, true);
  const iwHalfwords = view.getUint16(pos + 8, true);
  const ih = view.getUint16(pos + 10, true);
  if (iwHalfwords === 0 || ih === 0) return null;
  if (imgLength !== 12 + iwHalfwords * ih * 2 || pos + imgLength > data.length) return null;

  const width = Math.round(iwHalfwords * pixelsPerHalfword(pmode));
  const pixelData = data.subarray(pos + 12, pos + imgLength);

  return { start: offset, end: pos + imgLength, flag, pmode, clut, x: ix, y: iy, width, height: ih, pixelData };
}

/**
 * Scan a buffer for every valid TIM record at 4-byte-aligned offsets.
 * Structural-only (magic + internal length self-consistency); does not
 * dedupe or chain-validate.
 */
export function scanTimImages(data: Uint8Array, start = 0, end = data.length): TimRecord[] {
  const results: TimRecord[] = [];
  for (let addr = start; addr + 20 <= end; addr += 4) {
    const tim = tryParseTim(data, addr);
    if (tim) results.push(tim);
  }
  return results;
}

/** Decode a raw PSX BGR555 halfword to RGBA8888. Pure-black (0x0000) is treated as transparent (alpha 0) -- the common PSX authoring convention for a color-keyed background; every other value (including STP-bit-set colors) decodes opaque. */
export function decodeBGR555(v: number): [number, number, number, number] {
  const r5 = v & 0x1f;
  const g5 = (v >> 5) & 0x1f;
  const b5 = (v >> 10) & 0x1f;
  const scale = (c: number) => Math.round((c * 255) / 31);
  if (v === 0) return [0, 0, 0, 0];
  return [scale(r5), scale(g5), scale(b5), 255];
}

/** Expand a TIM's raw palette (if any) to an RGBA color array. */
export function decodeClutToRGBA(clut: TimClut): RgbaColor[] {
  const out: RgbaColor[] = [];
  for (const c of clut.colors) {
    const [r, g, b, a] = decodeBGR555(c);
    out.push({ r, g, b, a });
  }
  return out;
}

/** Decode a 4bpp/8bpp TIM's raw pixel bytes into palette indices, one byte per pixel. */
export function unpackIndices(tim: TimRecord): Uint8Array {
  const out = new Uint8Array(tim.width * tim.height);
  if (tim.pmode === 0) {
    // 4bpp: 2 nibbles per byte, low nibble first
    for (let i = 0; i < out.length; i++) {
      const byte = tim.pixelData[i >> 1]!;
      out[i] = i & 1 ? (byte >> 4) & 0xf : byte & 0xf;
    }
  } else if (tim.pmode === 1) {
    // 8bpp: 1 index per byte
    for (let i = 0; i < out.length; i++) out[i] = tim.pixelData[i]!;
  } else {
    throw new Error(`unpackIndices: pmode ${tim.pmode} has no palette indices`);
  }
  return out;
}

/** Decode any TIM record (any pmode) straight to an RGBA8888 buffer, applying its own embedded CLUT if present. */
export function decodeTimToRGBA(tim: TimRecord): Uint8Array {
  const rgba = new Uint8Array(tim.width * tim.height * 4);
  if (tim.pmode === 0 || tim.pmode === 1) {
    if (!tim.clut) throw new Error('indexed TIM with no CLUT block');
    const palette = decodeClutToRGBA(tim.clut);
    const indices = unpackIndices(tim);
    for (let i = 0; i < indices.length; i++) {
      const c = palette[indices[i]!] ?? { r: 0, g: 0, b: 0, a: 0 };
      rgba[i * 4] = c.r;
      rgba[i * 4 + 1] = c.g;
      rgba[i * 4 + 2] = c.b;
      rgba[i * 4 + 3] = c.a;
    }
  } else if (tim.pmode === 2) {
    const view = dataViewOf(tim.pixelData);
    for (let i = 0; i < tim.width * tim.height; i++) {
      const v = view.getUint16(i * 2, true);
      const [r, g, b, a] = decodeBGR555(v);
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = a;
    }
  } else {
    // 24bpp: 3 bytes/pixel, straight RGB, always opaque (no STP-bit convention at this depth)
    for (let i = 0; i < tim.width * tim.height; i++) {
      rgba[i * 4] = tim.pixelData[i * 3]!;
      rgba[i * 4 + 1] = tim.pixelData[i * 3 + 1]!;
      rgba[i * 4 + 2] = tim.pixelData[i * 3 + 2]!;
      rgba[i * 4 + 3] = 255;
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Pipeline 2: parse-at-known-offset + one-shot RGBA flatten (bgr555ToRgba
// scaling), plus multi-row-CLUT support and GPU texture-page/CLUT resolution.
// ---------------------------------------------------------------------------

export interface TimImage {
  bpp: 4 | 8 | 16 | 24;
  hasClut: boolean;
  /** Actual pixel width/height (already de-halfword-scaled for 4bpp/8bpp). */
  width: number;
  height: number;
  x: number;
  y: number;
  clutX?: number;
  clutY?: number;
  palette?: RgbaColor[];
  /** width*height*4 RGBA8888 pixels. */
  rgba: Uint8Array;
}

/**
 * A TIM kept in its *native indexed* form: raw palette indices plus the
 * complete CLUT block, including its VRAM geometry.
 *
 * `parseTim` flattens a TIM straight to RGBA using CLUT row 0, which is all a
 * single-palette image needs. A tile-composited sprite sheet can instead ship
 * *several* CLUT rows in one TIM and pick a different one per tile via a PSX
 * CLUT id, so a compositor needs the indices and the whole palette grid
 * separately.
 */
export interface TimIndexed {
  bpp: 4 | 8;
  /** Actual pixel width/height (already de-halfword-scaled). */
  width: number;
  height: number;
  /** Pixel-data position in VRAM, in 16-bit halfwords (`x`) and lines (`y`), as declared by the TIM. */
  x: number;
  y: number;
  /** CLUT block position in VRAM, same units. */
  clutX: number;
  clutY: number;
  /** CLUT grid: `clutW` colours per row, `clutH` rows. */
  clutW: number;
  clutH: number;
  palette: RgbaColor[];
  /** `width * height` palette indices, row-major. */
  indices: Uint8Array;
}

/** Parse a 4bpp/8bpp CLUT TIM without collapsing it to RGBA. Returns null if it isn't one. */
export function parseTimIndexed(buf: Uint8Array): TimIndexed | null {
  if (buf.length < 8) return null;
  const view = dataViewOf(buf);
  if (view.getUint32(0, true) !== 0x10) return null;
  const flag = view.getUint32(4, true);
  if ((flag & ~0xf) !== 0) return null;
  const mode = flag & 0x7;
  if ((flag & 0x8) === 0 || (mode !== 0 && mode !== 1)) return null; // indexed + CLUT only
  const bpp: 4 | 8 = mode === 0 ? 4 : 8;

  let off = 8;
  if (off + 12 > buf.length) return null;
  const clutSize = view.getUint32(off, true);
  const clutX = view.getUint16(off + 4, true);
  const clutY = view.getUint16(off + 6, true);
  const clutW = view.getUint16(off + 8, true);
  const clutH = view.getUint16(off + 10, true);
  if (off + 12 + clutW * clutH * 2 > buf.length) return null;
  const palette: RgbaColor[] = [];
  for (let i = 0; i < clutW * clutH; i++) {
    const c = view.getUint16(off + 12 + i * 2, true);
    palette.push(bgr555ToRgba(c, i % clutW === 0));
  }
  off += clutSize;

  if (off + 12 > buf.length) return null;
  const imgX = view.getUint16(off + 4, true);
  const imgY = view.getUint16(off + 6, true);
  const imgWRaw = view.getUint16(off + 8, true);
  const height = view.getUint16(off + 10, true);
  const pixOff = off + 12;
  const width = imgWRaw * (bpp === 8 ? 2 : 4);
  const rowBytes = imgWRaw * 2;
  if (pixOff + rowBytes * height > buf.length) return null;

  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteVal = buf[pixOff + y * rowBytes + (bpp === 8 ? x : x >> 1)]!;
      indices[y * width + x] = bpp === 8 ? byteVal : (x & 1) === 0 ? byteVal & 0xf : byteVal >> 4;
    }
  }
  return { bpp, width, height, x: imgX, y: imgY, clutX, clutY, clutW, clutH, palette, indices };
}

/**
 * Convert a raw PSX 15-bit BGR555 colour to RGBA8888. `isPaletteIndexZero`
 * marks index 0 of a CLUT row, the conventional key-colour transparency slot
 * (rendered fully transparent when its raw value is exactly 0x0000).
 */
export function bgr555ToRgba(c: number, isPaletteIndexZero: boolean): RgbaColor {
  const r = (c & 0x1f) << 3;
  const g = ((c >> 5) & 0x1f) << 3;
  const b = ((c >> 10) & 0x1f) << 3;
  const a = isPaletteIndexZero && c === 0 ? 0 : 255;
  return { r, g, b, a };
}

/**
 * A decoded PSX GPU texture-page/CLUT selector, in the shape the standard
 * `POLY_FT4`-family (and similar textured) GPU primitives encode into their
 * vertex/attribute data. `uBase`/`vBase` are the VRAM page origin (`uBase` in
 * 16-bit halfwords, a multiple of 64; `vBase` in lines, 0 or 256);
 * `colorMode` is the standard PSX TPAGE colour-mode bits (`0`=4bpp, `1`=8bpp);
 * `clutX`/`clutY` are the CLUT block's own VRAM position, already decoded
 * from the 16-bit CLUT-id word (`clutX = (id & 0x3f) * 16, clutY = id >> 6`).
 */
export interface TexPageRef {
  uBase: number;
  vBase: number;
  colorMode: number;
  clutX: number;
  clutY: number;
}

/**
 * Resolve a texture-page/CLUT selector against a corpus of candidate TIMs via
 * "page containment + CLUT-row-range" matching. A literal `tim.x === uBase`
 * match is NOT enough -- a TIM can be placed anywhere *inside* its 64x256
 * VRAM page, not just at its corner -- hence `floor(tim.x/64)*64` rather than
 * `tim.x` directly. Returns the matching TIM plus the CLUT row index within
 * its multi-row CLUT block (0-based, `< tim.clutH`), or `null`.
 */
export function resolveTexPageRef(
  tex: TexPageRef,
  tims: readonly TimIndexed[],
): { tim: TimIndexed; row: number } | null {
  for (const tim of tims) {
    if (Math.floor(tim.x / 64) * 64 !== tex.uBase) continue;
    if (Math.floor(tim.y / 256) * 256 !== tex.vBase) continue;
    const bppMatches = (tim.bpp === 4 && tex.colorMode === 0) || (tim.bpp === 8 && tex.colorMode === 1);
    if (!bppMatches) continue;
    if (tim.clutX !== tex.clutX) continue;
    const row = tex.clutY - tim.clutY;
    if (row < 0 || row >= tim.clutH) continue;
    return { tim, row };
  }
  return null;
}

/**
 * Page-local pixel offset within `tim`'s own raster for a texel `(u, v)`
 * sampled under `tex`'s page selector -- `u`/`v` are already page-local texel
 * units (0-255), not scaled further; only the VRAM page origin and the
 * resolved TIM's own declared position need the halfword->pixel conversion.
 */
export function texRefSourcePixel(
  tex: TexPageRef,
  u: number,
  v: number,
  tim: TimIndexed,
): { sx: number; sy: number } {
  const pxPerHalfword = tim.bpp === 8 ? 2 : 4;
  return {
    sx: tex.uBase * pxPerHalfword + u - tim.x * pxPerHalfword,
    sy: tex.vBase + v - tim.y,
  };
}

/** Render one CLUT row of an indexed TIM to a standalone RGBA image covering the TIM's own full `width x height` raster (row-major). */
export function renderTimRow(tim: TimIndexed, row: number): Uint8Array {
  const rgba = new Uint8Array(tim.width * tim.height * 4);
  const palBase = row * tim.clutW;
  for (let i = 0; i < tim.indices.length; i++) {
    const col = tim.palette[palBase + tim.indices[i]!];
    if (!col) continue;
    rgba[i * 4] = col.r;
    rgba[i * 4 + 1] = col.g;
    rgba[i * 4 + 2] = col.b;
    rgba[i * 4 + 3] = col.a;
  }
  return rgba;
}

/** Parse a TIM image from `buf`. Returns null if the magic/flag don't look like a valid TIM. */
export function parseTim(buf: Uint8Array): TimImage | null {
  if (buf.length < 8) return null;
  const view = dataViewOf(buf);
  const magic = view.getUint32(0, true);
  if (magic !== 0x10) return null;
  const flag = view.getUint32(4, true);
  if ((flag & ~0xf) !== 0) return null; // upper bits must be 0 for a real TIM flag word
  const mode = flag & 0x7;
  const hasClut = (flag & 0x8) !== 0;
  const bppTable: Record<number, 4 | 8 | 16 | 24> = { 0: 4, 1: 8, 2: 16, 3: 24 };
  const bpp = bppTable[mode];
  if (!bpp) return null;

  let off = 8;
  let palette: RgbaColor[] | undefined;
  let clutX: number | undefined;
  let clutY: number | undefined;
  if (hasClut) {
    if (off + 12 > buf.length) return null;
    const clutSize = view.getUint32(off, true);
    clutX = view.getUint16(off + 4, true);
    clutY = view.getUint16(off + 6, true);
    const clutW = view.getUint16(off + 8, true);
    const clutH = view.getUint16(off + 10, true);
    const nColors = clutW * clutH;
    if (off + 12 + nColors * 2 > buf.length) return null;
    palette = [];
    for (let i = 0; i < nColors; i++) {
      const c = view.getUint16(off + 12 + i * 2, true);
      palette.push(bgr555ToRgba(c, i === 0));
    }
    off += clutSize;
  }

  if (off + 12 > buf.length) return null;
  const imgSize = view.getUint32(off, true);
  const imgX = view.getUint16(off + 4, true);
  const imgY = view.getUint16(off + 6, true);
  const imgWRaw = view.getUint16(off + 8, true);
  const imgH = view.getUint16(off + 10, true);
  const pixOff = off + 12;
  // imgSize's own 12-byte sub-header must be included in its own count; the
  // real, precise bounds guard is the per-bpp pixel-data check below (against
  // the actual computed pixel byte count), not this field.
  if (imgSize < 12) return null;

  let width: number;
  const height = imgH;
  let rgba: Uint8Array;

  if (bpp === 8) {
    width = imgWRaw * 2;
    const pixCount = width * height;
    if (pixOff + pixCount > buf.length) return null;
    rgba = new Uint8Array(pixCount * 4);
    for (let i = 0; i < pixCount; i++) {
      const idx = buf[pixOff + i]!;
      const col = palette?.[idx] ?? { r: idx, g: idx, b: idx, a: 255 };
      rgba[i * 4] = col.r;
      rgba[i * 4 + 1] = col.g;
      rgba[i * 4 + 2] = col.b;
      rgba[i * 4 + 3] = col.a;
    }
  } else if (bpp === 4) {
    width = imgWRaw * 4;
    const rowBytes = imgWRaw * 2;
    if (pixOff + rowBytes * height > buf.length) return null;
    rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byteVal = buf[pixOff + y * rowBytes + (x >> 1)]!;
        const idx = (x & 1) === 0 ? byteVal & 0xf : byteVal >> 4;
        const col = palette?.[idx] ?? { r: idx * 17, g: idx * 17, b: idx * 17, a: 255 };
        const p = (y * width + x) * 4;
        rgba[p] = col.r;
        rgba[p + 1] = col.g;
        rgba[p + 2] = col.b;
        rgba[p + 3] = col.a;
      }
    }
  } else if (bpp === 16) {
    width = imgWRaw;
    const pixCount = width * height;
    if (pixOff + pixCount * 2 > buf.length) return null;
    rgba = new Uint8Array(pixCount * 4);
    for (let i = 0; i < pixCount; i++) {
      const c = view.getUint16(pixOff + i * 2, true);
      const col = bgr555ToRgba(c, false);
      rgba[i * 4] = col.r;
      rgba[i * 4 + 1] = col.g;
      rgba[i * 4 + 2] = col.b;
      rgba[i * 4 + 3] = c === 0 ? 0 : 255;
    }
  } else {
    return null; // 24bpp: not implemented in this pipeline -- use tryParseTim/decodeTimToRGBA instead
  }

  return { bpp, hasClut, width, height, x: imgX, y: imgY, clutX, clutY, palette, rgba };
}
