import { describe, it, expect } from 'vitest';
import { Ym2203Fm } from '../yamaha/ym2203-fm.js';

const FS = 3579545 / 72;

/** algorithm 7, only operator slot 0 audible, A440 at block 4 fnum 1160 */
function singleOp(ar = 31, d1r = 0, d2r = 0, slrr = 0x0f): Ym2203Fm {
  const c = new Ym2203Fm();
  c.write(0xb0, 7);
  for (const o of [0x00, 0x04, 0x08, 0x0c]) {
    c.write(0x30 + o, 0x01);
    c.write(0x40 + o, o === 0 ? 0 : 127);
    c.write(0x50 + o, ar);
    c.write(0x60 + o, d1r);
    c.write(0x70 + o, d2r);
    c.write(0x80 + o, slrr);
  }
  c.write(0xa4, (4 << 3) | (1160 >> 8));
  c.write(0xa0, 1160 & 255);
  return c;
}

function goertzel(x: number[], f: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i++) {
    const a = (2 * Math.PI * f * i) / FS;
    re += x[i] * Math.cos(a);
    im += x[i] * Math.sin(a);
  }
  return (Math.hypot(re, im) / x.length) * 2;
}

describe('Ym2203Fm (software OPN model)', () => {
  it('fs = clock/72 and a block-4 fnum 1160 operator sounds at 440.0 Hz with full amplitude', () => {
    const c = singleOp();
    expect(c.sampleRate).toBeCloseTo(49715.9, 1);
    c.write(0x28, 0xf0);
    const x: number[] = [];
    for (let i = 0; i < 49716; i++) x.push(c.sample());
    expect(Math.max(...x.map(Math.abs))).toBe(8168);
    const at440 = goertzel(x, 440);
    expect(at440).toBeGreaterThan(8000);
    // null control: neighbouring non-harmonic bins carry ~nothing
    for (const f of [220, 430, 450, 880]) expect(goertzel(x, f)).toBeLessThan(10);
  });

  it('silent until key-on; key-off releases monotonically to silence', () => {
    const c = singleOp(31, 0, 0, 0x0a);
    let pk = 0;
    for (let i = 0; i < 2000; i++) pk = Math.max(pk, Math.abs(c.sample()));
    expect(pk).toBe(0);
    c.write(0x28, 0xf0);
    for (let i = 0; i < 2000; i++) c.sample();
    c.write(0x28, 0x00);
    const peaks: number[] = [];
    for (let w = 0; w < 20; w++) {
      let m = 0;
      for (let i = 0; i < 2486; i++) m = Math.max(m, Math.abs(c.sample()));
      peaks.push(m);
    }
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeLessThanOrEqual(peaks[i - 1]);
    expect(peaks[peaks.length - 1]).toBeLessThan(peaks[0] / 20);
  });

  it('decay stops at the sustain level (SL=8 = 24 dB below the peak)', () => {
    const c = singleOp(31, 14, 0, 0x8f);
    c.write(0x28, 0xf0);
    let m = 0;
    for (let w = 0; w < 30; w++) {
      m = 0;
      for (let i = 0; i < 4972; i++) m = Math.max(m, Math.abs(c.sample()));
    }
    const dB = 20 * Math.log10(m / 8168);
    expect(dB).toBeLessThan(-22.5);
    expect(dB).toBeGreaterThan(-25.5);
  });

  it('TL attenuates 0.75 dB per step', () => {
    const level = (tl: number): number => {
      const c = singleOp();
      c.write(0x40, tl);
      c.write(0x28, 0xf0);
      let m = 0;
      for (let i = 0; i < 3000; i++) m = Math.max(m, Math.abs(c.sample()));
      return 20 * Math.log10(m / 8168);
    };
    expect(level(0)).toBeCloseTo(0, 1);
    expect(level(16)).toBeCloseTo(-12, 0);
    expect(level(32)).toBeCloseTo(-24, 0);
  });

  it('phase modulation (algorithm 0 chain) creates harmonics; a lone carrier does not', () => {
    const run = (alg: number, tls: number[]): number[] => {
      const c = new Ym2203Fm();
      c.write(0xb0, alg);
      [0x00, 0x04, 0x08, 0x0c].forEach((o, i) => {
        c.write(0x30 + o, 0x01);
        c.write(0x40 + o, tls[i]);
        c.write(0x50 + o, 31);
      });
      c.write(0xa4, (4 << 3) | (1160 >> 8));
      c.write(0xa0, 1160 & 255);
      c.write(0x28, 0xf0);
      const x: number[] = [];
      for (let i = 0; i < 24858; i++) x.push(c.sample());
      return x;
    };
    const lone = run(7, [127, 127, 127, 0]); // only operator 4 audible, unmodulated
    const harmonics = (x: number[]): number => [880, 1320, 1760, 2200].reduce((a, f) => a + goertzel(x, f), 0);
    expect(harmonics(lone)).toBeLessThan(20);
    const fm = run(0, [40, 0, 0, 0]); // op1 -> op2 -> op3 -> op4 chain, all carriers/modulators open
    expect(harmonics(fm)).toBeGreaterThan(500);
  });
});

describe('Ym2203Fm envelope state order (MAME 0.289 ymfm reference)', () => {
  /** op 0 only: AR 31, D1R 0, SL 0 -> the decay hands over to the sustain (D2R) rate at once. */
  it('a zero-rate decay with SL = 0 still falls at the D2R rate (was stuck in decay)', () => {
    const run = (d2r: number): number => {
      const c = singleOp(31, 0, d2r, 0x00);
      c.write(0x28, 0xf0);
      let peak = 0;
      for (let i = 0; i < FS * 2; i++) {
        const v = Math.abs(c.sample());
        if (i > FS * 1.5) peak = Math.max(peak, v);
      }
      return peak;
    };
    const held = run(0);
    const decaying = run(20);
    expect(held).toBeGreaterThan(5000);
    expect(decaying).toBeLessThan(held / 4);
  });
});
