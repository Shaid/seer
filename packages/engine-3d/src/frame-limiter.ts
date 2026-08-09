/**
 * Adaptive frame-rate limiter — lifted from flower's `tools/viewer/viewer.ts`
 * (the `createThreeViewport` render loop, ~line 1155-1202), generalized with
 * one change: an injected `now: () => number` clock, which is what makes it
 * unit-testable without a browser (`performance.now()`/`requestAnimationFrame`
 * live in `viewport.ts`'s render loop, not here).
 *
 * Caps the render cadence at `targetFps` (60 by default) so a high-refresh
 * monitor's native rAF cadence (120/144/240Hz) doesn't burn GPU work
 * rendering identical-looking extra frames, then falls back to `fallbackFps`
 * (30 by default) if a rolling sample of actual per-frame work can't fit the
 * target budget, so motion stays smooth instead of janking at an
 * inconsistent rate; recovers back to the target once work drops off.
 */
export interface FrameLimiterOptions {
  /** Cadence to render at when there's headroom. Default 60. */
  targetFps?: number;
  /** Cadence to fall back to under load. Default 30. */
  fallbackFps?: number;
  /** How many rendered frames to average work-time over before re-evaluating. Default 30. */
  sampleFrames?: number;
  /**
   * Fraction of the target frame budget that average work must exceed
   * before dropping to the fallback rate. Default 0.9 (90%).
   */
  dropThreshold?: number;
  /**
   * Fraction of the *fallback* frame budget that average work must fall
   * below before recovering to the target rate. Default 0.5 (50%). Being a
   * fraction of the (looser) fallback budget rather than the target budget
   * is what creates the hysteresis dead zone between drop and recover —
   * without it, hovering right at the target budget would flip-flop every
   * sample window.
   */
  recoverThreshold?: number;
  /** Wall-clock source, in milliseconds. Defaults to `performance.now`. Inject a fake for tests. */
  now?: () => number;
}

export interface FrameLimiter {
  /** The interval (ms) currently being enforced between rendered frames — `1000/60` or `1000/30` at the defaults, changes as `recordWork` shifts the adaptive state. */
  readonly targetIntervalMs: number;
  /**
   * Call once per host tick (e.g. once per `requestAnimationFrame`). Returns
   * `true` if enough wall time has elapsed since the last render that this
   * tick should actually do the work (mixer update + render); `false` if the
   * caller should skip this tick entirely. Has the side effect of recording
   * "now" as the last-render time whenever it returns `true` — callers must
   * not call it speculatively.
   */
  shouldRender(): boolean;
  /**
   * Report how long the actual per-frame work (mixer update + render call)
   * took, in milliseconds, for a tick where `shouldRender()` returned `true`.
   * Feeds the rolling sample that drives the target/fallback transition.
   */
  recordWork(ms: number): void;
}

const DEFAULT_TARGET_FPS = 60;
const DEFAULT_FALLBACK_FPS = 30;
const DEFAULT_SAMPLE_FRAMES = 30;
const DEFAULT_DROP_THRESHOLD = 0.9;
const DEFAULT_RECOVER_THRESHOLD = 0.5;

export function createFrameLimiter(opts: FrameLimiterOptions = {}): FrameLimiter {
  const now = opts.now ?? (() => performance.now());
  const targetIntervalMs = 1000 / (opts.targetFps ?? DEFAULT_TARGET_FPS);
  const fallbackIntervalMs = 1000 / (opts.fallbackFps ?? DEFAULT_FALLBACK_FPS);
  const sampleFrames = opts.sampleFrames ?? DEFAULT_SAMPLE_FRAMES;
  const dropThreshold = opts.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
  const recoverThreshold = opts.recoverThreshold ?? DEFAULT_RECOVER_THRESHOLD;

  let currentIntervalMs = targetIntervalMs;
  let lastFrameTime = now();
  let sampledWorkMs = 0;
  let sampledFrames = 0;

  return {
    get targetIntervalMs() {
      return currentIntervalMs;
    },
    shouldRender(): boolean {
      const t = now();
      if (t - lastFrameTime < currentIntervalMs) return false;
      lastFrameTime = t;
      return true;
    },
    recordWork(ms: number): void {
      sampledWorkMs += ms;
      sampledFrames++;
      if (sampledFrames < sampleFrames) return;

      const avgWorkMs = sampledWorkMs / sampledFrames;
      // Headroom margins keep the cap from flip-flopping right at the edge:
      // drop when average work exceeds 90% of the *target* budget, recover
      // only once it falls under 50% of the (looser) *fallback* budget.
      if (avgWorkMs > targetIntervalMs * dropThreshold) {
        currentIntervalMs = fallbackIntervalMs;
      } else if (avgWorkMs < fallbackIntervalMs * recoverThreshold) {
        currentIntervalMs = targetIntervalMs;
      }
      sampledWorkMs = 0;
      sampledFrames = 0;
    },
  };
}
