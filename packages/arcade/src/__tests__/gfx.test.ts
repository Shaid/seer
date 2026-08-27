import { describe, it, expect } from 'vitest';
import {
  CPS1_LAYOUT_16X16,
  CPS1_LAYOUT_8X8,
  CPS1_LAYOUT_8X8_2,
  CPS1_LAYOUT_32X32,
  scroll1GfxSetForColumn,
  cps2ScrollBankMap,
  cps2SpriteCode,
  decodeTile,
  tileCount,
  cps2UnshuffleGfx,
} from '../capcom/gfx.js';
import { interleaveWords, allocRegion } from '../capcom/rom-regions.js';

describe('CPS1_LAYOUT_16X16', () => {
  it("matches MAME's cps1_layout16x16 (src/mame/capcom/cps1.cpp) field-for-field", () => {
    expect(CPS1_LAYOUT_16X16.width).toBe(16);
    expect(CPS1_LAYOUT_16X16.height).toBe(16);
    expect(CPS1_LAYOUT_16X16.planes).toBe(4);
    expect(CPS1_LAYOUT_16X16.planeOffset).toEqual([24, 16, 8, 0]);
    expect(CPS1_LAYOUT_16X16.xOffset).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 32, 33, 34, 35, 36, 37, 38, 39,
    ]);
    expect(CPS1_LAYOUT_16X16.yOffset).toEqual(Array.from({ length: 16 }, (_, i) => i * 64));
    expect(CPS1_LAYOUT_16X16.charIncrement).toBe(1024);
  });
});

describe('CPS1_LAYOUT_8X8 / CPS1_LAYOUT_8X8_2', () => {
  it("matches MAME's cps1_layout8x8/cps1_layout8x8_2 (src/mame/capcom/cps1.cpp) field-for-field", () => {
    for (const layout of [CPS1_LAYOUT_8X8, CPS1_LAYOUT_8X8_2]) {
      expect(layout.width).toBe(8);
      expect(layout.height).toBe(8);
      expect(layout.planes).toBe(4);
      expect(layout.planeOffset).toEqual([24, 16, 8, 0]);
      expect(layout.yOffset).toEqual(Array.from({ length: 8 }, (_, i) => i * 64));
      expect(layout.charIncrement).toBe(512); // 64*8, HALF of CPS1_LAYOUT_16X16's 1024
    }
    expect(CPS1_LAYOUT_8X8.xOffset).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(CPS1_LAYOUT_8X8_2.xOffset).toEqual([32, 33, 34, 35, 36, 37, 38, 39]);
  });

  it('each 16x16-code c is exactly the union of 8x8-codes 2c (top half) and 2c+1 (bottom half), each split left/right by the two layouts', () => {
    // A quick structural cross-check rather than trusting the two ported
    // constants independently: decoding CPS1_LAYOUT_16X16's code c must
    // equal stitching together the 4 quadrants decoded via the 8x8 layouts
    // at codes 2c/2c+1.
    const region = new Uint8Array(4096);
    for (let i = 0; i < region.length; i++) region[i] = (i * 37 + 11) & 0xff; // arbitrary but deterministic bytes
    const code = 3;
    const big = decodeTile(region, CPS1_LAYOUT_16X16, code); // 16x16, row-major
    const topLeft = decodeTile(region, CPS1_LAYOUT_8X8, 2 * code);
    const topRight = decodeTile(region, CPS1_LAYOUT_8X8_2, 2 * code);
    const botLeft = decodeTile(region, CPS1_LAYOUT_8X8, 2 * code + 1);
    const botRight = decodeTile(region, CPS1_LAYOUT_8X8_2, 2 * code + 1);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const expected = big[y * 16 + x];
        const quadrant = y < 8 ? (x < 8 ? topLeft : topRight) : x < 8 ? botLeft : botRight;
        const qx = x % 8;
        const qy = y % 8;
        expect(quadrant[qy * 8 + qx]).toBe(expected);
      }
    }
  });
});

