import { describe, it, expect } from 'vitest';
import { swizzle, deswizzle, getImageData, computeBlockHeightLog2, swizzledSurfaceSize, SWIZZLE_FORMATS } from '../swizzle.js';

describe('computeBlockHeightLog2', () => {
  it('matches the confirmed real-corpus value for a 128x128 BC1 icon (blockCountHeight=32)', () => {
    expect(computeBlockHeightLog2(32)).toBe(2);
  });

  it('caps at log2=4 (16 GOBs) for a very tall surface', () => {
    expect(computeBlockHeightLog2(100000)).toBe(4);
  });

  it('is 0 for a single-GOB-row surface', () => {
    expect(computeBlockHeightLog2(1)).toBe(0);
  });
});

describe('swizzle / deswizzle round trip', () => {
  it('round-trips linear data through toSwizzle then back to the same bytes (tileMode=0, block-linear)', () => {
    const width = 32, height = 32, blkWidth = 4, blkHeight = 4, bpp = 8; // BC1-shaped
    const blockHeightLog2 = 1;
    const w = Math.ceil(width / blkWidth), h = Math.ceil(height / blkHeight);
    const linear = new Uint8Array(w * h * bpp);
    for (let i = 0; i < linear.length; i++) linear[i] = i % 256;

    const swizzled = swizzle(width, height, blkWidth, blkHeight, bpp, 0, blockHeightLog2, linear, true);
    const roundTripped = deswizzle(width, height, 1, blkWidth, blkHeight, 1, bpp, 0, blockHeightLog2, swizzled);
    expect(Array.from(roundTripped)).toEqual(Array.from(linear));
  });

  it('round-trips linear data through toSwizzle then back to the same bytes (tileMode=1, linear/pitch layout)', () => {
    const width = 16, height = 16, blkWidth = 4, blkHeight = 4, bpp = 16; // BC2/3-shaped
    const w = Math.ceil(width / blkWidth), h = Math.ceil(height / blkHeight);
    const linear = new Uint8Array(w * h * bpp);
    for (let i = 0; i < linear.length; i++) linear[i] = (i * 7) % 256;

    const swizzled = swizzle(width, height, blkWidth, blkHeight, bpp, 1, 0, linear, true);
    const roundTripped = swizzle(width, height, blkWidth, blkHeight, bpp, 1, 0, swizzled, false);
    expect(Array.from(roundTripped)).toEqual(Array.from(linear));
  });
});

describe('swizzledSurfaceSize', () => {
  it('matches the documented real-corpus 1080x1920 BC1 padding gap', () => {
    // Tight block size: ceil(1080/4)*ceil(1920/4)*8 = 270*480*8 = 1,036,800.
    const tight = Math.ceil(1080 / 4) * Math.ceil(1920 / 4) * 8;
    expect(tight).toBe(1_036_800);
    const padded = swizzledSurfaceSize(1080, 1920, 4, 4, 8, computeBlockHeightLog2(Math.ceil(1920 / 4)));
    expect(padded).toBe(1_114_112);
    expect(padded - tight).toBe(77_312);
  });

  it('equals the tight size for a surface whose dimensions are already GOB-aligned', () => {
    // 256x32 BC1: w=64 blocks, pitch = roundUp(64*8, 64) = 512 (already aligned);
    // h=8 blocks, roundUp(8, blockHeight(1)*8) = 8 -> 512*8 = 4096, same as the tight size.
    const size = swizzledSurfaceSize(256, 32, 4, 4, 8, 0);
    expect(size).toBe(4096);
  });
});

describe('getImageData', () => {
  it('throws for an unknown format', () => {
    expect(() => getImageData('NOT_A_FORMAT', 32, 32, 1, 1, 0, new Uint8Array(0))).toThrow(/Unknown swizzle format/);
  });

  it('deswizzles mip 0 of a known format losslessly through a round trip', () => {
    const format = 'BC1_UNORM';
    const info = SWIZZLE_FORMATS[format]!;
    const width = 32, height = 32;
    const w = Math.ceil(width / info.blockWidth), h = Math.ceil(height / info.blockHeight);
    const linear = new Uint8Array(w * h * info.bpp);
    for (let i = 0; i < linear.length; i++) linear[i] = (i * 3) % 256;
    const blockHeightLog2 = 1;
    const swizzled = swizzle(width, height, info.blockWidth, info.blockHeight, info.bpp, 0, blockHeightLog2, linear, true);
    const result = getImageData(format, width, height, 1, 1, blockHeightLog2, swizzled, 0);
    expect(Array.from(result)).toEqual(Array.from(linear));
  });
});
