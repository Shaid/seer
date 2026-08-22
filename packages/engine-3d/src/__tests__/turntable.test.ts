import { describe, expect, it } from 'vitest';
import { turntableAzimuth } from '../turntable.js';

describe('turntableAzimuth', () => {
  it('is zero at elapsed=0', () => {
    expect(turntableAzimuth(0, 8, Infinity)).toBeCloseTo(0, 10);
    expect(turntableAzimuth(0, 8, 1)).toBeCloseTo(0, 10);
  });

  it('continuous (loops: Infinity) advances linearly, unbounded', () => {
    expect(turntableAzimuth(4, 8, Infinity)).toBeCloseTo(-Math.PI, 10);
    expect(turntableAzimuth(8, 8, Infinity)).toBeCloseTo(-2 * Math.PI, 10);
    expect(turntableAzimuth(16, 8, Infinity)).toBeCloseTo(-4 * Math.PI, 10);
  });

  it("direction 'ccw' negates the sign", () => {
    expect(turntableAzimuth(4, 8, Infinity, 'ccw')).toBeCloseTo(Math.PI, 10);
    expect(turntableAzimuth(2, 8, 1, 'ccw')).toBeCloseTo(Math.PI / 2, 10);
  });

  it('finite loops: one loop over durationSeconds reaches -2π (cw) at the end', () => {
    expect(turntableAzimuth(8, 8, 1)).toBeCloseTo(-2 * Math.PI, 10);
    expect(turntableAzimuth(4, 8, 1)).toBeCloseTo(-Math.PI, 10);
  });

  it('finite loops: two loops over durationSeconds each reaches -4π total at the end', () => {
    expect(turntableAzimuth(16, 8, 2)).toBeCloseTo(-4 * Math.PI, 10);
    expect(turntableAzimuth(8, 8, 2)).toBeCloseTo(-2 * Math.PI, 10);
  });

  it('finite loops: clamps at the end rather than continuing past it', () => {
    expect(turntableAzimuth(100, 8, 1)).toBeCloseTo(-2 * Math.PI, 10);
  });

  it("easing 'ease-in-out' matches linear at the start, middle, and end of a finite clip", () => {
    const duration = 8;
    expect(turntableAzimuth(0, duration, 1, 'cw', 'ease-in-out')).toBeCloseTo(0, 10);
    expect(turntableAzimuth(duration / 2, duration, 1, 'cw', 'ease-in-out')).toBeCloseTo(-Math.PI, 10);
    expect(turntableAzimuth(duration, duration, 1, 'cw', 'ease-in-out')).toBeCloseTo(-2 * Math.PI, 10);
  });

  it("easing 'ease-in-out' is slower than linear near the start (ease-in)", () => {
    const duration = 8;
    const eased = Math.abs(turntableAzimuth(1, duration, 1, 'cw', 'ease-in-out'));
    const linear = Math.abs(turntableAzimuth(1, duration, 1, 'cw', 'linear'));
    expect(eased).toBeLessThan(linear);
  });

  it('ease-in-out is ignored (treated as linear) when loops is Infinity', () => {
    const eased = turntableAzimuth(3, 8, Infinity, 'cw', 'ease-in-out');
    const linear = turntableAzimuth(3, 8, Infinity, 'cw', 'linear');
    expect(eased).toBeCloseTo(linear, 10);
  });

  it('durationSeconds <= 0 returns 0', () => {
    expect(turntableAzimuth(5, 0, 1)).toBe(0);
    expect(turntableAzimuth(5, -1, 1)).toBe(0);
  });

  it('loops <= 0 returns 0', () => {
    expect(turntableAzimuth(5, 8, 0)).toBe(0);
    expect(turntableAzimuth(5, 8, -1)).toBe(0);
  });

  it('defaults to cw, linear when omitted', () => {
    expect(turntableAzimuth(4, 8, Infinity)).toBe(turntableAzimuth(4, 8, Infinity, 'cw', 'linear'));
  });
});
