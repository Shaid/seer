import { describe, it, expect } from 'vitest';
import { decodeHam6 } from '../ham.js';

describe('decodeHam6', () => {
  // A tiny 16-colour base palette: index 0 = black, 1 = pure red (0x0f00),
  // everything else = 0 (unused by this test).
  const palette16 = [0x0000, 0x0f00, ...new Array(14).fill(0)];

  it('mode 00 selects a colour directly from the base palette', () => {
    // Row of 2 pixels: index 0 (black), index 1 (red).
    const indices = new Uint8Array([0x00, 0x01]);
    const rgb = decodeHam6(indices, 2, 1, { palette16 });
    expect(Array.from(rgb)).toEqual([0, 0, 0, 255, 0, 0]);
  });

  it('modes 01/10/11 modify one channel and hold the other two', () => {
    // Start on red (mode 00, index 1) = (255,0,0).
    // Then mode 01 (modify Blue) with payload 0xf -> blue=255, r/g held.
    // Then mode 11 (modify Green) with payload 0x8 -> green=136, r/b held.
    const indices = new Uint8Array([0x01, 0x1f, 0x38]);
    const rgb = decodeHam6(indices, 3, 1, { palette16 });
    expect(Array.from(rgb)).toEqual([
      255, 0, 0, // mode 00 -> base palette index 1 (red)
      255, 0, 255, // mode 01 -> blue set to 0xf*17=255, r/g held from previous
      255, 136, 255, // mode 11 -> green set to 0x8*17=136, r/b held from previous
    ]);
  });

  it('resets to the base palette colour 0 at the start of every scanline', () => {
    // Row 0: select red (mode 00, idx 1). Row 1: modify Blue only, no
    // preceding direct-select — must start from base[0] = black, not
    // carry red over from row 0's last pixel.
    const indices = new Uint8Array([
      0x01, // row 0: red
      0x1f, // row 1: modify Blue -> should hold R/G from base[0]=black, not row 0's red
    ]);
    const rgb = decodeHam6(indices, 1, 2, { palette16 });
    expect(Array.from(rgb)).toEqual([
      255, 0, 0, // row 0: red
      0, 0, 255, // row 1: black + blue=255, NOT red + blue=255
    ]);
  });

  it('masks the index to 6 bits and defaults missing palette entries to black', () => {
    // 0xC1 has garbage high bits set above bit 5; only the low 6 bits (0x01) matter.
    const indices = new Uint8Array([0xc1]);
    // Only base[0] is provided; base[1] (referenced by index 1) is missing
    // and must default to black rather than throwing or reading `undefined`.
    const rgb = decodeHam6(indices, 1, 1, { palette16: [0x0000] });
    expect(Array.from(rgb)).toEqual([0, 0, 0]);
  });
});
