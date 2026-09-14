/**
 * Chunky (packed, non-planar) pixel decode helpers for DOS CGA/Tandy
 * 16-color graphics.
 *
 * Unlike the Amiga/Atari-ST bitplane convention (`planar.ts`), these
 * formats pack N bits per pixel directly into consecutive bytes, pixels
 * MSB-first within each byte (e.g. at bpp=2: 4 pixels/byte, leftmost pixel
 * = bits 7-6). Originally written for Wizardry 6's DOS `.CGA` (2bpp) and
 * `.T16` (4bpp Tandy 16-color) asset variants — full-screen images, the
 * `mazedata` art bank, and the `WFONT`/`WPORT` tile sheets all share it —
 * but the format itself is a generic DOS/EGA-era chunky pixel packing, not
 * game-specific.
 *
 * Like `decodePlanar`, these never throw on short input — bytes past the
 * end of `data` read as 0.
 */

/**
 * Decode a linear (non-interleaved), packed-pixel chunky image: row-major,
 * `ceil(width / (8/bpp))` bytes per row, pixels packed MSB-first within
 * each byte. Returns one palette-index byte per pixel (`width * height`
 * bytes), the same flat convention `decodePlanar` uses.
 */
export function decodePackedPixelLinear(
  data: Uint8Array,
  offset: number,
  width: number,
  height: number,
  bpp: number,
): Uint8Array {
  const pixelsPerByte = 8 / bpp;
  const rowBytes = Math.ceil(width / pixelsPerByte);
  const mask = (1 << bpp) - 1;
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = offset + y * rowBytes;
    for (let x = 0; x < width; x++) {
      const byteIndex = rowOffset + Math.floor(x / pixelsPerByte);
      const byte = data[byteIndex] ?? 0;
      const pixelInByte = x % pixelsPerByte;
      const shift = (pixelsPerByte - 1 - pixelInByte) * bpp;
      indices[y * width + x] = (byte >> shift) & mask;
    }
  }
  return indices;
}

/**
 * Decode a real-mode CGA hardware-video-memory-layout image: two
 * interleaved "banks" (even scanlines 0,2,4,... then odd scanlines
 * 1,3,5,...), each bank a fixed `bankGap` bytes wide in the source data
 * regardless of how much of it holds real pixel data — the classic IBM
 * CGA video memory convention (even field at segment offset 0, odd field
 * at +0x2000).
 */
export function decodeCgaBanked(
  data: Uint8Array,
  offset: number,
  width: number,
  height: number,
  bpp = 2,
  bankGap = 0x2000,
): Uint8Array {
  const pixelsPerByte = 8 / bpp;
  const rowBytes = Math.ceil(width / pixelsPerByte);
  const mask = (1 << bpp) - 1;
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const bank = y % 2;
    const rowInBank = Math.floor(y / 2);
    const rowOffset = offset + bank * bankGap + rowInBank * rowBytes;
    for (let x = 0; x < width; x++) {
      const byteIndex = rowOffset + Math.floor(x / pixelsPerByte);
      const byte = data[byteIndex] ?? 0;
      const pixelInByte = x % pixelsPerByte;
      const shift = (pixelsPerByte - 1 - pixelInByte) * bpp;
      indices[y * width + x] = (byte >> shift) & mask;
    }
  }
  return indices;
}

/** A palette entry as separate 8-bit channels, the convention DOS/EGA palette tables use. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Convert an 8-bit chunky index buffer to RGBA, with a caller-chosen
 * transparent index (the DOS/EGA `.PIC`-family tile convention uses "max
 * index" — all bits set — as the transparent key at every bit depth: 15 at
 * 4bpp, 3 at 2bpp).
 *
 * Takes a `{r,g,b}[]`-shaped palette rather than `indicesToRGBA`'s flat
 * `number[]` triples — the natural shape for DOS/EGA palette tables, which
 * are typically declared as an array of named colour records. Both
 * palette conventions are kept side by side rather than forced into one
 * shape.
 */
export function indicesToRGBAWithTransparency(
  indices: Uint8Array,
  palette: RGB[],
  transparentIndex: number,
): Uint8Array {
  const rgba = new Uint8Array(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const c = palette[idx] ?? { r: 0, g: 0, b: 0 };
    rgba[i * 4] = c.r;
    rgba[i * 4 + 1] = c.g;
    rgba[i * 4 + 2] = c.b;
    rgba[i * 4 + 3] = idx === transparentIndex ? 0 : 255;
  }
  return rgba;
}
