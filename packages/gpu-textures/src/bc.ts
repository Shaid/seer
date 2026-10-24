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
 *
 * Every codec here is written as a *per-block* function over a 64-byte
 * (16 texel x RGBA) scratch buffer, driven by the shared `forEachBlock` /
 * `scatterBlock` / `gatherBlock` trio below — so block iteration, edge
 * clipping and edge clamping exist exactly once rather than once per format.
 */

/**
 * Walk a surface's 4x4 blocks in linear (left-to-right, top-to-bottom) order,
 * calling `fn(bx, by, blockOffset)` for each. `blockOffset` is the block's
 * byte offset into the compressed data (`bytesPerBlock` is 8 for BC1/BC4,
 * 16 for everything else).
 */
function forEachBlock(width: number, height: number, bytesPerBlock: number, fn: (bx: number, by: number, blockOffset: number) => void): void {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) fn(bx, by, (by * blocksX + bx) * bytesPerBlock);
  }
}

/**
 * Write a decoded 4x4 RGBA block (64 bytes, row-major) into the output
 * surface at tile `(bx, by)`. Texels past `width`/`height` are dropped: a
 * non-multiple-of-4 surface has partial blocks whose padding content is
 * real decoded data but not part of the image.
 */
function scatterBlock(out: Uint8Array, outOff: number, width: number, height: number, bx: number, by: number, block: Uint8Array): void {
  for (let py = 0; py < 4; py++) {
    const y = by * 4 + py;
    if (y >= height) break;
    for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px;
      if (x >= width) break;
      const o = outOff + (y * width + x) * 4;
      const bo = (py * 4 + px) * 4;
      out[o] = block[bo]; out[o + 1] = block[bo + 1]; out[o + 2] = block[bo + 2]; out[o + 3] = block[bo + 3];
    }
  }
}

/**
 * Read a 4x4 RGBA block (64 bytes, row-major) out of a source surface at
 * tile `(bx, by)`. Reads past `width`/`height` clamp to the last valid
 * row/column, so an encoder's per-block work stays well-defined on a
 * non-multiple-of-4 surface; `scatterBlock` never reads that padding back,
 * so its exact value doesn't affect round-trip correctness.
 */
function gatherBlock(rgba: Uint8Array, width: number, height: number, bx: number, by: number, block: Uint8Array): void {
  for (let py = 0; py < 4; py++) {
    const sy = Math.min(by * 4 + py, height - 1);
    for (let px = 0; px < 4; px++) {
      const sx = Math.min(bx * 4 + px, width - 1);
      const so = (sy * width + sx) * 4;
      const bo = (py * 4 + px) * 4;
      block[bo] = rgba[so]; block[bo + 1] = rgba[so + 1];
      block[bo + 2] = rgba[so + 2]; block[bo + 3] = rgba[so + 3];
    }
  }
}

/**
 * Unpack the sixteen 3-bit texel indices of a BC3-alpha / BC4 / BC5 48-bit
 * index field (the 6 bytes at `data[off]`) into `out` (16 entries, row-major
 * texel order, values 0-7).
 *
 * The obvious `bits |= data[off + i] << (i * 8)` accumulation is **wrong** in
 * JS: `<<` coerces to int32 and masks its shift count to 5 bits, so `i=4` and
 * `i=5` (shifts 32 and 40) wrap to shifts 0 and 8 — the top two bytes get
 * OR'd back over the bottom two, corrupting most of the block (texels
 * 0,2,3,4,10,11,14 for an all-distinct-index block, not just the high
 * texels). That was this decoder's behavior until 2026-10-25.
 *
 * Splitting the field at its natural midpoint avoids both BigInt and any
 * shift over 31: texels 0-7 occupy bits 0-23 (= bytes 0-2) and texels 8-15
 * occupy bits 24-47 (= bytes 3-5) exactly, so no index straddles the two
 * 24-bit halves and each half is read with plain 32-bit ops.
 */
function unpackIndices3(data: Uint8Array, off: number, out: Uint8Array): void {
  const lo = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16);
  const hi = data[off + 3] | (data[off + 4] << 8) | (data[off + 5] << 16);
  for (let p = 0; p < 8; p++) {
    out[p] = (lo >>> (p * 3)) & 7;
    out[p + 8] = (hi >>> (p * 3)) & 7;
  }
}

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
 * The shared S3TC 4-entry RGBA colour palette for a `c0`/`c1` 565 endpoint
 * pair, as RGBA tuples.
 *
 * `allowPunchThrough` selects whether `c0 <= c1` means anything. BC1 encodes
 * 1-bit alpha in the endpoint ordering: with `c0 <= c1` it drops to 3 opaque
 * colours plus transparent black. BC2 and BC3 carry alpha in their own 8-byte
 * sub-block, so for them the ordering is meaningless and the 4-colour
 * interpolation is unconditional — they pass `false`.
 */
