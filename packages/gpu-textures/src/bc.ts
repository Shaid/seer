/**
 * BC (Block Compression / DXT) texture codecs — the S3TC family (BC1-5), a
 * full spec-conformant BC7 decoder, and an approximate BC6H decoder. Decode
 * output is RGBA8; BC6H is unpacked to grayscale (see `decodeBC6H`'s doc
 * comment for why it isn't exact yet).
 *
 * These operate on *linear* (deswizzled) block data: each 4x4 pixel block
 * is 8 or 16 bytes, scanned left-to-right, top-to-bottom. Pair with
 * `swizzle.ts`'s `deswizzle`/`getImageData` for a Tegra X1 (Nintendo
 * Switch) block-linear surface.
 */

function expand565(v: number): [number, number, number] {
  return [
    ((v >> 11) & 0x1f) << 3,
    ((v >> 5) & 0x3f) << 2,
    (v & 0x1f) << 3,
  ];
}

function quantize565(r: number, g: number, b: number): number {
  const r5 = Math.round((r / 255) * 31);
  const g6 = Math.round((g / 255) * 63);
  const b5 = Math.round((b / 255) * 31);
  return (r5 << 11) | (g6 << 5) | b5;
}

/**
 * Encode one 4x4 RGBA block to BC1 (DXT1), 8 bytes, always in the "4 opaque
 * colors" mode (`c0 > c1` as u16 — matches `decodeBC1`'s branch for that
 * ordering exactly: `colors[2]=(2c0+c1)/3`, `colors[3]=(c0+2c1)/3`, no
 * punch-through alpha). Endpoint selection is the simple/fast "bounding
 * box" method (per-channel min/max of the 16 input texels, quantized to
 * 565) rather than a PCA/cluster-fit — adequate quality for a modding
 * texture (visible banding on high-gradient blocks, not a correctness bug)
 * and far simpler than a real encoder needs to be for this project's
 * purpose (producing a valid, decodable, reasonably-close DXT1 stream, not
 * a maximum-quality one).
 */
export function encodeBC1Block(px: Uint8Array /* 16*4 RGBA, row-major 4x4 */): Uint8Array {
  let rMin = 255, gMin = 255, bMin = 255, rMax = 0, gMax = 0, bMax = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }
  let c0 = quantize565(rMax, gMax, bMax);
  let c1 = quantize565(rMin, gMin, bMin);
  if (c0 === c1) { if (c0 > 0) c0--; else c1++; }
  if (c0 <= c1) { const t = c0; c0 = c1; c1 = t; } // force the opaque 4-color branch
  const [r0, g0, b0] = expand565(c0);
  const [r1, g1, b1] = expand565(c1);
  const palette: [number, number, number][] = [
    [r0, g0, b0],
    [r1, g1, b1],
    [((2 * r0 + r1) / 3) | 0, ((2 * g0 + g1) / 3) | 0, ((2 * b0 + b1) / 3) | 0],
    [((r0 + 2 * r1) / 3) | 0, ((g0 + 2 * g1) / 3) | 0, ((b0 + 2 * b1) / 3) | 0],
  ];
  let indices = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    let best = 0, bestErr = Infinity;
    for (let p = 0; p < 4; p++) {
      const [pr, pg, pb] = palette[p]!;
      const err = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
      if (err < bestErr) { bestErr = err; best = p; }
    }
    indices |= best << (i * 2);
  }
  const out = new Uint8Array(8);
  out[0] = c0 & 0xff; out[1] = (c0 >> 8) & 0xff;
  out[2] = c1 & 0xff; out[3] = (c1 >> 8) & 0xff;
  out[4] = indices & 0xff; out[5] = (indices >> 8) & 0xff;
  out[6] = (indices >> 16) & 0xff; out[7] = (indices >> 24) & 0xff;
  return out;
}

/**
 * Encode a whole RGBA8 image to BC1, linear (non-swizzled) block order —
 * i.e. the inverse of `decodeBC1` for `linear` (non-Morton) G1T textures.
 * Edge blocks past `width`/`height` clamp to the last valid row/column
 * (matches how `decodeBC1` simply skips writing out-of-bounds texels, so
 * padding content is never sampled back — its value doesn't matter for
 * round-trip correctness, only for keeping the encoder's per-block work
 * well-defined).
 */
