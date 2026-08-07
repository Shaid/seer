import { describe, it, expect, vi } from 'vitest';
import { attemptPlayback, formatClock } from '../playback.ts';
import type { PlaybackState } from '../playback.ts';

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

describe('attemptPlayback', () => {
  it('runs a play() that returns void, without reporting failure', () => {
    const onFailure = vi.fn();
    const play = vi.fn(() => {});
    attemptPlayback(play, onFailure);
    expect(play).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('leaves a resolving promise alone', async () => {
    const onFailure = vi.fn();
    attemptPlayback(() => Promise.resolve(), onFailure);
    await Promise.resolve();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('routes a rejected promise to onFailure — the autoplay-blocked case', async () => {
    const onFailure = vi.fn();
    const err = new Error('NotAllowedError');
    attemptPlayback(() => Promise.reject(err), onFailure);
    await Promise.resolve();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledWith(err);
  });

  it('routes a synchronous throw to onFailure instead of letting it escape', () => {
    // The case a bare `Promise.resolve(play()).catch(...)` misses: the throw
    // happens before a promise ever exists, so it propagates to the caller.
    const onFailure = vi.fn();
    const err = new Error('no track loaded');
    expect(() =>
      attemptPlayback(() => {
        throw err;
      }, onFailure),
    ).not.toThrow();
    expect(onFailure).toHaveBeenCalledWith(err);
  });
});

describe('PlaybackState', () => {
  it('accepts the two coherent seekable/duration pairings', () => {
    const seekable: PlaybackState = {
      isPlaying: true,
      currentTime: 10,
      title: 'track',
      seekable: true,
      duration: 120,
    };
    const live: PlaybackState = {
      isPlaying: true,
      currentTime: 10,
      title: 'module',
      seekable: false,
      duration: null,
    };
    expect(seekable.duration).toBe(120);
    expect(live.duration).toBeNull();
  });

  it('narrows duration to a number when seekable is true', () => {
    const state: PlaybackState = { isPlaying: false, currentTime: 30, title: 't', seekable: true, duration: 120 };
    if (state.seekable) {
      // No null check needed — that is the point of the discriminated union.
      expect(state.currentTime / state.duration).toBeCloseTo(0.25);
    }
  });

  it('rejects incoherent pairings at compile time', () => {
    // These are type-level assertions: `@ts-expect-error` fails the repo
    // typecheck if the annotated line ever stops being an error, so an
    // accidental widening of PlaybackState breaks the build here.
    // @ts-expect-error - seekable: true requires a numeric duration
    const noDuration: PlaybackState = { isPlaying: false, currentTime: 0, title: 't', seekable: true, duration: null };
    // @ts-expect-error - seekable: false requires duration to be null
    const strayDuration: PlaybackState = { isPlaying: false, currentTime: 0, title: 't', seekable: false, duration: 90 };
    expect(noDuration.seekable).toBe(true);
    expect(strayDuration.seekable).toBe(false);
  });
});
