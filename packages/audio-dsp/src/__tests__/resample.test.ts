import { describe, it, expect } from 'vitest';
import { resampleLooped, GAUSSIAN_TABLE } from '../resample.ts';

describe('resampleLooped', () => {
  it('step = 1.0 with nearest is identity (no looping)', () => {
    const src = Float32Array.from([1, 2, 3, 4, 5]);
    const out = new Float32Array(5);
    const r = resampleLooped(src, 0, 1.0, 0, 0, out, 0, 5, 'nearest');
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
    expect(r.written).toBe(5);
    // exactly `count` samples were produced without the source ever running out mid-call
    expect(r.ended).toBe(false);
  });

  it('step = 0.5 with linear produces exact midpoints', () => {
    const src = Float32Array.from([0, 10, 20]);
    const out = new Float32Array(5);
    const r = resampleLooped(src, 0, 0.5, 0, 0, out, 0, 5, 'linear');
    // positions: 0, 0.5, 1, 1.5, 2 -> 0, 5, 10, 15, 20
    expect(Array.from(out)).toEqual([0, 5, 10, 15, 20]);
    expect(r.written).toBe(5);
  });

  it('one-shot playback stops and reports ended at the right sample', () => {
    const src = Float32Array.from([1, 2, 3]);
    const out = new Float32Array(10).fill(-999);
    const r = resampleLooped(src, 0, 1.0, 0, 0, out, 0, 10, 'nearest');
    expect(r.written).toBe(3);
    expect(r.ended).toBe(true);
    expect(Array.from(out.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(out[3]).toBe(-999); // untouched past the end
  });

  it('a walk across the loop boundary wraps to loopStart, not clamped to loopEnd', () => {
    // loop region [1, 4) = values [10, 20, 30], length 3.
    const src = Float32Array.from([0, 10, 20, 30, 999]);
    const out = new Float32Array(6);
    const r = resampleLooped(src, 2.5, 1.0, 1, 4, out, 0, 6, 'nearest');
    // positions: 2.5,3.5,4.5->wrap to 1.5,2.5,3.5,4.5->wrap to 1.5
    // nearest = floor(pos): 2,3,1,2,3,1 -> src[2..]=20,30,10,20,30,10
    expect(Array.from(out)).toEqual([20, 30, 10, 20, 30, 10]);
    expect(r.ended).toBe(false);
    // never reads the post-loop sentinel value 999
    expect(Array.from(out)).not.toContain(999);
  });

  it('looped playback never ends (ended stays false for a very long walk)', () => {
    const src = Float32Array.from([1, 2, 3, 4]);
    const out = new Float32Array(1000);
    const r = resampleLooped(src, 0, 1.0, 0, 4, out, 0, 1000, 'nearest');
    expect(r.written).toBe(1000);
    expect(r.ended).toBe(false);
  });

  it('gaussian4 reproduces a hand-computed value from the table for a known offset', () => {
    // frac = 0.5 -> offset = floor(0.5*256) = 128. Weights: g[127], g[383], g[384], g[128].
    const src = Float32Array.from([10, 20, 30, 40, 50]);
    const out = new Float32Array(1);
    resampleLooped(src, 1.5, 1.0, 0, 0, out, 0, 1, 'gaussian4');
    // taps at i-1=0(10), i=1(20), i+1=2(30), i+2=3(40)
    const expected =
      (GAUSSIAN_TABLE[255 - 128]! * 10 +
        GAUSSIAN_TABLE[511 - 128]! * 20 +
        GAUSSIAN_TABLE[256 + 128]! * 30 +
        GAUSSIAN_TABLE[128]! * 40) /
      2048;
    expect(out[0]).toBeCloseTo(expected, 10);
  });

  it('gaussian4 at exact integer position (frac=0) weights the center sample most heavily', () => {
    const src = Float32Array.from([0, 0, 100, 0, 0]);
    const out = new Float32Array(1);
    resampleLooped(src, 2, 1.0, 0, 0, out, 0, 1, 'gaussian4');
    // At i=2, frac=0, offset=0: weight on src[i]=src[2]=100 is g[511]/2048 (the max table entry).
    const expected = (GAUSSIAN_TABLE[511]! * 100) / 2048;
    expect(out[0]).toBeCloseTo(expected, 10); // 1305/2048*100 ≈ 63.72
  });

  it('GAUSSIAN_TABLE has exactly 512 entries in [0, 1305]', () => {
    expect(GAUSSIAN_TABLE.length).toBe(512);
    for (const v of GAUSSIAN_TABLE) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1305);
    }
  });
});