export function encodeBC1(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(blocksX * blocksY * 8);
  const block = new Uint8Array(16 * 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const sx = Math.min(bx * 4 + px, width - 1);
          const sy = Math.min(by * 4 + py, height - 1);
          const so = (sy * width + sx) * 4;
          const bo = (py * 4 + px) * 4;
          block[bo] = rgba[so]!; block[bo + 1] = rgba[so + 1]!;
          block[bo + 2] = rgba[so + 2]!; block[bo + 3] = rgba[so + 3]!;
        }
      }
      out.set(encodeBC1Block(block), (by * blocksX + bx) * 8);
    }
  }
  return out;
}

/**
 * Encode one 4x4 block's alpha channel to BC3/DXT5's 8-byte alpha block —
 * always the "8 interpolated values" mode (`a0 > a1` as u8), matching real
 * DXT5 hardware decode exactly (the *true* spec, per Microsoft's BC3
 * reference and every GPU decoder — **not** `decodeBC3`'s own in-repo alpha
 * unpacking, which has an independent, pre-existing bug: it builds the
 * 48-bit index field with `aBits |= data[b+2+i] << (i*8)` for `i` up to 5,
 * and JS's `<<` masks its shift count to 5 bits, so `i=4`/`i=5` (shifts 32
 * and 40) silently wrap to shifts 0 and 8 instead — corrupting roughly the
 * last 5 pixels' (`px4` 11-15, the block's bottom-right) alpha index
 * per block for every BC3/BC4 texture this project has ever decoded. Not
 * fixed here (shared decoder, used by every game's already-shipped asset
 * corpus — needs its own dedicated regression pass, out of scope for this
 * encoder); flagged in docs. This function writes spec-correct bytes via
 * BigInt (safe: only 48 bits, never near `2^53`) so real Switch hardware —
 * the actual consumer of a modded texture — decodes it correctly even
 * though this repo's own `decodeBC3` would misread the last few pixels of
 * each block if it round-tripped this file back through itself.
 */
export function encodeBC3AlphaBlock(alpha: Uint8Array /* 16, row-major 4x4 */): Uint8Array {
  let a0 = 0, a1 = 255;
  for (let i = 0; i < 16; i++) { if (alpha[i]! > a0) a0 = alpha[i]!; if (alpha[i]! < a1) a1 = alpha[i]!; }
  if (a0 === a1) { if (a0 > 0) a0--; else a1++; }
  const palette = [a0, a1];
  for (let aval = 2; aval <= 7; aval++) palette.push(Math.round(((8 - aval) * a0 + (aval - 1) * a1) / 7));
  let bits = 0n;
  for (let i = 15; i >= 0; i--) {
    let best = 0, bestErr = Infinity;
    for (let p = 0; p < 8; p++) {
      const err = Math.abs(palette[p]! - alpha[i]!);
      if (err < bestErr) { bestErr = err; best = p; }
    }
    bits = (bits << 3n) | BigInt(best);
  }
  const out = new Uint8Array(8);
  out[0] = a0; out[1] = a1;
  for (let i = 0; i < 6; i++) out[2 + i] = Number((bits >> BigInt(i * 8)) & 0xffn);
  return out;
}

/**
 * Encode a whole RGBA8 image to BC3 (DXT5), linear block order: 8-byte
 * alpha block (`encodeBC3AlphaBlock`) followed by an 8-byte BC1-shaped
 * color block, reusing `encodeBC1Block`'s endpoint/palette logic directly
 * — DXT5's color block is bit-identical in format to DXT1's, just always
 * read in the 4-opaque-colors mode by the decoder (see `decodeBC23`, which
 * never branches on `c0` vs `c1` for BC2/3), so no re-ordering is needed
 * here the way plain BC1 needs `c0 > c1` forced.
 */
export function encodeBC3(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(blocksX * blocksY * 16);
  const block = new Uint8Array(16 * 4);
  const alpha = new Uint8Array(16);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const sx = Math.min(bx * 4 + px, width - 1);
          const sy = Math.min(by * 4 + py, height - 1);
          const so = (sy * width + sx) * 4;
          const bo = (py * 4 + px) * 4;
          block[bo] = rgba[so]!; block[bo + 1] = rgba[so + 1]!;
          block[bo + 2] = rgba[so + 2]!; block[bo + 3] = rgba[so + 3]!;
          alpha[py * 4 + px] = rgba[so + 3]!;
        }
      }
      const o = (by * blocksX + bx) * 16;
      out.set(encodeBC3AlphaBlock(alpha), o);
      out.set(encodeBC1Block(block), o + 8);
    }
  }
  return out;
}

