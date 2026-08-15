import { describe, it, expect } from 'vitest';
import { analyzeStride, stringGapHistogram } from '../stride.js';
import { makeRng, randomBytes } from './helpers.js';

/**
 * Synthetic record array: `count` records of `stride` bytes with realistic
 * structure — a constant magic byte, a few near-constant fields, some
 * correlated payload, some noise.
 */
function makeRecords(stride: number, count: number, seed = 42): Uint8Array {
  const rng = makeRng(seed);
  const out = new Uint8Array(stride * count);
  for (let r = 0; r < count; r++) {
    const base = r * stride;
    out[base] = 0xa5; // constant magic
    out[base + 1] = 0x00; // constant zero field
    out[base + 2] = r & 0xff; // counter (correlated across records)
    out[base + 3] = (r >> 8) & 0xff;
    for (let i = 4; i < stride; i++) {
      // Payload: per-column bias + small noise, so lag-`stride` similarity is high.
      const bias = (i * 37) & 0xff;
      out[base + i] = (bias + Math.floor(rng() * 24)) & 0xff;
    }
  }
  return out;
}

describe('analyzeStride', () => {
  const data = makeRecords(37, 512);
  const result = analyzeStride(data, 'records.bin');

  it('ranks the true 37-byte stride first', () => {
    expect(result.candidates[0]?.stride).toBe(37);
  });

  it('folds the 74 and 111 harmonics into the fundamental', () => {
    const strides = result.candidates.map((c) => c.stride);
    expect(strides).not.toContain(74);
    expect(strides).not.toContain(111);
  });

  it('reports the constant columns', () => {
    const cols = result.candidates[0].constantColumns;
    expect(cols).toContain(0);
    expect(cols).toContain(1);
    // The counter column varies, so it must NOT be constant.
    expect(cols).not.toContain(2);
  });

  it('reports score components separately so the ranking can be argued with', () => {
    const best = result.candidates[0];
    expect(best.signals.selfSimilarity).toBeGreaterThan(0);
    expect(typeof best.signals.equalityRate).toBe('number');
    expect(typeof best.signals.stringGapSupport).toBe('boolean');
  });

  it('finds little on random bytes', () => {
    const noise = analyzeStride(randomBytes(16384, 99), 'noise.bin');
    const best = noise.candidates[0];
    if (best) expect(best.score).toBeLessThan(result.candidates[0].score / 2);
  });
});

describe('stringGapHistogram', () => {
  it('reports the dominant gap between ASCII-run starts', () => {
    // 64-byte records with an 8-char name at offset 0 of each.
    const data = new Uint8Array(64 * 32);
    for (let r = 0; r < 32; r++) {
      const name = `ITEM${String(r).padStart(4, '0')}`;
      for (let i = 0; i < name.length; i++) data[r * 64 + i] = name.charCodeAt(i);
    }
    const gaps = stringGapHistogram(data);
    expect(gaps[0].gap).toBe(64);
    expect(gaps[0].count).toBe(31);
  });
});
