/**
 * SNES PPU graphics primitives: 4bpp/2bpp tile decode and CGRAM (colour RAM)
 * 15-bit BGR palette-word decode.
 *
 * These are the standard, widely-documented SNES PPU conventions. Ported
 * from the `strike` project's `tools/shared/snes-ppu.ts` (confirmed there
 * against Urban Strike SNES's EA splash-screen logo) and **independently
 * re-confirmed for this project** by decoding Wizardry 6 SNES's monster/NPC
 * face-portrait bank (36 confirmed 24x24px portraits, file offset 0x28b97
 * onward and 0x2e000 onward -- see docs/wizardry6/snes/data-structure.md
 * section 3) -- an unambiguous, recognisable render (distinct creature/NPC
 * faces: a wolf head, a cat/fox head, hooded figures, etc), not just a
 * plausible shape.
 *
 * SNES 4bpp tiles are **bitplane-interleaved per row** (distinct from both
 * Genesis's linear-nibble 4bpp and Amiga's whole-plane-sequential/row-
 * interleaved layouts): for each of the 8 rows, byte pairs (bitplane0,
 * bitplane1) come first for all 8 rows (16 bytes), then byte pairs
 * (bitplane2, bitplane3) for all 8 rows (16 bytes) -- 32 bytes total per 8x8
 * tile. 2bpp tiles are the same row-interleaved scheme with only the first
 * 16 bytes (bitplanes 0-1).
 */

export const TILE_SIZE_PX = 8;
export const TILE_BYTES_2BPP = 16;
export const TILE_BYTES_3BPP = 24;
export const TILE_BYTES_4BPP = 32;

/** Decode one 16-byte SNES 2bpp tile to 64 palette indices (0-3), row-major. */
export function decodeTile2bpp(data: Uint8Array, offset = 0): Uint8Array {
  const out = new Uint8Array(TILE_SIZE_PX * TILE_SIZE_PX);
  for (let row = 0; row < TILE_SIZE_PX; row++) {
    const b0 = data[offset + row * 2] ?? 0;
    const b1 = data[offset + row * 2 + 1] ?? 0;
    for (let col = 0; col < TILE_SIZE_PX; col++) {
      const bit = 7 - col;
      const v = ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1);
      out[row * TILE_SIZE_PX + col] = v;
    }
  }
  return out;
}

/** Decode one 32-byte SNES 4bpp tile to 64 palette indices (0-15), row-major. */
export function decodeTile4bpp(data: Uint8Array, offset = 0): Uint8Array {
  const out = new Uint8Array(TILE_SIZE_PX * TILE_SIZE_PX);
  for (let row = 0; row < TILE_SIZE_PX; row++) {
    const b0 = data[offset + row * 2] ?? 0;
    const b1 = data[offset + row * 2 + 1] ?? 0;
    const b2 = data[offset + 16 + row * 2] ?? 0;
    const b3 = data[offset + 16 + row * 2 + 1] ?? 0;
    for (let col = 0; col < TILE_SIZE_PX; col++) {
      const bit = 7 - col;
      const v =
        ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1) | (((b2 >> bit) & 1) << 2) | (((b3 >> bit) & 1) << 3);
      out[row * TILE_SIZE_PX + col] = v;
    }
  }
  return out;
}

/**
 * Decode one 24-byte SNES 3bpp tile to 64 palette indices (0-7), row-major.
 * Standard SNES 3bpp layout: bytes 0-15 are bitplanes 0-1, row-interleaved
 * exactly like a 2bpp tile; bytes 16-23 are bitplane 2, one byte per row
 * (NOT interleaved) appended after.
 */
export function decodeTile3bpp(data: Uint8Array, offset = 0): Uint8Array {
  const out = new Uint8Array(TILE_SIZE_PX * TILE_SIZE_PX);
  for (let row = 0; row < TILE_SIZE_PX; row++) {
    const b0 = data[offset + row * 2] ?? 0;
    const b1 = data[offset + row * 2 + 1] ?? 0;
    const b2 = data[offset + 16 + row] ?? 0;
    for (let col = 0; col < TILE_SIZE_PX; col++) {
      const bit = 7 - col;
      const v = ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1) | (((b2 >> bit) & 1) << 2);
      out[row * TILE_SIZE_PX + col] = v;
    }
  }
  return out;
}