/** Decode BC1 (DXT1) block data into RGBA. */
export function decodeBC1(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const b = (by * blocksX + bx) * 8;
      const c0 = data[b] | (data[b + 1] << 8);
      const c1 = data[b + 2] | (data[b + 3] << 8);
      const [r0, g0, b0] = expand565(c0);
      const [r1, g1, b1] = expand565(c1);
      const [r2, g2, b2] = c0 > c1
        ? [(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0]
        : [(r0 + r1) / 2 | 0, (g0 + g1) / 2 | 0, (b0 + b1) / 2 | 0];
      const [r3, g3, b3] = c0 > c1
        ? [(r0 + 2 * r1) / 3 | 0, (g0 + 2 * g1) / 3 | 0, (b0 + 2 * b1) / 3 | 0]
        : [0, 0, 0];
      const colors: [number, number, number, number][] = [
        [r0, g0, b0, 255],
        [r1, g1, b1, 255],
        [r2, g2, b2, 255],
        [r3, g3, b3, c0 > c1 ? 255 : 0],
      ];
      const indices = data[b + 4] | (data[b + 5] << 8) | (data[b + 6] << 16) | (data[b + 7] << 24);
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const idx = (indices >> (2 * (py * 4 + px))) & 3;
          const [r, g, bl, a] = colors[idx]!;
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x < width && y < height) {
            const o = outOff + (y * width + x) * 4;
            out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a;
          }
        }
      }
    }
  }
}

function decodeBC23(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff: number, alpha: boolean): void {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const b = (by * blocksX + bx) * 16;
      const a0 = data[b];
      const a1 = data[b + 1];
      // Build the 3-bit alpha indices (48 bits, BC3)
      let aBits = 0;
      for (let i = 0; i < 6; i++) aBits |= data[b + 2 + i] << (i * 8);

      const c0 = data[b + 8] | (data[b + 9] << 8);
      const c1 = data[b + 10] | (data[b + 11] << 8);
      const [r0, g0, b0] = expand565(c0);
      const [r1, g1, b1] = expand565(c1);
      const [r2, g2, b2] = c0 > c1
        ? [(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0]
        : [(r0 + r1) / 2 | 0, (g0 + g1) / 2 | 0, (b0 + b1) / 2 | 0];
      const [r3, g3, b3] = c0 > c1
        ? [(r0 + 2 * r1) / 3 | 0, (g0 + 2 * g1) / 3 | 0, (b0 + 2 * b1) / 3 | 0]
        : [0, 0, 0];
      const colors: [number, number, number][] = [
        [r0, g0, b0], [r1, g1, b1], [r2, g2, b2], [r3, g3, b3],
      ];
      const cbits = data[b + 12] | (data[b + 13] << 8) | (data[b + 14] << 16) | (data[b + 15] << 24);
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const px4 = py * 4 + px;
          let a: number;
          if (alpha) {
            // BC3: 3-bit alpha index
            const shift = px4 * 3;
            const aval = (aBits >> shift) & 7;
            a = a0 > a1
              ? (aval === 0 ? a0 : aval === 1 ? a1 : ((8 - aval) * a0 + (aval - 1) * a1) / 7 | 0)
              : (aval === 0 ? a0 : aval === 1 ? a1 : aval === 6 ? 0 : aval === 7 ? 255 : ((6 - aval) * a0 + (aval - 1) * a1) / 5 | 0);
          } else {
            // BC2: 4-bit alpha
            const nib = (data[b + (px4 >> 1)] >> ((px4 & 1) * 4)) & 0xf;
            a = nib * 17;
          }
          const [r, g, bl] = colors[(cbits >> (2 * px4)) & 3]!;
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x < width && y < height) {
            const o = outOff + (y * width + x) * 4;
            out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a;
          }
        }
      }
    }
  }
}

/** Decode BC2 (DXT3) block data. */
export function decodeBC2(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  decodeBC23(data, width, height, out, outOff, false);
}