describe('scroll1GfxSetForColumn', () => {
  it('selects CPS1_LAYOUT_8X8 for even columns and CPS1_LAYOUT_8X8_2 for odd columns', () => {
    expect(scroll1GfxSetForColumn(0)).toBe(CPS1_LAYOUT_8X8);
    expect(scroll1GfxSetForColumn(1)).toBe(CPS1_LAYOUT_8X8_2);
    expect(scroll1GfxSetForColumn(2)).toBe(CPS1_LAYOUT_8X8);
    expect(scroll1GfxSetForColumn(63)).toBe(CPS1_LAYOUT_8X8_2);
  });
});

describe('CPS1_LAYOUT_32X32', () => {
  it("matches MAME's cps1_layout32x32 (src/mame/capcom/cps1.cpp) field-for-field", () => {
    expect(CPS1_LAYOUT_32X32.width).toBe(32);
    expect(CPS1_LAYOUT_32X32.height).toBe(32);
    expect(CPS1_LAYOUT_32X32.planes).toBe(4);
    expect(CPS1_LAYOUT_32X32.planeOffset).toEqual([24, 16, 8, 0]);
    expect(CPS1_LAYOUT_32X32.xOffset).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 32, 33, 34, 35, 36, 37, 38, 39, 64, 65, 66, 67, 68, 69, 70, 71, 96,
      97, 98, 99, 100, 101, 102, 103,
    ]);
    expect(CPS1_LAYOUT_32X32.yOffset).toEqual(Array.from({ length: 32 }, (_, i) => i * 128));
    expect(CPS1_LAYOUT_32X32.charIncrement).toBe(4096); // 4x CPS1_LAYOUT_16X16's 1024
  });
});

describe('cps2ScrollBankMap', () => {
  // MAME's mapper_cps2_table: one gfx_range {SCROLL1|SCROLL2|SCROLL3, 0,
  // 0x1ffff, bank 1}, bank_sizes {0x20000, 0x20000, 0, 0} -- see the
  // function's own doc comment for the full derivation.
  it('offsets scroll1 (8x8) codes by a fixed 0x20000', () => {
    expect(cps2ScrollBankMap(0, 'scroll1')).toBe(0x20000);
    expect(cps2ScrollBankMap(0x41, 'scroll1')).toBe(0x20041); // 'A' -> font glyph
  });

  it('offsets scroll2 (16x16) codes by a fixed 0x10000', () => {
    expect(cps2ScrollBankMap(0, 'scroll2')).toBe(0x10000);
  });

  it('offsets scroll3 (32x32) codes by a fixed 0x4000', () => {
    expect(cps2ScrollBankMap(0, 'scroll3')).toBe(0x4000);
  });

  it('all three layer types land on the identical physical byte offset for code 0 (0x800000)', () => {
    expect(cps2ScrollBankMap(0, 'scroll1') * 64).toBe(0x800000);
    expect(cps2ScrollBankMap(0, 'scroll2') * 128).toBe(0x800000);
    expect(cps2ScrollBankMap(0, 'scroll3') * 512).toBe(0x800000);
  });
});

describe('cps2SpriteCode', () => {
  it("passes a plain code through unchanged when the Y word's bits 13-14 are clear", () => {
    expect(cps2SpriteCode(0x1234, 0x0056)).toBe(0x1234);
  });

  it('folds Y-word bits 13-14 into the high bits of the tile code (cps2_render_sprites)', () => {
    expect(cps2SpriteCode(0x0000, 0x2000)).toBe(0x10000); // bit 13 -> code bit 16
    expect(cps2SpriteCode(0x0000, 0x4000)).toBe(0x20000); // bit 14 -> code bit 17
    expect(cps2SpriteCode(0x0000, 0x6000)).toBe(0x30000); // both set
    expect(cps2SpriteCode(0x0100, 0x6000)).toBe(0x30100);
  });

  it('can address the full 196,608-tile atlas (max observed code 0x2ffff)', () => {
    expect(cps2SpriteCode(0xffff, 0x6000)).toBe(0x3ffff); // upper bound of the addressable space
  });
});