/**
 * Mirror one already-decoded tile (any bpp, 64 palette-index bytes,
 * row-major) horizontally — reverse each row's column order. This is the
 * pixel-level effect of the SNES OAM sprite-attribute h-flip bit — a
 * hardware attribute, not a stored second copy of the tile data.
 */
export function mirrorTileHorizontal(tile: Uint8Array): Uint8Array {
  const out = new Uint8Array(tile.length);
  const w = TILE_SIZE_PX;
  for (let row = 0; row < w; row++) {
    for (let col = 0; col < w; col++) {
      out[row * w + col] = tile[row * w + (w - 1 - col)]!;
    }
  }
  return out;
}

/** Mirror one already-decoded tile vertically (reverse row order) — the pixel-level effect of the SNES OAM sprite-attribute v-flip bit. Sibling of `mirrorTileHorizontal`. */
export function mirrorTileVertical(tile: Uint8Array): Uint8Array {
  const out = new Uint8Array(tile.length);
  const w = TILE_SIZE_PX;
  for (let row = 0; row < w; row++) {
    for (let col = 0; col < w; col++) {
      out[row * w + col] = tile[(w - 1 - row) * w + col]!;
    }
  }
  return out;
}

/** Decode a flat run of back-to-back 32-byte 4bpp tiles (tile `t` at byte `t*32`). */
export function decodeTileBank4bpp(data: Uint8Array): { tileCount: number; indices: Uint8Array } {
  const tileCount = Math.floor(data.length / TILE_BYTES_4BPP);
  const indices = new Uint8Array(tileCount * TILE_SIZE_PX * TILE_SIZE_PX);
  for (let t = 0; t < tileCount; t++) {
    indices.set(decodeTile4bpp(data, t * TILE_BYTES_4BPP), t * TILE_SIZE_PX * TILE_SIZE_PX);
  }
  return { tileCount, indices };
}

/**
 * Compose an NxM grid of 8x8 tiles (row-major tile order) into one flat
 * palette-index bitmap. Used for Wizardry 6 SNES's 3x3-tile (24x24px)
 * portrait cells.
 */
export function composeTileGrid(data: Uint8Array, offset: number, tilesWide: number, tilesHigh: number, bpp: 2 | 4 = 4): Uint8Array {
  const tileBytes = bpp === 4 ? TILE_BYTES_4BPP : TILE_BYTES_2BPP;
  const decodeTile = bpp === 4 ? decodeTile4bpp : decodeTile2bpp;
  const w = tilesWide * TILE_SIZE_PX;
  const h = tilesHigh * TILE_SIZE_PX;
  const out = new Uint8Array(w * h);
  for (let ty = 0; ty < tilesHigh; ty++) {
    for (let tx = 0; tx < tilesWide; tx++) {
      const tileIndex = ty * tilesWide + tx;
      const tile = decodeTile(data, offset + tileIndex * tileBytes);
      for (let row = 0; row < TILE_SIZE_PX; row++) {
        for (let col = 0; col < TILE_SIZE_PX; col++) {
          out[(ty * TILE_SIZE_PX + row) * w + (tx * TILE_SIZE_PX + col)] = tile[row * TILE_SIZE_PX + col];
        }
      }
    }
  }
  return out;
}

/**
 * One CGRAM colour word (15-bit BGR, 2 bytes little-endian: bit0-4 = red,
 * bit5-9 = green, bit10-14 = blue, bit15 unused) -> 24-bit RGB, 5-bit ->
 * 8-bit channel scaling via `v * 255 / 31`.
 */
export function bgr555ToRGB(word: number): [number, number, number] {
  const r = (word & 0x1f) * 255;
  const g = ((word >> 5) & 0x1f) * 255;
  const b = ((word >> 10) & 0x1f) * 255;
  return [Math.round(r / 31), Math.round(g / 31), Math.round(b / 31)];
}

/** Decode `count` consecutive 15-bit BGR colour words starting at `offset` into a flat RGB array. */
export function decodeCgramPalette(data: Uint8Array, offset: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const word = (data[offset + i * 2] ?? 0) | ((data[offset + i * 2 + 1] ?? 0) << 8);
    out.push(...bgr555ToRGB(word));
  }
  return out;
}

/** Greyscale RGBA fallback palette for an unconfirmed CGRAM palette: index i (0-15) -> i*17 grey. */
export function greyscalePalette16(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i++) {
    const g = i * 17;
    out.push(g, g, g);
  }
  return out;
}