/** Decode BC3 (DXT5) block data. */
export function decodeBC3(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  decodeBC23(data, width, height, out, outOff, true);
}

/** Decode BC4 (single-channel, R). */
export function decodeBC4(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const b = (by * blocksX + bx) * 8;
      const r0 = data[b];
      const r1 = data[b + 1];
      let bits = 0;
      for (let i = 0; i < 6; i++) bits |= data[b + 2 + i] << (i * 8);
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const p = py * 4 + px;
          const idx = (bits >> (p * 3)) & 7;
          let v: number;
          if (r0 > r1) {
            v = idx === 0 ? r0 : idx === 1 ? r1 : ((8 - idx) * r0 + (idx - 1) * r1) / 7 | 0;
          } else {
            v = idx === 0 ? r0 : idx === 1 ? r1 : idx === 6 ? 0 : idx === 7 ? 255 : ((6 - idx) * r0 + (idx - 1) * r1) / 5 | 0;
          }
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x < width && y < height) {
            const o = outOff + (y * width + x) * 4;
            out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
          }
        }
      }
    }
  }
}

/** Decode BC5 (ATI2) — two BC4 channels stored as R (red) and G (green), blue=0. */
export function decodeBC5(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const b = (by * blocksX + bx) * 16;
      // First BC4 block = red, second = green
      const r0 = data[b], r1 = data[b + 1];
      const g0 = data[b + 8], g1 = data[b + 9];
      let rBits = 0, gBits = 0;
      for (let i = 0; i < 6; i++) { rBits |= data[b + 2 + i] << (i * 8); gBits |= data[b + 10 + i] << (i * 8); }
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const p = py * 4 + px;
          const ri = (rBits >> (p * 3)) & 7;
          const gi = (gBits >> (p * 3)) & 7;
          const rv = r0 > r1
            ? (ri === 0 ? r0 : ri === 1 ? r1 : ((8 - ri) * r0 + (ri - 1) * r1) / 7 | 0)
            : (ri === 0 ? r0 : ri === 1 ? r1 : ri === 6 ? 0 : ri === 7 ? 255 : ((6 - ri) * r0 + (ri - 1) * r1) / 5 | 0);
          const gv = g0 > g1
            ? (gi === 0 ? g0 : gi === 1 ? g1 : ((8 - gi) * g0 + (gi - 1) * g1) / 7 | 0)
            : (gi === 0 ? g0 : gi === 1 ? g1 : gi === 6 ? 0 : gi === 7 ? 255 : ((6 - gi) * g0 + (gi - 1) * g1) / 5 | 0);
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x < width && y < height) {
            const o = outOff + (y * width + x) * 4;
            out[o] = rv; out[o + 1] = gv; out[o + 2] = 0; out[o + 3] = 255;
          }
        }
      }
    }
  }
}

/**
 * BC7 mode parameter table. `partitions` is NS-1 (number of subsets minus
 * one, matching `g_aPartitionTable`'s outer index: 0 = 1 subset, 1 = 2
 * subsets, 2 = 3 subsets). `rgbaPrec` is the per-component bit width read
 * directly from the bitstream; `rgbaPrecWithP` is that width plus 1 where
 * the mode appends a P-bit to that channel (used only to pick the
 * unquantize shift — `rgbaPrec[ch] === rgbaPrecWithP[ch]` means "no P-bit
 * for this channel").
 *
 * Ported field-for-field from Microsoft's DirectXTex reference decoder
 * (`D3DX_BC7::ms_aInfo`, `DirectXTex/BC6HBC7.cpp`, MIT-licensed,
 * https://github.com/microsoft/DirectXTex) — this table (and the partition/
 * fixup/weight tables below) *is* the BC7 specification's own constant data,
 * not an implementation choice, so reproducing it here is the correct way to
 * implement a conformant decoder rather than reverse-engineering Touken
 * Ranbu's own executable (there is nothing game-specific about BC7 at all).
 */
interface BC7ModeInfo {
  partitions: number; // NS - 1
  partitionBits: number;
  pBits: number;
  rotationBits: number;
  indexModeBits: number;
  indexPrec: number;
  indexPrec2: number;
  rgbaPrec: readonly [number, number, number, number];
  rgbaPrecWithP: readonly [number, number, number, number];
}

