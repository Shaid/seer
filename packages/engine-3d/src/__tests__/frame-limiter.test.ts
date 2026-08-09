import { describe, expect, it } from 'vitest';
import { createFrameLimiter } from '../frame-limiter.js';

/** A fake clock the limiter drives entirely off — no real timers, no flake. */
function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('createFrameLimiter', () => {
  it('drops a 144Hz-cadence stream of ticks well below the raw input rate, capped at the 60fps target', () => {
    const clock = fakeClock();
    const limiter = createFrameLimiter({ now: clock.now });

    const frameIntervalMs = 1000 / 144;
    let rendered = 0;
    // Simulate one full second of 144Hz ticks.
    for (let i = 0; i < 144; i++) {
      clock.advance(frameIntervalMs);
      if (limiter.shouldRender()) {
        rendered++;
        limiter.recordWork(1); // cheap work — stays at the 60fps target
      }
    }

    // `shouldRender()` only fires once *at least* a full 60fps interval
    // (16.67ms) has elapsed since the last render, snapping up to the next
    // whole 144Hz tick boundary — since 3 ticks (20.83ms) is the smallest
    // multiple of the 6.94ms tick period that clears 16.67ms (2 ticks only
    // covers 13.89ms), this discretization actually renders every 3rd tick,
    // i.e. ~48fps, not a full 60fps. The behavior that matters here — and
    // what distinguishes this from a raw 144fps loop — is that it's well
    // below the uncapped 144 renders/sec a naive "render every tick" loop
    // would produce, and that it stays at the 60fps target interval rather
    // than falling back to 30fps under this trivially cheap workload.
    expect(rendered).toBeLessThan(144);
    expect(rendered).toBeGreaterThanOrEqual(45);
    expect(rendered).toBeLessThanOrEqual(60);
    expect(limiter.targetIntervalMs).toBeCloseTo(1000 / 60, 5);
  });

  it('converges to the true 60fps target interval as the input tick granularity gets finer', () => {
    const clock = fakeClock();
    const limiter = createFrameLimiter({ now: clock.now });

    const fineTickMs = 1; // 1000Hz driver — fine enough that the discretization effect above is negligible
    let rendered = 0;
    for (let i = 0; i < 1000; i++) {
      clock.advance(fineTickMs);
      if (limiter.shouldRender()) {
        rendered++;
        limiter.recordWork(0.1);
      }
    }

    expect(rendered).toBeGreaterThanOrEqual(58);
    expect(rendered).toBeLessThanOrEqual(61);
  });

  it('drops from 60fps to 30fps once recorded work exceeds the drop threshold, and recovers once work drops off (hysteresis)', () => {
    const clock = fakeClock();
    const limiter = createFrameLimiter({ now: clock.now, sampleFrames: 5 });

    expect(limiter.targetIntervalMs).toBeCloseTo(1000 / 60, 5);

    // Feed 5 frames of heavy work (> 90% of the 60fps budget) — should drop.
    const heavyWorkMs = (1000 / 60) * 0.95;
    for (let i = 0; i < 5; i++) {
      clock.advance(1000 / 60);
      limiter.shouldRender();
      limiter.recordWork(heavyWorkMs);
    }
    expect(limiter.targetIntervalMs).toBeCloseTo(1000 / 30, 5);

    // Feed 5 frames of moderate work — inside the dead zone (below the 60fps
    // drop threshold but above the 30fps recover threshold) — must NOT
    // recover yet. This is the no-flip-flop guarantee.
    const moderateWorkMs = (1000 / 30) * 0.75;
    for (let i = 0; i < 5; i++) {
      clock.advance(1000 / 30);
      limiter.shouldRender();
      limiter.recordWork(moderateWorkMs);
    }
    expect(limiter.targetIntervalMs).toBeCloseTo(1000 / 30, 5);

    // Feed 5 frames of light work (< 50% of the 30fps budget) — should recover.
    const lightWorkMs = (1000 / 30) * 0.25;
    for (let i = 0; i < 5; i++) {
      clock.advance(1000 / 30);
      limiter.shouldRender();
      limiter.recordWork(lightWorkMs);
    }
    expect(limiter.targetIntervalMs).toBeCloseTo(1000 / 60, 5);
  });

  it('never flip-flops when hovering in the dead zone across many sample windows', () => {
    const clock = fakeClock();
    const limiter = createFrameLimiter({ now: clock.now, sampleFrames: 10 });

    // Work that sits between the 30fps recover threshold and the 60fps drop
    // threshold, sustained indefinitely — should settle at 30fps (once it
    // gets there is irrelevant here; the point is it must never oscillate
    // back to 60 while this same work level persists) or stay at 60fps if it
    // never dropped, but must not alternate frame to frame.
    const deadZoneWorkMs = (1000 / 60) * 0.7; // above 30fps-recover (50% of 33.3ms=16.6ms), below 60fps-drop (90% of 16.6=15ms)... use a value clearly inside both zones' gap.
    const seenIntervals = new Set<number>();
    for (let i = 0; i < 200; i++) {
      clock.advance(limiter.targetIntervalMs);
      if (limiter.shouldRender()) {
        limiter.recordWork(deadZoneWorkMs);
      }
      seenIntervals.add(Math.round(limiter.targetIntervalMs * 1000));
    }
    // Once settled, the interval should take at most one value across the
    // whole run's tail — no repeated back-and-forth.
    const tailIntervals = new Set<number>();
    for (let i = 0; i < 50; i++) {
      clock.advance(limiter.targetIntervalMs);
      if (limiter.shouldRender()) limiter.recordWork(deadZoneWorkMs);
      tailIntervals.add(Math.round(limiter.targetIntervalMs * 1000));
    }
    expect(tailIntervals.size).toBe(1);
  });

  it('shouldRender() returns false for ticks arriving before the target interval has elapsed', () => {
    const clock = fakeClock();
    const limiter = createFrameLimiter({ now: clock.now, targetFps: 60 });

    clock.advance(1); // far short of a 16.6ms frame
    expect(limiter.shouldRender()).toBe(false);

    clock.advance(1000 / 60);
    expect(limiter.shouldRender()).toBe(true);
  });
});
