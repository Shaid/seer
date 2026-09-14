import { describe, it, expect } from 'vitest';
import { decodeTile4bpp, decodeTileBank4bpp, bgr555ToRGB, decodeCgramPalette } from '../ppu.js';

describe('decodeTile4bpp', () => {
  it('reads bitplane0/1 interleaved per row for the first 16 bytes', () => {
    // Row 0: plane0 byte = 0b10000000, plane1 byte = 0b01000000
    // -> pixel 0 = bit1<<0 | bit0<<1 = 0b01 = 1, pixel 1 = bit1<<0 = 0b10 = 2
    const tile = new Uint8Array(32);
    tile[0] = 0b10000000; // plane0, row0
    tile[1] = 0b01000000; // plane1, row0
    const out = decodeTile4bpp(tile);
    expect(out[0]).toBe(0b01); // plane0 bit set -> value 1
    expect(out[1]).toBe(0b10); // plane1 bit set -> value 2
  });

  it('reads bitplane2/3 interleaved per row for the second 16 bytes', () => {
    const tile = new Uint8Array(32);
    tile[16] = 0b10000000; // plane2, row0
    tile[17] = 0b01000000; // plane3, row0
    const out = decodeTile4bpp(tile);
    expect(out[0]).toBe(0b0100); // plane2 bit -> value 4
    expect(out[1]).toBe(0b1000); // plane3 bit -> value 8
  });

  it('combines all 4 planes into a 0-15 index', () => {
    const tile = new Uint8Array(32);
    tile[0] = 0x80; // plane0 row0 bit7
    tile[1] = 0x80; // plane1 row0 bit7
    tile[16] = 0x80; // plane2 row0 bit7
    tile[17] = 0x80; // plane3 row0 bit7
    const out = decodeTile4bpp(tile);
    expect(out[0]).toBe(15);
  });

  it('produces 64 pixels for an 8x8 tile', () => {
    const tile = new Uint8Array(32);
    expect(decodeTile4bpp(tile).length).toBe(64);
  });
});

describe('decodeTileBank4bpp', () => {
  it('decodes a flat back-to-back run of 32-byte tiles', () => {
    const data = new Uint8Array(64); // 2 tiles
    const { tileCount, indices } = decodeTileBank4bpp(data);
    expect(tileCount).toBe(2);
    expect(indices.length).toBe(2 * 64);
  });

  it('floors partial trailing tiles', () => {
    const data = new Uint8Array(40); // 1 tile + 8 leftover bytes
    const { tileCount } = decodeTileBank4bpp(data);
    expect(tileCount).toBe(1);
  });
});

describe('bgr555ToRGB', () => {
  it('extracts R (bits 0-4), G (bits 5-9), B (bits 10-14), little-endian word', () => {
    expect(bgr555ToRGB(0x001f)).toEqual([255, 0, 0]); // red only
    expect(bgr555ToRGB(0x03e0)).toEqual([0, 255, 0]); // green only
    expect(bgr555ToRGB(0x7c00)).toEqual([0, 0, 255]); // blue only
  });

  it('decodes black and white endpoints', () => {
    expect(bgr555ToRGB(0x0000)).toEqual([0, 0, 0]);
    expect(bgr555ToRGB(0x7fff)).toEqual([255, 255, 255]);
  });

  it('matches a real cartridge\'s SNES EA-splash palette entry 10 (near-white)', () => {
    // Cross-checked against a real game's own CGRAM DMA setup during package
    // extraction (source project's docs/<game>/snes/data-structure.md).
    expect(bgr555ToRGB(0x7bde)).toEqual([247, 247, 247]);
  });
});

describe('decodeCgramPalette', () => {
  it('decodes N consecutive little-endian colour words into a flat RGB array', () => {
    const data = new Uint8Array([0x1f, 0x00, 0x00, 0x00]); // red, then black
    const rgb = decodeCgramPalette(data, 0, 2);
    expect(rgb).toEqual([255, 0, 0, 0, 0, 0]);
  });
});
