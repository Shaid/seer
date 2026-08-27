/**
 * SNK Neo Geo graphics decoders.
 *
 * Sprite (C ROM) decode is a direct port of MAME's
 * `neosprite_optimized_device::optimize_helper()`
 * (src/mame/snk/neogeo_spr.cpp) — the pre-decode loop MAME itself uses to
 * expand the raw interleaved C ROM region into 16x16 4bpp tiles. The input
 * is the *merged* "cslot1:sprites" region exactly as MAME's ROM_LOAD16_BYTE
 * declarations assemble it (odd-numbered chip -> even byte lanes = planes
 * 0,1; even-numbered chip -> odd byte lanes = planes 2,3; consecutive chip
 * pairs in successive banks).
 *
 * Fix layer (S ROM) decode is a port of
 * `neosprite_base_device::draw_fixed_layer()`'s fetch math
 * (`gfx_offset = code << 5 | scanline & 7`, pixel-pair bytes at
 * {0x10, 0x18, 0x00, 0x08}, low nibble first) — 8x8 4bpp tiles.
 *
 * NOTE: several late-era sets ship *encrypted* C ROMs (Garou, KOF99,
 * KOF2003, SVC Chaos among them — flagged "Encrypted GFX"/"Encrypted Set"
 * in neogeo.cpp's ROM_START comments). Decoding those without first
 * applying MAME's published per-set descramble produces noise; callers
 * must check the set's encryption status before using these decoders.
 */

/** Decode 16x16 4bpp sprite tile `tile` (128 bytes) from a merged C ROM region into one palette-index byte per pixel, row-major. */
export function decodeNeogeoSpriteTile(region: Uint8Array, tile: number): Uint8Array {
  const out = new Uint8Array(16 * 16);
  const base = tile * 0x80;

  const bit = (byteIndex: number, x: number): number => (region[base + byteIndex] >> x) & 1;

  for (let y = 0; y < 0x10; y++) {
    // Right half (columns 8-15): MAME's src[0x03|0x01|0x02|0x00 | (y << 2)] lane set.
    for (let x = 0; x < 8; x++) {
      out[y * 16 + 8 + x] =
        (bit(0x03 | (y << 2), x) << 3) |
        (bit(0x01 | (y << 2), x) << 2) |
        (bit(0x02 | (y << 2), x) << 1) |
        bit(0x00 | (y << 2), x);
    }
    // Left half (columns 0-7): MAME's src[0x43|0x41|0x42|0x40 | (y << 2)] lane set.
    for (let x = 0; x < 8; x++) {
      out[y * 16 + x] =
        (bit(0x43 | (y << 2), x) << 3) |
        (bit(0x41 | (y << 2), x) << 2) |
        (bit(0x42 | (y << 2), x) << 1) |
        bit(0x40 | (y << 2), x);
    }
  }
  return out;
}

/**
 * Decode 8x8 4bpp fix-layer tile `code` (32 bytes) from an S ROM into one
 * palette-index byte per pixel, row-major. Port of
 * `draw_fixed_layer()`'s fetch order: per scanline, pixel PAIRS come from
 * bytes gfx_offset + {0x10, 0x18, 0x00, 0x08}, each byte holding two
 * pixels (low nibble = left pixel, high nibble = right).
 */
export function decodeNeogeoFixTile(srom: Uint8Array, code: number): Uint8Array {
  const out = new Uint8Array(8 * 8);
  const base = code << 5;
  const pairOffsets = [0x10, 0x18, 0x00, 0x08];

  for (let y = 0; y < 8; y++) {
    for (let i = 0; i < 4; i++) {
      const data = srom[base + (y & 7) + pairOffsets[i]];
      out[y * 8 + i * 2] = data & 0x0f;
      out[y * 8 + i * 2 + 1] = (data & 0xf0) >> 4;
    }
  }
  return out;
}

/** Total 16x16 sprite tiles that fit in a merged C ROM region. */
export function neogeoSpriteTileCount(regionBytes: number): number {
  return Math.floor(regionBytes / 0x80);
}

/** Total fix-layer tiles that fit in an S ROM. */
export function neogeoFixTileCount(sromBytes: number): number {
  return Math.floor(sromBytes / 32);
}
