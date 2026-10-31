import { describe, it, expect } from 'vitest';
import { Ym2203Ssg, SSG_LEVELS } from '../yamaha/ym2203-ssg.js';

const RATE = 48000;

function zeroCrossRate(ssg: Ym2203Ssg, seconds: number): number {
  let prev = 0;
  let crossings = 0;
  const n = Math.floor(seconds * RATE);
  const mean = 0;
  for (let i = 0; i < n; i++) {
    const v = ssg.sample(RATE) - mean;
    const s = v > 0 ? 1 : -1;
    if (i > 0 && s !== prev) crossings++;
    prev = s;
  }
  return crossings / 2 / seconds;
}

describe('Ym2203Ssg (ymfm-structured SSG, MAME 0.289 reference)', () => {
  it('tone f = master / (32 N): N = 400 sounds at 279.6 Hz (SSG clock = master/2)', () => {
    const ssg = new Ym2203Ssg();
    ssg.write(0, 400 & 255);
    ssg.write(1, 400 >> 8);
    ssg.write(7, 0x38); // tones on, noise off
    ssg.write(8, 15);
    const f = zeroCrossRate(ssg, 2);
    expect(f).toBeCloseTo(3579545 / (32 * 400), 0);
    // octave controls: master/4 would be half, master/1 double
    expect(Math.abs(f - 3579545 / (64 * 400))).toBeGreaterThan(100);
  });

  it('volume 0 is silent, 15 is full scale, levels are strictly increasing at about -3 dB per step', () => {
    expect(SSG_LEVELS[0]).toBe(0);
    for (let i = 1; i < 16; i++) expect(SSG_LEVELS[i]).toBeGreaterThan(SSG_LEVELS[i - 1]);
    for (let i = 2; i < 16; i++) {
      const db = 20 * Math.log10(SSG_LEVELS[i] / SSG_LEVELS[i - 1]);
      expect(db).toBeGreaterThan(1.8);
      expect(db).toBeLessThan(4.7);
    }
    const ssg = new Ym2203Ssg();
    ssg.write(0, 100);
    ssg.write(7, 0x38);
    ssg.write(8, 0);
    let peak = 0;
    for (let i = 0; i < 4800; i++) peak = Math.max(peak, ssg.sample(RATE));
    expect(peak).toBe(0);
  });

  it('noise: mixer bits gate it, the 17-bit LFSR is not periodic over a short window', () => {
    const ssg = new Ym2203Ssg();
    ssg.write(6, 4);
    ssg.write(7, 0x07); // noise on, tones off
    ssg.write(8, 15);
    const a: number[] = [];
    for (let i = 0; i < 2000; i++) a.push(ssg.sample(RATE));
    const distinct = new Set(a.map((v) => Math.round(v)));
    expect(distinct.size).toBeGreaterThan(3);
    ssg.write(7, 0x3f); // everything disabled -> constant full level (hardware: output held high)
    const b: number[] = [];
    for (let i = 0; i < 200; i++) b.push(ssg.sample(RATE));
    expect(new Set(b.map((v) => Math.round(v))).size).toBe(1);
  });
});
