import { describe, it, expect } from 'vitest';
import {
  decodeNeoGeoPaletteWord,
  decodeNeoGeoPaletteWords,
  scanNeoGeoPaletteBanks,
} from '../neogeo/palette.js';

describe('decodeNeoGeoPaletteWord', () => {
  it('decodes black (0x0000) to (0,0,0)', () => {
    expect(decodeNeoGeoPaletteWord(0x0000)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('decodes white (0x7fff, all 15 bits) to (248,248,248)', () => {
    // 0x7fff = R=31 G=31 B=31 → 31<<3 = 248
    expect(decodeNeoGeoPaletteWord(0x7fff)).toEqual({ r: 248, g: 248, b: 248 });
  });

  it('decodes pure red (0x001f) to (248,0,0)', () => {
    expect(decodeNeoGeoPaletteWord(0x001f)).toEqual({ r: 248, g: 0, b: 0 });
  });

  it('decodes pure green (0x03e0) to (0,248,0)', () => {
    // G = 31 at bits 5-9
    expect(decodeNeoGeoPaletteWord(0x03e0)).toEqual({ r: 0, g: 248, b: 0 });
  });

  it('decodes pure blue (0x7c00) to (0,0,248)', () => {
    // B = 31 at bits 10-14
    expect(decodeNeoGeoPaletteWord(0x7c00)).toEqual({ r: 0, g: 0, b: 248 });
  });

  it('ignores bit 15 (bank/flag) on decode', () => {
    expect(decodeNeoGeoPaletteWord(0x801f)).toEqual(decodeNeoGeoPaletteWord(0x001f));
  });
});

describe('decodeNeoGeoPaletteWords', () => {
  it('decodes consecutive big-endian words with a byteOffset', () => {
    const data = new Uint8Array([
      0x00,
      0x00, // black
      0x7f,
      0xff, // white
    ]);
    const colors = decodeNeoGeoPaletteWords(data, 0, 2);
    expect(colors).toEqual([
      { r: 0, g: 0, b: 0 },
      { r: 248, g: 248, b: 248 },
    ]);
  });

  it('honors a nonzero byteOffset', () => {
    const data = new Uint8Array([0xff, 0xff, 0x00, 0x1f]);
    expect(decodeNeoGeoPaletteWords(data, 2, 1)).toEqual([{ r: 248, g: 0, b: 0 }]);
  });
});

describe('scanNeoGeoPaletteBanks', () => {
  function words(...vals: number[]): Uint8Array {
    const b: number[] = [];
    for (const v of vals) b.push((v >> 8) & 0xff, v & 0xff);
    return new Uint8Array(b);
  }

  it('is type-complete on the Rgb shape output', () => {
    // real-world check exercised in facepunch; here just confirm decode returns
    const ws = words(0x001f, 0x03e0);
    expect(decodeNeoGeoPaletteWords(ws, 0, 2).length).toBe(2);
  });

  it('finds a plausible bank inside a dense cluster', () => {
    // Build 12 banks back-to-back: 12 × 32 bytes = 384 bytes
    const block = new Uint8Array(12 * 32);
    for (let b = 0; b < 12; b++) {
      const off = b * 32;
      const words = [
        0x0000,
        0x0001,
        0x001f,
        0x0010 + b,
        0x03e0,
        0x7c00,
        0x03ff,
        0x0fff,
        0x1fff,
        0x3fff,
        0x5fff,
        0x7fff,
        0x0010,
        0x0020,
        0x0030,
        0x0040,
      ];
      for (let i = 0; i < 16; i++) {
        block[off + i * 2] = (words[i] >> 8) & 0xff;
        block[off + i * 2 + 1] = words[i] & 0xff;
      }
    }
    const hits = scanNeoGeoPaletteBanks(block, 0, block.length);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0] % 32).toBe(0);
  });

  it('does not report a bank of pure instruction bytes', () => {
    // 68000 code-ish words with bit 15 set and no color spread
    const code = words(
      0x4e75,
      0x4869,
      0x4eb9,
      0x6100,
      0x303c,
      0x7000,
      0x7100,
      0x7200,
      0x7300,
      0x7400,
      0x7500,
      0x7600,
      0x7700,
      0x7800,
      0x7900,
      0x7a00,
    );
    expect(scanNeoGeoPaletteBanks(code, 0, code.length)).toHaveLength(0);
  });
});