const BC7_MODE_INFO: readonly BC7ModeInfo[] = [
  { partitions: 2, partitionBits: 4, pBits: 6, rotationBits: 0, indexModeBits: 0, indexPrec: 3, indexPrec2: 0, rgbaPrec: [4, 4, 4, 0], rgbaPrecWithP: [5, 5, 5, 0] }, // mode 0
  { partitions: 1, partitionBits: 6, pBits: 2, rotationBits: 0, indexModeBits: 0, indexPrec: 3, indexPrec2: 0, rgbaPrec: [6, 6, 6, 0], rgbaPrecWithP: [7, 7, 7, 0] }, // mode 1
  { partitions: 2, partitionBits: 6, pBits: 0, rotationBits: 0, indexModeBits: 0, indexPrec: 2, indexPrec2: 0, rgbaPrec: [5, 5, 5, 0], rgbaPrecWithP: [5, 5, 5, 0] }, // mode 2
  { partitions: 1, partitionBits: 6, pBits: 4, rotationBits: 0, indexModeBits: 0, indexPrec: 2, indexPrec2: 0, rgbaPrec: [7, 7, 7, 0], rgbaPrecWithP: [8, 8, 8, 0] }, // mode 3
  { partitions: 0, partitionBits: 0, pBits: 0, rotationBits: 2, indexModeBits: 1, indexPrec: 2, indexPrec2: 3, rgbaPrec: [5, 5, 5, 6], rgbaPrecWithP: [5, 5, 5, 6] }, // mode 4
  { partitions: 0, partitionBits: 0, pBits: 0, rotationBits: 2, indexModeBits: 0, indexPrec: 2, indexPrec2: 2, rgbaPrec: [7, 7, 7, 8], rgbaPrecWithP: [7, 7, 7, 8] }, // mode 5
  { partitions: 0, partitionBits: 0, pBits: 2, rotationBits: 0, indexModeBits: 0, indexPrec: 4, indexPrec2: 0, rgbaPrec: [7, 7, 7, 7], rgbaPrecWithP: [8, 8, 8, 8] }, // mode 6
  { partitions: 1, partitionBits: 6, pBits: 4, rotationBits: 0, indexModeBits: 0, indexPrec: 2, indexPrec2: 0, rgbaPrec: [5, 5, 5, 5], rgbaPrecWithP: [6, 6, 6, 6] }, // mode 7
];

