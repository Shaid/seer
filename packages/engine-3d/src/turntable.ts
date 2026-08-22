import * as THREE from 'three';
import type { Viewport } from './viewport.js';

export type TurntableDirection = 'cw' | 'ccw';
export type TurntableEasing = 'linear' | 'ease-in-out';

export interface TurntableOptions {
  /** Seconds for one full 360° rotation. Default `8`. */
  durationSeconds?: number;
  /** Full rotations before the clip is considered complete. `Infinity` (the default) spins forever — only meaningful to `step()`; `start()`'s live autoRotate spins continuously regardless, until `stop()`. */
  loops?: number;
  direction?: TurntableDirection;
  /** Polar angle in radians from the vertical (+Y) axis, applied once when the turntable's base position is captured. Omit to keep whatever elevation the camera already has. */
  elevation?: number;
  /** Only affects `step()` (a finite `loops`) — eases the WHOLE multi-loop sequence in and out, not each individual loop (each 2π loop is already seamless). Meaningless with `loops: Infinity`. Default `'linear'`. */
  easing?: TurntableEasing;
}

export interface Turntable {
  /** Enables `OrbitControls.autoRotate` for live viewing — the render loop's own per-frame `controls.update()` call does the rest. A user drag naturally overrides it. Captures the current camera offset (and applies `elevation`, if given) as the rotation's base position. Don't mix with `step()` on the same instance without an intervening `stop()` — both drive the camera and running both concurrently races. */
  start(): void;
  /** Disables `autoRotate`, leaving the camera wherever it currently is. */
  stop(): void;
  /**
   * Advances the turntable's own elapsed clock by exactly `deltaSeconds`
   * and writes the resulting camera position directly — for deterministic,
   * fixed-timestep export via `viewport.renderNow()`, which (unlike the
   * live render loop) never calls `controls.update()` on its own, so
   * nothing else touches camera state between calls. Captures the base
   * position on its own first call if `start()` was never used.
   */
  step(deltaSeconds: number): void;
  readonly elapsedSeconds: number;
  /** Equivalent to `stop()` — a turntable holds no other disposable resources. */
  dispose(): void;
}

const TWO_PI = Math.PI * 2;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * The turntable's pure core: the azimuth (radians, right-handed around
 * +Y, relative to wherever rotation started) at `elapsedSeconds` into a
 * clip that completes one full rotation every `durationSeconds`, `loops`
 * times over. `direction: 'cw'` (the default) negates the angle so the
 * turntable appears to rotate clockwise viewed from above.
 *
 * `loops: Infinity` spins at a constant rate forever — there's no "end" to
 * ease toward, so `easing` is ignored in that case. With a finite `loops`,
 * `easing: 'ease-in-out'` shapes the WHOLE `durationSeconds * loops`
 * sequence (slow start, slow finish) rather than each individual loop,
 * since a full 2π loop is already seamless at constant speed.
 */
export function turntableAzimuth(
  elapsedSeconds: number,
  durationSeconds: number,
  loops: number,
  direction: TurntableDirection = 'cw',
  easing: TurntableEasing = 'linear',
): number {
  if (durationSeconds <= 0 || loops <= 0) return 0;
  const sign = direction === 'cw' ? -1 : 1;

  if (!Number.isFinite(loops)) {
    return sign * (elapsedSeconds / durationSeconds) * TWO_PI;
  }

  const totalSeconds = durationSeconds * loops;
  const t = Math.min(Math.max(elapsedSeconds / totalSeconds, 0), 1);
  const progress = easing === 'ease-in-out' ? easeInOut(t) : t;
  return sign * progress * loops * TWO_PI;
}

/** Builds a turntable over `viewport`'s camera/controls. See `Turntable`'s own method docs for the two independent drive modes. */
export function createTurntable(viewport: Viewport, opts: TurntableOptions = {}): Turntable {
  const durationSeconds = opts.durationSeconds ?? 8;
  const loops = opts.loops ?? Infinity;
  const direction = opts.direction ?? 'cw';
  const easing = opts.easing ?? 'linear';

  const controls = viewport.controls;
  const spherical = new THREE.Spherical();
  let baseAzimuth = 0;
  let baseCaptured = false;
  let elapsed = 0;
  let disposed = false;

  const captureBase = (): void => {
    const offset = new THREE.Vector3().copy(controls.object.position).sub(controls.target);
    spherical.setFromVector3(offset);
    if (opts.elevation !== undefined) {
      spherical.phi = opts.elevation;
      const next = new THREE.Vector3().setFromSpherical(spherical).add(controls.target);
      controls.object.position.copy(next);
      controls.object.lookAt(controls.target);
    }
    baseAzimuth = spherical.theta;
    baseCaptured = true;
  };

  return {
    get elapsedSeconds() {
      return elapsed;
    },
    start() {
      if (disposed) return;
      captureBase();
      elapsed = 0;
      controls.autoRotate = true;
      controls.autoRotateSpeed = autoRotateSign(direction) * (60 / durationSeconds);
    },
    stop() {
      if (disposed) return;
      controls.autoRotate = false;
    },
    step(deltaSeconds) {
      if (disposed) return;
      if (!baseCaptured) captureBase();
      elapsed += deltaSeconds;
      spherical.theta = baseAzimuth + turntableAzimuth(elapsed, durationSeconds, loops, direction, easing);
      const offset = new THREE.Vector3().setFromSpherical(spherical);
      controls.object.position.copy(controls.target).add(offset);
      controls.object.lookAt(controls.target);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controls.autoRotate = false;
    },
  };
}

/**
 * `OrbitControls._rotateLeft(angle)` does `theta -= angle`, and its
 * `_getAutoRotationAngle` returns a *positive* angle for a *positive*
 * `autoRotateSpeed` — so a positive speed decreases theta over time.
 * `turntableAzimuth('cw')` is also theta-decreasing (it returns a
 * negative, growing-in-magnitude delta), so `'cw'` needs a *positive*
 * `autoRotateSpeed` to match — the opposite of `turntableAzimuth`'s own
 * sign convention.
 */
function autoRotateSign(direction: TurntableDirection): number {
  return direction === 'cw' ? 1 : -1;
}