function bc1Palette(c0: number, c1: number, allowPunchThrough: boolean): [number, number, number, number][] {
  const [r0, g0, b0] = expand565(c0);
  const [r1, g1, b1] = expand565(c1);
  const fourColor = !allowPunchThrough || c0 > c1;
  return [
    [r0, g0, b0, 255],
    [r1, g1, b1, 255],
    fourColor
      ? [(2 * r0 + r1) / 3 | 0, (2 * g0 + g1) / 3 | 0, (2 * b0 + b1) / 3 | 0, 255]
      : [(r0 + r1) / 2 | 0, (g0 + g1) / 2 | 0, (b0 + b1) / 2 | 0, 255],
    fourColor
      ? [(r0 + 2 * r1) / 3 | 0, (g0 + 2 * g1) / 3 | 0, (b0 + 2 * b1) / 3 | 0, 255]
      : [0, 0, 0, 0],
  ];
}

/**
 * The BC3-alpha / BC4 / BC5 single-channel value for one 3-bit index.
 * `e0 > e1` selects the 8-interpolated-value mode; otherwise the channel has
 * 6 interpolated values plus the hard 0 and 255 that indices 6 and 7 name.
 */
function bc4Interp(e0: number, e1: number, idx: number): number {
  if (idx === 0) return e0;
  if (idx === 1) return e1;
  if (e0 > e1) return ((8 - idx) * e0 + (idx - 1) * e1) / 7 | 0;
  if (idx === 6) return 0;
  if (idx === 7) return 255;
  return ((6 - idx) * e0 + (idx - 1) * e1) / 5 | 0;
}

/**
 * Decode one 8-byte BC4-shaped sub-block (two 8-bit endpoints + the 48-bit
 * 3-bit index field) into 16 channel values. BC4 uses this for red, BC5 twice
 * (red then green), and BC3's alpha sub-block has the identical layout.
 */
function decodeChannelBlock(data: Uint8Array, off: number, out: Uint8Array): void {
  const e0 = data[off], e1 = data[off + 1];
  unpackIndices3(data, off + 2, out);
  for (let p = 0; p < 16; p++) out[p] = bc4Interp(e0, e1, out[p]);
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
  const palette = bc1Palette(c0, c1, false);
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
 * Edge blocks clamp to the last valid row/column — see `gatherBlock`.
 */
export function encodeBC1(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(width / 4) * Math.ceil(height / 4) * 8);
  const block = new Uint8Array(16 * 4);
  forEachBlock(width, height, 8, (bx, by, o) => {
    gatherBlock(rgba, width, height, bx, by, block);
    out.set(encodeBC1Block(block), o);
  });
  return out;
}

/**
 * Encode one 4x4 block's alpha channel to BC3/DXT5's 8-byte alpha block —
 * always the "8 interpolated values" mode (`a0 > a1` as u8), matching real
 * DXT5 hardware decode exactly (the *true* spec, per Microsoft's BC3
 * reference and every GPU decoder). Writes the index field via BigInt
 * (safe and clear: only 48 bits, never near `2^53`, and this is not a hot
 * loop); the decode side reads it back with `unpackIndices3`, which splits
 * the field into two 24-bit halves instead — see that function for why the
 * naive single-accumulator version was wrong for years.
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
 * color block, reusing `encodeBC1Block`'s endpoint/palette logic directly —
 * DXT5's color block is bit-identical in format to DXT1's. `encodeBC1Block`
 * forces `c0 > c1` unconditionally, which BC1 needs (to stay out of the
 * punch-through mode) and BC3 is simply indifferent to: `decodeBC23` reads
 * the colour block as 4-colour whatever the endpoint order, per spec. So the
 * two encoders can share a block encoder with no re-ordering step here.
 */
export function encodeBC3(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(width / 4) * Math.ceil(height / 4) * 16);
  const block = new Uint8Array(16 * 4);
  const alpha = new Uint8Array(16);
  forEachBlock(width, height, 16, (bx, by, o) => {
    gatherBlock(rgba, width, height, bx, by, block);
    for (let p = 0; p < 16; p++) alpha[p] = block[p * 4 + 3];
    out.set(encodeBC3AlphaBlock(alpha), o);
    out.set(encodeBC1Block(block), o + 8);
  });
  return out;
}

/**
 * Fill a 64-byte RGBA block scratch from an 8-byte S3TC colour sub-block at
 * `data[off]` — the shared body of BC1 and of BC2/BC3's colour half (which
 * sit at offset +8 of their 16-byte block). `punchThrough` is BC1-only; see
 * `bc1Palette`. Alpha is left untouched when `writeAlpha` is false, so a
 * BC2/BC3 caller can lay its own alpha down first.
 */
function decodeColorBlock(data: Uint8Array, off: number, block: Uint8Array, punchThrough: boolean, writeAlpha: boolean): void {
  const colors = bc1Palette(data[off] | (data[off + 1] << 8), data[off + 2] | (data[off + 3] << 8), punchThrough);
  const indices = data[off + 4] | (data[off + 5] << 8) | (data[off + 6] << 16) | (data[off + 7] << 24);
  for (let p = 0; p < 16; p++) {
    const [r, g, b, a] = colors[(indices >> (2 * p)) & 3]!;
    block[p * 4] = r; block[p * 4 + 1] = g; block[p * 4 + 2] = b;
    if (writeAlpha) block[p * 4 + 3] = a;
  }
}