/** `g_aPartitionTable[1]` — 2-subset partition shapes, 64 shapes x 16 texels, values 0/1. */
const BC7_PARTITION_2: readonly (readonly number[])[] = [
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1], [0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1], [0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1],
  [0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1], [0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0], [0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0], [0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
  [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0], [0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0],
  [0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0], [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
  [0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0], [0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0],
  [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1],
  [0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0], [0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0], [0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0],
  [0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1], [0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1],
  [0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0], [0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0], [0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0],
  [0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0], [0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1],
  [0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1], [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0], [0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0],
  [0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1], [0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1],
  [0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0], [0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0],
  [0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1], [0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1],
  [0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1],
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1], [0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
  [0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0], [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1],
];

/** `g_aPartitionTable[2]` — 3-subset partition shapes, 64 shapes x 16 texels, values 0/1/2. */
const BC7_PARTITION_3: readonly (readonly number[])[] = [
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 1, 2, 2, 2, 2], [0, 0, 0, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1],
  [0, 0, 0, 0, 2, 0, 0, 1, 2, 2, 1, 1, 2, 2, 1, 1], [0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2], [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 2, 2],
  [0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2], [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2],
  [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2], [0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2],
  [0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2], [0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2],
  [0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2, 1, 2, 2, 2], [0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 2, 2, 2, 0],
  [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2], [0, 1, 1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0],
  [0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2], [0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1],
  [0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2, 0, 2, 2, 2], [0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 1],
  [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2], [0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 1, 0, 2, 2, 1, 0],
  [0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0], [0, 0, 1, 2, 0, 0, 1, 2, 1, 1, 2, 2, 2, 2, 2, 2],
  [0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1, 0, 1, 1, 0], [0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1],
  [0, 0, 2, 2, 1, 1, 0, 2, 1, 1, 0, 2, 0, 0, 2, 2], [0, 1, 1, 0, 0, 1, 1, 0, 2, 0, 0, 2, 2, 2, 2, 2],
  [0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1], [0, 0, 0, 0, 2, 0, 0, 0, 2, 2, 1, 1, 2, 2, 2, 1],
  [0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 2, 2, 2], [0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 1, 1],
  [0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 2, 2, 0, 2, 2, 2], [0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0],
  [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0], [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0],
  [0, 1, 2, 0, 2, 0, 1, 2, 1, 2, 0, 1, 0, 1, 2, 0], [0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1],
  [0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1], [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2],
  [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1], [0, 0, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 1, 1, 2, 2],
  [0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 1, 1], [0, 2, 2, 0, 1, 2, 2, 1, 0, 2, 2, 0, 1, 2, 2, 1],
  [0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 0, 1], [0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
  [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2], [0, 2, 2, 2, 0, 1, 1, 1, 0, 2, 2, 2, 0, 1, 1, 1],
  [0, 0, 0, 2, 1, 1, 1, 2, 0, 0, 0, 2, 1, 1, 1, 2], [0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2],
  [0, 2, 2, 2, 0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2], [0, 0, 0, 2, 1, 1, 1, 2, 1, 1, 1, 2, 0, 0, 0, 2],
  [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2],
  [0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 2, 2, 2], [0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2],
  [0, 0, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2],
  [0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1], [0, 2, 2, 2, 1, 2, 2, 2, 0, 2, 2, 2, 1, 2, 2, 2],
  [0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], [0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 0, 1, 2, 2, 2, 0],
];

/**
 * `g_aFixUp[1]` — the anchor texel index for subset 1 of each 2-subset
 * shape (subset 0's anchor is always texel 0, so only one value per shape).
 * "Anchor" texels get one fewer index bit in the bitstream (their would-be
 * top bit is always implicitly 0 — see `bc7IsFixupOffset`).
 */
const BC7_FIXUP_2: readonly number[] = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
  15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
  6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];

/** `g_aFixUp[2]` — anchor texel indices [subset1, subset2] for each 3-subset shape. */
const BC7_FIXUP_3: readonly (readonly [number, number])[] = [
  [3, 15], [3, 8], [15, 8], [15, 3], [8, 15], [3, 15], [15, 3], [15, 8],
  [8, 15], [8, 15], [6, 15], [6, 15], [6, 15], [5, 15], [3, 15], [3, 8],
  [3, 15], [3, 8], [8, 15], [15, 3], [3, 15], [3, 8], [6, 15], [10, 8],
  [5, 3], [8, 15], [8, 6], [6, 10], [8, 15], [5, 15], [15, 10], [15, 8],
  [8, 15], [15, 3], [3, 15], [5, 10], [6, 10], [10, 8], [8, 9], [15, 10],
  [15, 6], [3, 15], [15, 8], [5, 15], [15, 3], [15, 6], [15, 6], [15, 8],
  [3, 15], [15, 3], [5, 15], [5, 15], [5, 15], [8, 15], [5, 15], [10, 15],
  [5, 15], [10, 15], [8, 15], [13, 15], [15, 3], [12, 15], [3, 15], [3, 8],
];

const BC7_WEIGHTS: Readonly<Record<number, readonly number[]>> = {
  2: [0, 21, 43, 64],
  3: [0, 9, 18, 27, 37, 46, 55, 64],
  4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],
};

/** Whether texel `offset` is an implicit-top-bit "anchor" for this mode's shape. */
function bc7IsFixupOffset(partitions: number, shape: number, offset: number): boolean {
  if (partitions === 0) return offset === 0;
  if (partitions === 1) return offset === 0 || offset === BC7_FIXUP_2[shape]!;
  const [a, b] = BC7_FIXUP_3[shape]!;
  return offset === 0 || offset === a || offset === b;
}

/** BC7's bit-replication unquantize: expand a `prec`-bit value to 8 bits by replicating its top bits into the low bits. */
function bc7Unquantize(comp: number, prec: number): number {
  if (prec <= 0) return 255;
  const shifted = (comp << (8 - prec)) & 0xff;
  return (shifted | (shifted >> prec)) & 0xff;
}

