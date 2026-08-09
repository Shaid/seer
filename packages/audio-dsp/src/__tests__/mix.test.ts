import { describe, it, expect } from 'vitest';
import { mixVoiceStereo, applyMasterGain } from '../mix.ts';

describe('mixVoiceStereo', () => {
  it('accumulates additively rather than overwriting', () => {
    const outL = Float32Array.from([1, 1, 1]);
    const outR = Float32Array.from([0, 0, 0]);
    const mono = Float32Array.from([1, 2, 3]);
    mixVoiceStereo(outL, outR, mono, 1, 0, 0, 3);
    expect(Array.from(outL)).toEqual([2, 3, 4]);
    expect(Array.from(outR)).toEqual([0, 0, 0]);
  });

  it('applies independent left/right gains (hard-pan reproduction: gainL=1,gainR=0 or vice versa)', () => {
    const outL = new Float32Array(2);
    const outR = new Float32Array(2);
    const mono = Float32Array.from([5, 6]);
    mixVoiceStereo(outL, outR, mono, 1, 0, 0, 2);
    mixVoiceStereo(outR, outL, mono, 1, 0, 0, 2); // reuse to hit the other side, swapped args
    expect(Array.from(outL)).toEqual([5, 6]);
    expect(Array.from(outR)).toEqual([5, 6]);
  });

  it('a zero gain leaves that channel untouched (skips the write loop entirely)', () => {
    const outL = Float32Array.from([9, 9]);
    const mono = Float32Array.from([1, 1]);
    mixVoiceStereo(outL, new Float32Array(2), mono, 0, 0, 0, 2);
    expect(Array.from(outL)).toEqual([9, 9]);
  });

  it('respects outOffset/monoOffset/count windowing', () => {
    const outL = new Float32Array(5);
    const mono = Float32Array.from([10, 20, 30, 40]);
    mixVoiceStereo(outL, new Float32Array(5), mono, 1, 0, 2, 2, 1);
    // writes mono[1..2] = [20,30] into outL[2..3]
    expect(Array.from(outL)).toEqual([0, 0, 20, 30, 0]);
  });

  it('a fractional gain scales correctly (soft-pan case)', () => {
    const outL = new Float32Array(1);
    const outR = new Float32Array(1);
    mixVoiceStereo(outL, outR, Float32Array.from([10]), 0.25, 0.75, 0, 1);
    expect(outL[0]).toBeCloseTo(2.5, 10);
    expect(outR[0]).toBeCloseTo(7.5, 10);
  });
});

describe('applyMasterGain', () => {
  it('scales both channels by gain', () => {
    const outL = Float32Array.from([0.5, -0.5]);
    const outR = Float32Array.from([0.2, -0.2]);
    applyMasterGain(outL, outR, 0.5);
    expect(outL[0]).toBeCloseTo(0.25, 6);
    expect(outL[1]).toBeCloseTo(-0.25, 6);
    // Float32 precision: 0.2 isn't exactly representable, so 0.2(f32)*0.5 != 0.1(f64) bit-for-bit.
    expect(outR[0]).toBeCloseTo(0.1, 6);
    expect(outR[1]).toBeCloseTo(-0.1, 6);
  });

  it('hard-clamps to [-1, 1]', () => {
    const outL = Float32Array.from([10, -10]);
    const outR = Float32Array.from([2, -2]);
    applyMasterGain(outL, outR, 1);
    expect(Array.from(outL)).toEqual([1, -1]);
    expect(Array.from(outR)).toEqual([1, -1]);
  });
});
