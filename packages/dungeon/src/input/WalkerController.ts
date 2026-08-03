/**
 * Turns held/pressed keys into pose changes, on a fixed cadence rather than
 * every frame — grid-quantised movement, no interpolation. Per the walker
 * plan's own §7.3 reasoning: the art *is* the projection (a slot table has
 * exactly one piece per depth/lateral cell), so there is no "half a step" to
 * render and building one would be inventing geometry the source games never
 * had.
 *
 * Consumes `@seer/engine-2d`'s `KeyState` directly rather than reimplementing
 * held-key tracking — `WalkerController` only ever calls `isDown`.
 * `update(dtMs, keys)` is pure with respect to time: it takes `dtMs` as a
 * parameter rather than reading a clock itself, so step/turn throttling is
 * unit-testable without a DOM or a real `requestAnimationFrame` loop (feed it
 * synthetic `dtMs` values and a fake `KeyState`-shaped object).
 *
 * Collision is intentionally not this class's job — `canStep` (in
 * `model/collision.ts`) is the single movement-gate predicate, and this
 * controller only ever asks its injected `canStep` callback whether a
 * candidate step is allowed. That keeps `WalkerController`'s own tests
 * (throttling, binding dispatch) independent of any real `CellQuery`; a host
 * wires the real predicate in via `options.canStep`.
 */
import type { Pose, Dir4 } from '../model/Pose.ts';
import { turnLeft, turnRight } from '../model/Pose.ts';
import { rotate, leftOf, rightOf, step as stepCell } from '../model/Direction.ts';
import type { BindingsFile } from '../schema/bindings.ts';

/**
 * The subset of `@seer/engine-2d`'s `KeyState` this controller needs. A real
 * `KeyState` instance satisfies this structurally (it has a public `isDown`),
 * so a host just passes one straight in; tests pass a plain object literal
 * instead of constructing a real, DOM-`EventTarget`-backed `KeyState`, which
 * a nominal (class-typed) parameter would have made needlessly awkward.
 */
export interface KeyStateLike {
  isDown(code: string): boolean;
}

export interface WalkerControllerOptions {
  /** Minimum time between accepted steps, in ms. Default 175. */
  stepIntervalMs?: number;
  /** Minimum time between accepted turns, in ms. Default 175. */
  turnIntervalMs?: number;
  /**
   * Movement-gate predicate consulted before turning a held direction key
   * into an actual step. Defaults to "always allowed" (useful for testing
   * throttling/bindings in isolation) — a real host wires in
   * `(pose, dir) => canStep(level, semantics, pose, dir)`.
   */
  canStep?: (pose: Pose, dir: Dir4) => boolean;
}

const DEFAULT_STEP_INTERVAL_MS = 175;
const DEFAULT_TURN_INTERVAL_MS = 175;

function anyDown(keys: KeyStateLike, codes: string[]): boolean {
  return codes.some((code) => keys.isDown(code));
}

export class WalkerController {
  private readonly bindings: BindingsFile;
  private readonly stepIntervalMs: number;
  private readonly turnIntervalMs: number;
  private readonly canStepFn: (pose: Pose, dir: Dir4) => boolean;

  private _pose: Pose;
  private sinceStepMs = 0;
  private sinceTurnMs = 0;

  constructor(initialPose: Pose, bindings: BindingsFile, options: WalkerControllerOptions = {}) {
    this._pose = initialPose;
    this.bindings = bindings;
    this.stepIntervalMs = options.stepIntervalMs ?? DEFAULT_STEP_INTERVAL_MS;
    this.turnIntervalMs = options.turnIntervalMs ?? DEFAULT_TURN_INTERVAL_MS;
    this.canStepFn = options.canStep ?? (() => true);
  }

  get pose(): Pose {
    return this._pose;
  }

  /** Replace the current pose without going through movement/throttling (e.g. a URL-param jump, a teleport). Resets both throttles. */
  setPose(pose: Pose): void {
    this._pose = pose;
    this.sinceStepMs = 0;
    this.sinceTurnMs = 0;
  }

  /**
   * Advance the controller by `dtMs` and, if the held keys and throttles
   * allow it, apply one turn and/or one step. Returns the new `Pose` only
   * when it actually changed (a real turn or an actually-allowed step) —
   * `null` on every other call, including a call where a movement key is
   * held but `canStep` rejected it.
   */
  update(dtMs: number, keys: KeyStateLike): Pose | null {
    this.sinceStepMs += dtMs;
    this.sinceTurnMs += dtMs;

    let pose = this._pose;
    let changed = false;

    if (this.sinceTurnMs >= this.turnIntervalMs) {
      if (anyDown(keys, this.bindings.bindings.turnLeft)) {
        pose = turnLeft(pose);
        changed = true;
        this.sinceTurnMs = 0;
      } else if (anyDown(keys, this.bindings.bindings.turnRight)) {
        pose = turnRight(pose);
        changed = true;
        this.sinceTurnMs = 0;
      }
    }

    if (this.sinceStepMs >= this.stepIntervalMs) {
      const dir = this.intendedStepDirection(pose, keys);
      if (dir !== null) {
        this.sinceStepMs = 0;
        if (this.canStepFn(pose, dir)) {
          const { x, y } = stepCell(pose.x, pose.y, dir);
          pose = { ...pose, x, y };
          changed = true;
        }
      }
    }

    if (!changed) return null;
    this._pose = pose;
    return pose;
  }

  private intendedStepDirection(pose: Pose, keys: KeyStateLike): Dir4 | null {
    const b = this.bindings.bindings;
    if (anyDown(keys, b.forward)) return pose.facing;
    if (anyDown(keys, b.back)) return rotate(pose.facing, 2);
    if (anyDown(keys, b.strafeLeft)) return leftOf(pose.facing);
    if (anyDown(keys, b.strafeRight)) return rightOf(pose.facing);
    return null;
  }

  /** One-shot, non-throttled check for the `interact` binding — the caller (a host) is expected to use `KeyState.consumePress` itself; this just names which codes to ask about. */
  interactCodes(): string[] {
    return this.bindings.bindings.interact;
  }

  /** One-shot codes for the `automap` toggle binding, same convention as `interactCodes`. */
  automapCodes(): string[] {
    return this.bindings.bindings.automap;
  }
}