/** Weighted blend of two already-unquantized 8-bit values, matching the reference's `(c0*(64-w) + c1*w + 32) >> 6`. */
function bc7Interp(c0: number, c1: number, index: number, prec: number): number {
  const w = BC7_WEIGHTS[prec]![index]!;
  return (c0 * (64 - w) + c1 * w + 32) >> 6;
}

/**
 * Decode one 16-byte BC7 block into a 4x4 RGBA output region (16*4 bytes,
 * row-major). Sequential LSB-first bit reader + full 8-mode decode, ported
 * from Microsoft's DirectXTex `D3DX_BC7::Decode()` (MIT-licensed) — see the
 * mode-table doc comment above for why porting the spec's own reference
 * decoder (not reverse-engineering it from Touken Ranbu's executable) is the
 * right approach for a public, non-proprietary compression format.
 */
function decodeBC7Block(data: Uint8Array, blockOffset: number, outBlock: Uint8Array): void {
  let pos = 0;
  const getBit = (): number => {
    const byte = data[blockOffset + (pos >> 3)] ?? 0;
    const bit = (byte >> (pos & 7)) & 1;
    pos++;
    return bit;
  };
  const getBits = (n: number): number => {
    let ret = 0;
    for (let i = 0; i < n; i++) ret |= getBit() << i;
    return ret;
  };

  // Mode = position of the first set bit, scanning from bit 0 (unary code).
  let mode = 0;
  while (mode < 8 && getBit() === 0) mode++;
  if (mode >= 8) {
    // Reserved encoding — the spec mandates transparent black.
    outBlock.fill(0);
    return;
  }
  pos = mode + 1;

  const info = BC7_MODE_INFO[mode]!;
  const ns = info.partitions + 1;
  const numEndPts = ns * 2;

  const shape = getBits(info.partitionBits);
  const rotation = getBits(info.rotationBits);
  const indexSelect = getBits(info.indexModeBits);

  // Endpoints, read plane-by-plane (all R's, then all G's, then all B's,
  // then all A's) across every endpoint — not per-endpoint RGBA groups.
  const endpoints: number[][] = [];
  for (let i = 0; i < numEndPts; i++) endpoints.push([0, 0, 0, 0]);
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0; i < numEndPts; i++) endpoints[i]![ch] = getBits(info.rgbaPrec[ch]);
  }
  for (let i = 0; i < numEndPts; i++) endpoints[i]![3] = info.rgbaPrec[3] ? getBits(info.rgbaPrec[3]) : 255;

  // P-bits: `pBits` total for the whole block, distributed across endpoints
  // via `floor(i * pBits / numEndPts)` — this single formula reproduces both
  // "one P-bit per endpoint" (mode 0/3/6/7) and "one P-bit shared by both
  // endpoints of a subset" (mode 1) with no special-casing.
  if (info.pBits > 0) {
    const pBitValues: number[] = [];
    for (let i = 0; i < info.pBits; i++) pBitValues.push(getBit());
    for (let i = 0; i < numEndPts; i++) {
      const pi = Math.floor((i * info.pBits) / numEndPts);
      for (let ch = 0; ch < 4; ch++) {
        if (info.rgbaPrec[ch] !== info.rgbaPrecWithP[ch]) {
          endpoints[i]![ch] = (endpoints[i]![ch]! << 1) | pBitValues[pi]!;
        }
      }
    }
  }

  for (let i = 0; i < numEndPts; i++) {
    for (let ch = 0; ch < 4; ch++) endpoints[i]![ch] = bc7Unquantize(endpoints[i]![ch]!, info.rgbaPrecWithP[ch]);
  }

  // Primary (color) index array — anchor texels lose their top bit.
  const w1 = new Array<number>(16);
  for (let i = 0; i < 16; i++) {
    const bits = bc7IsFixupOffset(info.partitions, shape, i) ? info.indexPrec - 1 : info.indexPrec;
    w1[i] = getBits(bits);
  }
  // Secondary (alpha) index array, modes 4/5 only — texel 0 is always its anchor.
  const w2 = new Array<number>(16).fill(0);
  if (info.indexPrec2 > 0) {
    for (let i = 0; i < 16; i++) w2[i] = getBits(i === 0 ? info.indexPrec2 - 1 : info.indexPrec2);
  }

  for (let i = 0; i < 16; i++) {
    const region = ns === 1 ? 0 : (info.partitions === 1 ? BC7_PARTITION_2[shape]![i]! : BC7_PARTITION_3[shape]![i]!);
    const c0 = endpoints[region * 2]!;
    const c1 = endpoints[region * 2 + 1]!;

    let r: number, g: number, b: number, a: number;
    if (info.indexPrec2 === 0) {
      const idx = w1[i]!;
      r = bc7Interp(c0[0]!, c1[0]!, idx, info.indexPrec);
      g = bc7Interp(c0[1]!, c1[1]!, idx, info.indexPrec);
      b = bc7Interp(c0[2]!, c1[2]!, idx, info.indexPrec);
      a = bc7Interp(c0[3]!, c1[3]!, idx, info.indexPrec);
    } else if (indexSelect === 0) {
      const ci = w1[i]!, ai = w2[i]!;
      r = bc7Interp(c0[0]!, c1[0]!, ci, info.indexPrec);
      g = bc7Interp(c0[1]!, c1[1]!, ci, info.indexPrec);
      b = bc7Interp(c0[2]!, c1[2]!, ci, info.indexPrec);
      a = bc7Interp(c0[3]!, c1[3]!, ai, info.indexPrec2);
    } else {
      const ci = w2[i]!, ai = w1[i]!;
      r = bc7Interp(c0[0]!, c1[0]!, ci, info.indexPrec2);
      g = bc7Interp(c0[1]!, c1[1]!, ci, info.indexPrec2);
      b = bc7Interp(c0[2]!, c1[2]!, ci, info.indexPrec2);
      a = bc7Interp(c0[3]!, c1[3]!, ai, info.indexPrec);
    }

    switch (rotation) {
      case 1: [r, a] = [a, r]; break;
      case 2: [g, a] = [a, g]; break;
      case 3: [b, a] = [a, b]; break;
      default: break;
    }

    outBlock[i * 4] = r; outBlock[i * 4 + 1] = g; outBlock[i * 4 + 2] = b; outBlock[i * 4 + 3] = a;
  }
}