describe('tileCount', () => {
  it('divides region size by the 128-byte-per-tile charIncrement', () => {
    expect(tileCount(0x1800000, CPS1_LAYOUT_16X16)).toBe(196608);
  });
});

describe('decodeTile', () => {
  it('decodes an all-zero region to an all-zero tile', () => {
    const region = new Uint8Array(256);
    const pixels = decodeTile(region, CPS1_LAYOUT_16X16, 0);
    expect(pixels.length).toBe(256);
    expect(pixels.every((p) => p === 0)).toBe(true);
  });

  it('decodes a single set bit into the expected pixel/plane', () => {
    // Plane 0 (planeOffset=24) contributes bit value 8 (1<<3). Its bit for
    // x=0,y=0 lives at bit offset 24 (planeOffset[0] + xOffset[0] + yOffset[0]).
    const region = new Uint8Array(256);
    // bit 24 is byte 3 (24/8), MSB (bit 24 % 8 == 0 -> mask 0x80).
    region[3] = 0x80;
    const pixels = decodeTile(region, CPS1_LAYOUT_16X16, 0);
    expect(pixels[0]).toBe(8); // x=0,y=0 -> plane 0 bit set
    expect(Array.from(pixels).filter((p) => p !== 0)).toEqual([8]);
  });
});

describe('cps2UnshuffleGfx', () => {
  it('rejects a region size that is not a multiple of the bank size', () => {
    expect(() => cps2UnshuffleGfx(new Uint8Array(100), 0x200000)).toThrow();
  });

  it('is its own exact inverse (applying it twice restores the original bytes)', () => {
    // cps2_state::unshuffle() is a fixed, self-inverse permutation of 8-byte
    // units (it only ever swaps whole units, never touches bytes within
    // one) -- applying it twice must reproduce the identity. This is a
    // structural regression check independent of knowing which permutation
    // is "correct"; the actual correctness evidence (recognizable sprite
    // art after exactly one application) is recorded in
    // docs/ddsom/cps2/data-structure.md, not re-derivable from a unit test
    // without vendoring the real gfx ROMs.
    const bankSize = 32; // small synthetic bank, still a multiple of 4 units of 8 bytes
    const original = new Uint8Array(bankSize);
    for (let i = 0; i < bankSize; i++) original[i] = i;

    const buf = original.slice();
    cps2UnshuffleGfx(buf, bankSize);
    expect(buf).not.toEqual(original); // it actually permutes something
    cps2UnshuffleGfx(buf, bankSize);
    expect(buf).toEqual(original);
  });

  it('word-interleaves 4 chip sources into 64-bit groups (ROM_LOAD64_WORD)', () => {
    const dest = allocRegion(16); // 2 groups of 8 bytes
    const a = Uint8Array.from([0x11, 0x11, 0x55, 0x55]); // 2 words
    const b = Uint8Array.from([0x22, 0x22, 0x66, 0x66]);
    const c = Uint8Array.from([0x33, 0x33, 0x77, 0x77]);
    const d = Uint8Array.from([0x44, 0x44, 0x88, 0x88]);
    interleaveWords(dest, 0, a, 0, 8);
    interleaveWords(dest, 0, b, 2, 8);
    interleaveWords(dest, 0, c, 4, 8);
    interleaveWords(dest, 0, d, 6, 8);
    expect(Array.from(dest)).toEqual([
      0x11, 0x11, 0x22, 0x22, 0x33, 0x33, 0x44, 0x44, 0x55, 0x55, 0x66, 0x66, 0x77, 0x77, 0x88,
      0x88,
    ]);
  });
});
