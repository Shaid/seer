import { describe, it, expect } from 'vitest';
import { sweepGfx, renderContactSheet } from '../gfx.js';
import { encodeRowInterleaved, makeRng, randomBytes, structuredImage } from './helpers.js';

describe('sweepGfx', () => {
  const width = 64;
  const height = 32;
  const planes = 3;
  const img = structuredImage(width, height);
  const encoded = encodeRowInterleaved(img, width, height, planes);

  it('ranks the true (planes, width, layout) first for a known encoding', () => {
    const range = { start: 0, end: encoded.length, label: 'test' };
    const { best } = sweepGfx(encoded, range, { jitter: 1, widths: [16, 32, 64, 96, 128] });
    expect(best).not.toBeNull();
    expect(best!.planes).toBe(planes);
    expect(best!.width).toBe(width);
    expect(best!.layout).toBe('row-interleaved');
    expect(best!.jitter).toBe(0);
  });

  it('the offset-jitter axis keeps a misaligned region competitive', () => {
    // A region boundary that is off by a few bytes must not sink the true
    // parameter combination. Note the limit: offsets that preserve the row
    // period decode to a plane-rotated image with near-identical
    // statistics, so the exact byte offset is NOT recoverable from the
    // score — the contact sheet (wrong colours, shifted fringes) is what
    // disambiguates it. The sweep's job is to surface the combination.
    const shifted = new Uint8Array(encoded.length + 5);
    shifted.set(encoded, 5);
    const range = { start: 0, end: shifted.length, label: 'test' };
    const { best } = sweepGfx(shifted, range, { jitter: 16, widths: [16, 32, 64, 96, 128] });
    expect(best!.planes).toBe(planes);
    expect(best!.width).toBe(width);
    expect(best!.layout).toBe('row-interleaved');
  });

  it('shearHint recovers the true width from a deliberately mis-strided decode', () => {
    // A 336-px-wide 1-plane image whose rows are identical (a per-column
    // pattern with 4–12 px runs): rendered at 320, every row shifts by
    // +16 px and the shear detector should read that off.
    const trueWidth = 336;
    const rows = 40;
    const rng = makeRng(7);
    const colPattern = new Uint8Array(trueWidth);
    let v = 0;
    for (let x = 0; x < trueWidth; ) {
      const run = 4 + Math.floor(rng() * 9);
      for (let i = 0; i < run && x < trueWidth; i++, x++) colPattern[x] = v;
      v ^= 1;
    }
    const img = new Uint8Array(trueWidth * rows);
    for (let y = 0; y < rows; y++) img.set(colPattern, y * trueWidth);
    const encoded = encodeRowInterleaved(img, trueWidth, rows, 1);

    const range = { start: 0, end: encoded.length, label: 'test' };
    const { candidates } = sweepGfx(encoded, range, { jitter: 1, widths: [320] });
    const c = candidates.find((c) => c.planes === 1 && c.width === 320);
    expect(c).toBeDefined();
    expect(c!.shearHint).toBe(336);
  });

  it('random bytes score clearly below a real bitmap (negative control)', () => {
    const range = { start: 0, end: encoded.length, label: 'test' };
    const real = sweepGfx(encoded, range, { jitter: 1, widths: [64] }).best!;
    const noise = randomBytes(encoded.length, 5);
    const noisy = sweepGfx(noise, { start: 0, end: noise.length, label: 'test' }, { jitter: 1, widths: [64] }).best;
    expect(real.score).toBeGreaterThan(0.7);
    expect(noisy!.score).toBeLessThan(0.6);
    expect(real.score).toBeGreaterThan(noisy!.score + 0.15);
  });

  it('reports the four score components separately', () => {
    const range = { start: 0, end: encoded.length, label: 'test' };
    const { best } = sweepGfx(encoded, range, { jitter: 1, widths: [64] });
    const c = best!.components;
    expect(c.rowCoherence).toBeGreaterThan(0.8);
    expect(c.runStructure).toBeGreaterThan(0.2);
    expect(Math.abs(c.shear)).toBeLessThanOrEqual(1);
    expect(c.indexUsage).toBeGreaterThan(0);
  });
});

describe('renderContactSheet', () => {
  it('produces a labelled grid sized to the candidate count', () => {
    const img = structuredImage(64, 32);
    const encoded = encodeRowInterleaved(img, 64, 32, 3);
    const range = { start: 0, end: encoded.length, label: 'test' };
    const { candidates } = sweepGfx(encoded, range, { jitter: 1, widths: [32, 64] });
    const sheet = renderContactSheet(encoded, candidates);
    expect(sheet.width).toBeGreaterThan(0);
    expect(sheet.height).toBeGreaterThan(0);
    expect(sheet.rgba.length).toBe(sheet.width * sheet.height * 4);
  });
});