/**
 * Decode BC7 — full 8-mode conformant decoder (see `decodeBC7Block`).
 *
 * **History (2026-09-11):** this used to be a documented flat-color-per-block
 * approximation (read 3 arbitrary bytes per block as a flat RGB fill),
 * because "exact BC7 mode decoding is involved". On real content (a Touken
 * Ranbu Warriors character's type-`0x5f` clothing texture) that produced
 * fine-grained per-block "TV static" rather than a recognizable image — see
 * `docs/touken-ranbu-warriors.md` § "Texture pixel-format coverage" and
 * `docs/TODO.md` row `trw-bc7-decode-approximation`. BC7 is a fully public,
 * non-proprietary Khronos/Microsoft format with 8 well-documented modes, so
 * this replaces the approximation with a complete, spec-conformant decoder
 * instead of a wider partial fix.
 */
export function decodeBC7(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const block = new Uint8Array(16 * 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      decodeBC7Block(data, (by * blocksX + bx) * 16, block);
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x < width && y < height) {
            const o = outOff + (y * width + x) * 4;
            const bo = (py * 4 + px) * 4;
            out[o] = block[bo]!; out[o + 1] = block[bo + 1]!; out[o + 2] = block[bo + 2]!; out[o + 3] = block[bo + 3]!;
          }
        }
      }
    }
  }
}

/**
 * Decode BC6H (approx — unpack blocks as linear 16-bit half floats mapped to
 * luminance, since exact BC6H decoding is complex). Produces grayscale.
 */
export function decodeBC6H(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const b = (by * blocksX + bx) * 16;
      // Take the first 16-bit half float as a luminance proxy
      const half = data[b] | (data[b + 1] << 8);
      const exp = (half >> 10) & 0x1f;
      const mant = half & 0x3ff;
      let v: number;
      if (exp === 0) v = mant / 1024 * (1 / 64);
      else if (exp === 31) v = 1;
      else v = (1 + mant / 1024) * 2 ** (exp - 15);
      v = Math.min(1, Math.max(0, v));
      const g = Math.round(v * 255);
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x < width && y < height) {
            const o = outOff + (y * width + x) * 4;
            out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
          }
        }
      }
    }
  }
}
