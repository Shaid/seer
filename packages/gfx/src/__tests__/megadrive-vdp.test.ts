import { describe, it, expect } from 'vitest';
import {
  decodeTile4bpp,
  decodeTileBank,
  isValidCramWord,
  cramWordToRGB,
  readCramPalette,
  isCramPaletteAt,
} from '../megadrive-vdp.js';

describe('decodeTile4bpp', () => {
  it('unpacks 2 pixels per byte, high nibble first', () => {
    // Row 0: bytes 0x12,0x34,0x56,0x78 -> pixels 1,2,3,4,5,6,7,8
    const tile = new Uint8Array(32);
    tile.set([0x12, 0x34, 0x56, 0x78], 0);
    const out = decodeTile4bpp(tile);
    expect(Array.from(out.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('reads 8 rows of 4 bytes each (32 bytes/tile)', () => {
    const tile = new Uint8Array(32);
    for (let i = 0; i < 32; i++) tile[i] = i;
    const out = decodeTile4bpp(tile);
    expect(out.length).toBe(64);
    // last row: bytes 28,29,30,31 -> nibbles of 0x1c,0x1d,0x1e,0x1f
    expect(Array.from(out.slice(56, 64))).toEqual([1, 12, 1, 13, 1, 14, 1, 15]);
  });
});

describe('decodeTileBank', () => {
  it('decodes a flat back-to-back run of tiles', () => {
    const data = new Uint8Array(64); // 2 tiles
    const { tileCount, indices } = decodeTileBank(data);
    expect(tileCount).toBe(2);
    expect(indices.length).toBe(2 * 64);
  });

  it('floors partial trailing tiles', () => {
    const data = new Uint8Array(40); // 1 tile + 8 leftover bytes
    const { tileCount } = decodeTileBank(data);
    expect(tileCount).toBe(1);
  });
});

describe('isValidCramWord', () => {
  it('accepts words with the padding bits (15-12, 8, 4, 0) all zero', () => {
    expect(isValidCramWord(0x0eee)).toBe(true); // white
    expect(isValidCramWord(0x0000)).toBe(true); // black
  });

  it('rejects words with any padding bit set', () => {
    expect(isValidCramWord(0x1eee)).toBe(false); // bit 12 set
    expect(isValidCramWord(0x0eef)).toBe(false); // bit 0 set
    expect(isValidCramWord(0x0ef8)).toBe(false); // bit 8 set
  });
});

describe('cramWordToRGB', () => {
  it('decodes the 0x0EEE / 0x0000 grey-ramp endpoints found in the ROM', () => {
    expect(cramWordToRGB(0x0eee)).toEqual([255, 255, 255]);
    expect(cramWordToRGB(0x0000)).toEqual([0, 0, 0]);
  });

  it('extracts R, G, B from bit positions 1-3, 5-7, 9-11', () => {
    // R=7 only
    expect(cramWordToRGB(0x000e)).toEqual([255, 0, 0]);
    // G=7 only
    expect(cramWordToRGB(0x00e0)).toEqual([0, 255, 0]);
    // B=7 only
    expect(cramWordToRGB(0x0e00)).toEqual([0, 0, 255]);
  });
});

describe('readCramPalette', () => {
  it('decodes count big-endian words starting at offset into a flat RGB triple array', () => {
    const rom = new Uint8Array(8);
    // word0 = 0x0e00 (B=7 only), word1 = 0x00e0 (G=7 only)
    rom[0] = 0x0e;
    rom[1] = 0x00;
    rom[2] = 0x00;
    rom[3] = 0xe0;
    const rgb = readCramPalette(rom, 0, 2);
    expect(rgb).toEqual([0, 0, 255, 0, 255, 0]);
  });
});

describe('isCramPaletteAt', () => {
  it('is false when the range runs past the end of the ROM', () => {
    const rom = new Uint8Array(4);
    expect(isCramPaletteAt(rom, 0, 16)).toBe(false);
  });

  it('is false when any word in range has a padding bit set', () => {
    const rom = new Uint8Array(4);
    rom[2] = 0x10; // bit 12 set on the second word
    expect(isCramPaletteAt(rom, 0, 2)).toBe(false);
  });

  it('is true when every word in range is a structurally valid CRAM entry', () => {
    const rom = new Uint8Array(4); // both words 0x0000, valid
    expect(isCramPaletteAt(rom, 0, 2)).toBe(true);
  });
});
