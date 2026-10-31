/**
 * Fixed-step main loop for a board-rate simulation.
 *
 * The sim advances in whole steps at the board's measured refresh rate
 * (Black Tiger: 59.637 Hz), never at the display's rate. Each animation
 * frame adds the elapsed time to an accumulator measured in *steps*, runs
 * as many whole steps as it covers (capped by `maxCatchUpSteps`), then
 * calls `render` once with the leftover fraction. The step function itself
 * never sees wall-clock time, so the same inputs always produce the same
 * frames — the loop only decides *how many* steps to run per display frame.
 */

export interface FixedStepLoopOptions {
  /** Board refresh rate in Hz, e.g. `59.637`. Must be > 0. */
  hz: number;
  /** Advances the sim by exactly one step. `frame` is the 0-based step about to run. */
  step: (frame: number) => void;
  /**
   * Called once per animation frame after stepping (and after a single-step).
   * `alpha` is the leftover fraction of a step in `[0, 1)` — useful for
   * interpolating, though a pixel-exact arcade renderer normally ignores it.
   */
  render?: (alpha: number, frame: number) => void;
  /**
   * Upper bound on steps per animation frame, default `4`. A backlog beyond
   * this (a background tab, a debugger pause) is dropped rather than
   * replayed as a burst; dropped steps are counted in `droppedSteps`.
   */
  maxCatchUpSteps?: number;
  /** Speed multiplier, default `1` (`0.5` slow motion, `2` fast-forward). */
  speed?: number;
  /** Injectable for tests; defaults to `globalThis.requestAnimationFrame`. */
  requestFrame?: (cb: (time: number) => void) => number;
  /** Injectable for tests; defaults to `globalThis.cancelAnimationFrame`. */
  cancelFrame?: (handle: number) => void;
}

export interface FixedStepLoop {
  /** Starts requesting animation frames. No-op if already running. */
  start(): void;
  /** Stops requesting animation frames; the accumulator is discarded. */
  stop(): void;
  /** Stops stepping but keeps rendering every animation frame. */
  pause(): void;
  /** Resumes stepping; time spent paused is not caught up. */
  resume(): void;
  /**
   * Runs `count` steps immediately (default 1) and renders once — the
   * frame-advance button. Works whether paused, running or stopped.
   */
  stepOnce(count?: number): void;
  /**
   * Feeds one animation-frame timestamp (ms) by hand. `start()` wires this
   * to `requestAnimationFrame`; tests and headless drivers call it directly.
   */
  tick(time: number): void;
  setSpeed(speed: number): void;
  readonly speed: number;
  readonly running: boolean;
  readonly paused: boolean;
  /** Steps run so far — also the `frame` number the next step receives. */
  readonly frame: number;
  /** Steps discarded because a backlog exceeded `maxCatchUpSteps`. */
  readonly droppedSteps: number;
  readonly hz: number;
}

export function createFixedStepLoop(opts: FixedStepLoopOptions): FixedStepLoop {
  const { hz, step, render } = opts;
  if (!(hz > 0) || !Number.isFinite(hz)) throw new Error(`arcade-runtime: hz must be a positive number (got ${hz})`);
  const maxCatchUp = opts.maxCatchUpSteps ?? 4;
  if (!(maxCatchUp >= 1)) throw new Error('arcade-runtime: maxCatchUpSteps must be >= 1');

  const requestFrame = opts.requestFrame ?? ((cb) => globalThis.requestAnimationFrame(cb));
  const cancelFrame = opts.cancelFrame ?? ((h) => globalThis.cancelAnimationFrame(h));

  let speed = checkSpeed(opts.speed ?? 1);
  let running = false;
  let paused = false;
  let frame = 0;
  let droppedSteps = 0;
  // Accumulated time in units of steps, not ms: avoids re-dividing by the
  // step length every iteration and keeps a speed change exact.
  let acc = 0;
  let lastTime: number | null = null;
  let handle: number | null = null;

  const runStep = (): void => {
    step(frame);
    frame++;
  };

  const tick = (time: number): void => {
    if (lastTime !== null && !paused) {
      // A timestamp going backwards (clock reset, injected test time) counts as no time.
      const dtMs = Math.max(0, time - lastTime);
      acc += (dtMs * hz * speed) / 1000;
      let n = 0;
      while (acc >= 1 && n < maxCatchUp) {
        runStep();
        acc -= 1;
        n++;
      }
      if (acc >= 1) {
        const drop = Math.floor(acc);
        droppedSteps += drop;
        acc -= drop;
      }
    }
    lastTime = time;
    render?.(paused ? 0 : acc, frame);
  };

  const onFrame = (time: number): void => {
    if (!running) return;
    handle = requestFrame(onFrame);
    tick(time);
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastTime = null;
      acc = 0;
      handle = requestFrame(onFrame);
    },
    stop() {
      running = false;
      if (handle !== null) cancelFrame(handle);
      handle = null;
      lastTime = null;
      acc = 0;
    },
    pause() {
      paused = true;
      acc = 0;
    },
    resume() {
      if (!paused) return;
      paused = false;
      // Restart the clock from the next timestamp so the paused span is not caught up.
      lastTime = null;
    },
    stepOnce(count = 1) {
      for (let i = 0; i < count; i++) runStep();
      render?.(0, frame);
    },
    tick,
    setSpeed(next) {
      speed = checkSpeed(next);
    },
    get speed() {
      return speed;
    },
    get running() {
      return running;
    },
    get paused() {
      return paused;
    },
    get frame() {
      return frame;
    },
    get droppedSteps() {
      return droppedSteps;
    },
    hz,
  };
}

function checkSpeed(speed: number): number {
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error(`arcade-runtime: speed must be a positive number (got ${speed})`);
  return speed;
}
