/**
 * M4 — `AnimRef`'s tick-driven frame clock (`walker-plan.md` "Animated
 * decorations"). Uses `fire-animation.json`'s actual proven shape (15
 * frames, `ticksPerFrame: 4`, `periodTicks: 60`, per-instance `phaseTicks`)
 * rather than inventing a new one.
 */
import { describe, expect, it } from 'vitest';
import { animFrameIndex, animFrameChanges, cellSeed, isAnimRef, resolveFrameName } from '../raster/anim.ts';
import type { AnimRef } from '../schema/slots.ts';

const FIRE: AnimRef = {
  frames: Array.from({ length: 15 }, (_, i) => `fire-${i}`),
  ticksPerFrame: 4,
  periodTicks: 60,
};

describe('isAnimRef', () => {
  it('is false for a plain string frame', () => {
    expect(isAnimRef('some-frame')).toBe(false);
  });

  it('is true for an AnimRef (object with a frames array)', () => {
    expect(isAnimRef(FIRE)).toBe(true);
  });
});

describe('animFrameIndex — fixed phase', () => {
  it('starts at frame 0 at tick 0 with no phaseTicks', () => {
    expect(animFrameIndex(FIRE, 0)).toBe(0);
  });

  it('advances one frame every ticksPerFrame ticks', () => {
    expect(animFrameIndex(FIRE, 3)).toBe(0);
    expect(animFrameIndex(FIRE, 4)).toBe(1);
    expect(animFrameIndex(FIRE, 7)).toBe(1);
    expect(animFrameIndex(FIRE, 8)).toBe(2);
  });

  it('wraps at periodTicks, back to frame 0', () => {
    expect(animFrameIndex(FIRE, 59)).toBe(14);
    expect(animFrameIndex(FIRE, 60)).toBe(0);
    expect(animFrameIndex(FIRE, 124)).toBe(animFrameIndex(FIRE, 4));
  });

  it('honours a per-instance phaseTicks offset — four real torch instances at the same tick show different frames', () => {
    const instances = [0, 10, 20, 30].map((phaseTicks) => ({ ...FIRE, phaseTicks }));
    const framesAtTick0 = instances.map((anim) => animFrameIndex(anim, 0));
    expect(new Set(framesAtTick0).size).toBe(4); // all four distinct
    expect(framesAtTick0).toEqual([0, 10, 20, 30].map((p) => Math.floor(p / 4)));
  });

  it('defaults periodTicks to frames.length * ticksPerFrame when omitted', () => {
    const noPeriod: AnimRef = { frames: FIRE.frames, ticksPerFrame: 4 };
    expect(animFrameIndex(noPeriod, 60)).toBe(animFrameIndex(noPeriod, 0)); // same wrap point as the explicit periodTicks: 60 case
  });
});

describe('animFrameIndex — phase: "cell"', () => {
  const cellAnim: AnimRef = { ...FIRE, phase: 'cell' };

  it('is deterministic: the same cell and tick always yield the same frame', () => {
    const a = animFrameIndex(cellAnim, 17, { x: 5, y: 9 });
    const b = animFrameIndex(cellAnim, 17, { x: 5, y: 9 });
    expect(a).toBe(b);
  });

  it('different cells can show different frames at the same tick', () => {
    const frames = new Set<number>();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) frames.add(animFrameIndex(cellAnim, 0, { x, y }));
    }
    expect(frames.size).toBeGreaterThan(1);
  });

  it('ignores phaseTicks entirely when phase is "cell"', () => {
    const withPhaseTicks: AnimRef = { ...cellAnim, phaseTicks: 999 };
    expect(animFrameIndex(withPhaseTicks, 5, { x: 1, y: 2 })).toBe(animFrameIndex(cellAnim, 5, { x: 1, y: 2 }));
  });
});

describe('cellSeed', () => {
  it('is a pure function of (x, y)', () => {
    expect(cellSeed(3, 4)).toBe(cellSeed(3, 4));
  });

  it('generally differs for different cells', () => {
    expect(cellSeed(0, 0)).not.toBe(cellSeed(1, 0));
    expect(cellSeed(0, 0)).not.toBe(cellSeed(0, 1));
  });
});

describe('resolveFrameName', () => {
  it('passes a plain string frame through unchanged, ignoring tick', () => {
    expect(resolveFrameName('door-open', 12345)).toBe('door-open');
  });

  it('resolves an AnimRef to the frame name selected at tick', () => {
    expect(resolveFrameName(FIRE, 8)).toBe('fire-2');
  });
});

describe('animFrameChanges', () => {
  it('is false within the same frame window', () => {
    expect(animFrameChanges(FIRE, 0, 3)).toBe(false);
  });

  it('is true crossing a ticksPerFrame boundary', () => {
    expect(animFrameChanges(FIRE, 3, 4)).toBe(true);
  });

  it('is true crossing the periodTicks wrap boundary', () => {
    expect(animFrameChanges(FIRE, 59, 60)).toBe(true);
  });
});
