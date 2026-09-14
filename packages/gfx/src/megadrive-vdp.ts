/**
 * Sega Genesis/Mega Drive VDP graphics primitives: 4bpp tile decode and CRAM
 * (colour RAM) palette-word decode.
 *
 * Both formats are the standard, widely-documented Genesis VDP conventions
 * (see e.g. Sega's own hardware manual and the SGDK/Genesis dev community
 * docs) — hardware primitives with no game-specific coupling. A game's own
 * nametable/tilemap container format (which tiles+palette combination
 * covers which part of the screen) is layered on top of these and stays in
 * the consuming project.
 */

/**
 * One Genesis tile: 8x8 pixels, 4 bits/pixel, 32 bytes total. Each row is 4
 * bytes; each byte packs two horizontally-adjacent pixels, high nibble
 * first (leftmost pixel = high nibble). This is the standard Genesis
 * "linear 4bpp" tile format -- *not* Amiga-style bitplane-interleaved.
 */
export const TILE_SIZE_PX = 8;
export const TILE_BYTES = 32;

/** Decode one 32-byte Genesis tile to 64 palette indices (0-15), row-major. */
export function decodeTile4bpp(data: Uint8Array, offset = 0): Uint8Array {
  const out = new Uint8Array(TILE_SIZE_PX * TILE_SIZE_PX);
  for (let row = 0; row < TILE_SIZE_PX; row++) {
    const rowBase = offset + row * 4;
    for (let b = 0; b < 4; b++) {
      const byte = data[rowBase + b];
      out[row * TILE_SIZE_PX + b * 2] = (byte >> 4) & 0xf;
      out[row * TILE_SIZE_PX + b * 2 + 1] = byte & 0xf;
    }
  }
  return out;
}

/** Decode a flat run of back-to-back 32-byte tiles (tile `t` at byte `t*32`). */
export function decodeTileBank(data: Uint8Array): { tileCount: number; indices: Uint8Array } {
  const tileCount = Math.floor(data.length / TILE_BYTES);
  const indices = new Uint8Array(tileCount * TILE_SIZE_PX * TILE_SIZE_PX);
  for (let t = 0; t < tileCount; t++) {
    indices.set(decodeTile4bpp(data, t * TILE_BYTES), t * TILE_SIZE_PX * TILE_SIZE_PX);
  }
  return { tileCount, indices };
}

/**
 * A Genesis CRAM colour word: `0000 BBB0 GGG0 RRR0` (bits 15-12 unused,
 * 3-bit B/G/R fields each followed by a padding 0 bit). Mask `0xF111`
 * against a candidate word: it must be entirely zero for the word to be a
 * structurally valid CRAM entry (bits 15-12, 8, 4, 0).
 */
export const CRAM_INVALID_MASK = 0xf111;

export function isValidCramWord(word: number): boolean {
  return (word & CRAM_INVALID_MASK) === 0;
}

/**
 * 3-bit CRAM channel -> 8-bit RGB, using the standard linear replication
 * scale (0,36,73,109,145,182,218,255 -- each step ~=36.4, i.e. `round(v *
 * 255/7)`).
 */
const CRAM_SCALE = [0, 36, 73, 109, 145, 182, 218, 255];

/** One CRAM word -> [r, g, b] 8-bit-per-channel. */
export function cramWordToRGB(word: number): [number, number, number] {
  const r = (word >> 1) & 7;
  const g = (word >> 5) & 7;
  const b = (word >> 9) & 7;
  return [CRAM_SCALE[r], CRAM_SCALE[g], CRAM_SCALE[b]];
}

/** Read `count` (default 16, one palette line) big-endian CRAM words starting at `offset` and decode to RGB. */
export function readCramPalette(rom: Uint8Array, offset: number, count = 16): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const word = (rom[offset + i * 2] << 8) | rom[offset + i * 2 + 1];
    out.push(...cramWordToRGB(word));
  }
  return out;
}

/** True if `count` consecutive big-endian words starting at `offset` are all structurally valid CRAM entries. */
export function isCramPaletteAt(rom: Uint8Array, offset: number, count = 16): boolean {
  if (offset < 0 || offset + count * 2 > rom.length) return false;
  for (let i = 0; i < count; i++) {
    const word = (rom[offset + i * 2] << 8) | rom[offset + i * 2 + 1];
    if (!isValidCramWord(word)) return false;
  }
  return true;
}
