import { describe, it, expect } from 'vitest';
import {
  decodeNeogeoSpriteTile,
  decodeNeogeoFixTile,
  neogeoSpriteTileCount,
  neogeoFixTileCount,
} from '../neogeo/gfx.js';

/** Encode a 16x16 4bpp pixel grid into the merged C ROM lane layout used by MAME's optimize_helper(), so decode() must reproduce the original. */
function encodeSpriteTile(pixels: Uint8Array): Uint8Array {
  const src = new Uint8Array(0x80);
  for (let y = 0; y < 16; y++) {
    for (const [halfBase, colOffset] of [
      [0x00, 8],
      [0x40, 0],
    ] as const) {
      for (let x = 0; x < 8; x++) {
        const p = pixels[y * 16 + colOffset + x];
        src[halfBase | (y << 2) | 0] |= ((p >> 0) & 1) << x;
        src[halfBase | (y << 2) | 2] |= ((p >> 1) & 1) << x;
        src[halfBase | (y << 2) | 1] |= ((p >> 2) & 1) << x;
        src[halfBase | (y << 2) | 3] |= ((p >> 3) & 1) << x;
      }
    }
  }
  return src;
}

describe('decodeNeogeoSpriteTile', () => {
  it('round-trips a synthetic 16x16 tile through MAME optimize_helper lane layout', () => {
    const expected = new Uint8Array(256);
    for (let i = 0; i < 256; i++) expected[i] = (i * 7 + 3) & 0x0f;
    const region = encodeSpriteTile(expected);
    expect(decodeNeogeoSpriteTile(region, 0)).toEqual(expected);
  });

  it('reads tile n at offset n*0x80', () => {
    const region = new Uint8Array(0x100);
    region[0x80] = 0xff; // plane bits set on right-half lane group of tile 1
    const decoded = decodeNeogeoSpriteTile(region, 1);
    // bit lanes set -> every right-half pixel gets odd planes (0+1+2+3 contributions vary); just check left half stayed zero
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) expect(decoded[y * 16 + x]).toBe(0);
    expect(decoded.reduce((s, v) => s + (v > 0 ? 1 : 0), 0)).toBeGreaterThan(0);
  });

  it('counts tiles per region size', () => {
    expect(neogeoSpriteTileCount(0x80 * 10)).toBe(10);
    expect(neogeoSpriteTileCount(0x7f)).toBe(0);
  });
});

describe('decodeNeogeoFixTile', () => {
  it('round-trips the draw_fixed_layer byte/nibble order (pairs at +0x10,+0x18,+0x00,+0x08, low nibble first)', () => {
    const srom = new Uint8Array(32);
    // row 0: bytes in fetch order hold pixel pairs (px0,px1)(px2,px3)(px4,px5)(px6,px7)
    const rowBytes: Record<number, number> = { 0x10: 0x21, 0x18: 0x43, 0x00: 0x65, 0x08: 0x87 };
    for (const [off, val] of Object.entries(rowBytes)) srom[Number(off)] = val;
    const decoded = decodeNeogeoFixTile(srom, 0);
    expect([...decoded.slice(0, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('selects tile via code << 5 and row via scanline & 7', () => {
    const srom = new Uint8Array(64);
    srom[32 + 0x10] = 0xab; // code 1, row 0
    const d1 = decodeNeogeoFixTile(srom, 1);
    expect(d1[0]).toBe(0x0b);
    expect(d1[1]).toBe(0x0a);
    const d0 = decodeNeogeoFixTile(srom, 0);
    expect(d0.every((v) => v === 0)).toBe(true);
  });

  it('counts fix tiles per S ROM size', () => {
    expect(neogeoFixTileCount(32 * 4)).toBe(4);
  });
});