/** Decode BC1 (DXT1) block data into RGBA. */
export function decodeBC1(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const block = new Uint8Array(16 * 4);
  forEachBlock(width, height, 8, (bx, by, b) => {
    decodeColorBlock(data, b, block, true, true);
    scatterBlock(out, outOff, width, height, bx, by, block);
  });
}

function decodeBC23(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff: number, alpha: boolean): void {
  const block = new Uint8Array(16 * 4);
  const aVal = new Uint8Array(16);
  forEachBlock(width, height, 16, (bx, by, b) => {
    if (alpha) {
      // BC3: an 8-byte BC4-shaped alpha sub-block.
      decodeChannelBlock(data, b, aVal);
    } else {
      // BC2: 16 4-bit alpha nibbles in the same 8 bytes, 2 per byte, low first.
      for (let p = 0; p < 16; p++) aVal[p] = ((data[b + (p >> 1)] >> ((p & 1) * 4)) & 0xf) * 17;
    }
    // `punchThrough: false` — per the BC2/BC3 spec the colour block is
    // *unconditionally* 4-colour. BC1's `c0 <= c1` ordering signals "3 opaque
    // colours + transparent black"; BC2/BC3 carry alpha in the sub-block
    // above, so the endpoint ordering carries no meaning at all and a
    // `c0 <= c1` block must still interpolate at 1/3 and 2/3. Until
    // 2026-10-25 this decoder passed `true` and so produced the ½-average +
    // transparent-black pair for any BC2/BC3 block whose endpoints happened
    // to be ordered that way — see the fix commit.
    decodeColorBlock(data, b + 8, block, false, false);
    for (let p = 0; p < 16; p++) block[p * 4 + 3] = aVal[p];
    scatterBlock(out, outOff, width, height, bx, by, block);
  });
}

/** Decode BC2 (DXT3) block data. */
export function decodeBC2(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  decodeBC23(data, width, height, out, outOff, false);
}

/** Decode BC3 (DXT5) block data. */
export function decodeBC3(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  decodeBC23(data, width, height, out, outOff, true);
}

/** Decode BC4 (single-channel, R) — the one channel is replicated to RGB, alpha 255. */
export function decodeBC4(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const block = new Uint8Array(16 * 4);
  const rVal = new Uint8Array(16);
  forEachBlock(width, height, 8, (bx, by, b) => {
    decodeChannelBlock(data, b, rVal);
    for (let p = 0; p < 16; p++) {
      block[p * 4] = rVal[p]; block[p * 4 + 1] = rVal[p]; block[p * 4 + 2] = rVal[p]; block[p * 4 + 3] = 255;
    }
    scatterBlock(out, outOff, width, height, bx, by, block);
  });
}

/** Decode BC5 (ATI2) — two BC4 channels stored as R (red) and G (green), blue=0. */
export function decodeBC5(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const block = new Uint8Array(16 * 4);
  const rVal = new Uint8Array(16), gVal = new Uint8Array(16);
  forEachBlock(width, height, 16, (bx, by, b) => {
    // First BC4 sub-block = red, second = green.
    decodeChannelBlock(data, b, rVal);
    decodeChannelBlock(data, b + 8, gVal);
    for (let p = 0; p < 16; p++) {
      block[p * 4] = rVal[p]; block[p * 4 + 1] = gVal[p]; block[p * 4 + 2] = 0; block[p * 4 + 3] = 255;
    }
    scatterBlock(out, outOff, width, height, bx, by, block);
  });
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
  const block = new Uint8Array(16 * 4);
  forEachBlock(width, height, 16, (bx, by, b) => {
    decodeBC7Block(data, b, block);
    scatterBlock(out, outOff, width, height, bx, by, block);
  });
}

/**
 * Decode BC6H (approx — unpack blocks as linear 16-bit half floats mapped to
 * luminance, since exact BC6H decoding is complex). Produces grayscale.
 */
export function decodeBC6H(data: Uint8Array, width: number, height: number, out: Uint8Array, outOff = 0): void {
  const block = new Uint8Array(16 * 4);
  forEachBlock(width, height, 16, (bx, by, b) => {
    // Take the first 16-bit half float as a luminance proxy for the whole block.
    const half = data[b] | (data[b + 1] << 8);
    const exp = (half >> 10) & 0x1f;
    const mant = half & 0x3ff;
    let v: number;
    if (exp === 0) v = mant / 1024 * (1 / 64);
    else if (exp === 31) v = 1;
    else v = (1 + mant / 1024) * 2 ** (exp - 15);
    v = Math.min(1, Math.max(0, v));
    const g = Math.round(v * 255);
    for (let p = 0; p < 16; p++) {
      block[p * 4] = g; block[p * 4 + 1] = g; block[p * 4 + 2] = g; block[p * 4 + 3] = 255;
    }
    scatterBlock(out, outOff, width, height, bx, by, block);
  });
}
