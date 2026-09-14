import { describe, it, expect } from 'vitest';
import { getASTCBlockSize, decodeASTC } from '../astc.js';

describe('getASTCBlockSize', () => {
  it('resolves known ASTC format block sizes', () => {
    expect(getASTCBlockSize('ASTC_4x4_UNORM')).toEqual({ w: 4, h: 4 });
    expect(getASTCBlockSize('ASTC_8x8_SRGB')).toEqual({ w: 8, h: 8 });
  });

  it('throws for an unsupported format', () => {
    expect(() => getASTCBlockSize('ASTC_12x12_UNORM')).toThrow(/unsupported block size/);
  });
});

// These tests exercise this package's own wrapper logic (block-size lookup, band-decode
// stitching, lazy WASM loading) rather than re-verifying `@tootallnate/astc-wasm`'s own ASTC
// bitstream decoding, which is that published, independently-tested package's own concern.
// A fixed arbitrary 16-byte block is used throughout — its exact decoded color doesn't matter,
// only that decoding it is deterministic and repeatable, which is what the banding test relies on.
const ARBITRARY_BLOCK = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

describe('decodeASTC', () => {
  it('decodes a single-block surface via the fast path (whole surface, no banding)', async () => {
    const out = await decodeASTC(ARBITRARY_BLOCK, 4, 4, 'ASTC_4x4_UNORM');
    expect(out.length).toBe(4 * 4 * 4);
  });

  it('band-decodes a surface larger than the pixel budget and stitches it back together correctly', async () => {
    // Tall single-column-of-blocks surface, built by repeating one block, forces banding
    // (BAND_PIXEL_BUDGET = 1<<20 pixels). Every block being identical means the stitched
    // output must be identical block-row-to-block-row if banding preserves ordering/offsets.
    const blockW = 4, blockH = 4;
    const bigWidth = 2048;
    const bigBlocksY = 150; // blockRowsPerBand = floor(2^20 / (2048*4)) = 128, so 150 forces >=2 bands
    const data = new Uint8Array((bigWidth / blockW) * bigBlocksY * 16);
    for (let i = 0; i < data.length; i += 16) data.set(ARBITRARY_BLOCK, i);
    const height = bigBlocksY * blockH;
    const out = await decodeASTC(data, bigWidth, height, 'ASTC_4x4_UNORM');
    expect(out.length).toBe(bigWidth * height * 4);

    // Every 4x4 block decoded the same input, so every corresponding pixel position within
    // a block-row must match the first block-row's output exactly.
    const firstRowBlock = out.subarray(0, bigWidth * blockH * 4);
    for (let row = 1; row < bigBlocksY; row++) {
      const rowBlock = out.subarray(row * bigWidth * blockH * 4, (row + 1) * bigWidth * blockH * 4);
      expect(Array.from(rowBlock)).toEqual(Array.from(firstRowBlock));
    }
  });
});
