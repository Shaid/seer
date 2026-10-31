import { describe, expect, it } from 'vitest';
import { createFixedStepLoop } from '../loop.js';

function harness(hz: number, extra: { maxCatchUpSteps?: number; speed?: number } = {}) {
  const steps: number[] = [];
  const renders: { alpha: number; frame: number }[] = [];
  let pending: ((t: number) => void) | null = null;
  const loop = createFixedStepLoop({
    hz,
    step: (f) => steps.push(f),
    render: (alpha, frame) => renders.push({ alpha, frame }),
    requestFrame: (cb) => {
      pending = cb;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
    },
    ...extra,
  });
  const fire = (t: number) => {
    const cb = pending;
    pending = null;
    cb?.(t);
  };
  return { loop, steps, renders, fire, hasPending: () => pending !== null };
}

describe('createFixedStepLoop', () => {
  it('runs exactly hz steps per simulated second, independent of display rate', () => {
    for (const displayHz of [30, 60, 144, 165]) {
      const { loop, steps, fire } = harness(59.637);
      loop.start();
      for (let i = 0; i <= displayHz * 10; i++) fire((i * 1000) / displayHz);
      // 10 s at 59.637 Hz = 596.37 steps.
      expect(steps.length).toBe(596);
      expect(steps.slice(0, 3)).toEqual([0, 1, 2]);
    }
  });

  it('first timestamp only primes the clock', () => {
    const { loop, steps, renders, fire } = harness(60);
    loop.start();
    fire(5000);
    expect(steps).toEqual([]);
    expect(renders).toHaveLength(1);
  });

  it('caps catch-up and counts dropped steps', () => {
    const { loop, steps, fire } = harness(60, { maxCatchUpSteps: 3 });
    loop.start();
    fire(0);
    fire(1000); // 60 steps of backlog
    expect(steps).toHaveLength(3);
    expect(loop.droppedSteps).toBe(57);
    fire(1000 + 1000 / 60 + 0.001);
    expect(steps).toHaveLength(4);
  });

  it('pause keeps rendering without stepping, and resume does not catch up', () => {
    const { loop, steps, renders, fire } = harness(60);
    loop.start();
    fire(0);
    fire(100);
    const n = steps.length;
    loop.pause();
    fire(200);
    fire(5000);
    expect(steps.length).toBe(n);
    expect(renders.at(-1)?.alpha).toBe(0);
    loop.resume();
    fire(6000); // primes
    expect(steps.length).toBe(n);
    fire(6000 + 1000 / 60 + 0.001);
    expect(steps.length).toBe(n + 1);
  });

  it('stepOnce advances and renders even while paused', () => {
    const { loop, steps, renders } = harness(60);
    loop.pause();
    loop.stepOnce();
    loop.stepOnce(2);
    expect(steps).toEqual([0, 1, 2]);
    expect(loop.frame).toBe(3);
    expect(renders.map((r) => r.frame)).toEqual([1, 3]);
  });

  it('speed multiplier scales steps per second', () => {
    // 64 Hz with 15.625 ms frames keeps every value exact in binary.
    const { loop, steps, fire } = harness(64, { speed: 2, maxCatchUpSteps: 8 });
    loop.start();
    for (let i = 0; i <= 64; i++) fire(i * 15.625);
    expect(steps.length).toBe(128);
    loop.setSpeed(0.5);
    for (let i = 65; i <= 128; i++) fire(i * 15.625);
    expect(steps.length).toBe(160);
  });

  it('render alpha is the leftover step fraction', () => {
    const { loop, renders, fire } = harness(10);
    loop.start();
    fire(0);
    fire(250); // 2.5 steps
    expect(renders.at(-1)).toEqual({ alpha: 0.5, frame: 2 });
  });

  it('stop cancels the pending frame', () => {
    const { loop, hasPending } = harness(60);
    loop.start();
    expect(loop.running).toBe(true);
    loop.stop();
    expect(hasPending()).toBe(false);
    expect(loop.running).toBe(false);
  });

  it('rejects a non-positive hz or speed', () => {
    expect(() => createFixedStepLoop({ hz: 0, step: () => {} })).toThrow();
    expect(() => createFixedStepLoop({ hz: 60, step: () => {}, speed: -1 })).toThrow();
  });
});
