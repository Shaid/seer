import { describe, it, expect } from 'vitest';
import { formatClock } from '../playback.ts';

describe('formatClock', () => {
  it('formats whole minutes and seconds with zero-padded seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(600)).toBe('10:00');
  });

  it('truncates fractional seconds rather than rounding', () => {
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(60.999)).toBe('1:00');
  });

  it('falls back to 0:00 for null, undefined, negative, and non-finite input', () => {
    expect(formatClock(null)).toBe('0:00');
    expect(formatClock(undefined)).toBe('0:00');
    expect(formatClock(-1)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(Infinity)).toBe('0:00');
  });
});
