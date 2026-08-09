import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface CameraFitOptions {
  /** Multiplier applied to the bounding-sphere-derived distance so the object doesn't touch the frame edges. Default 1.35. */
  padding?: number;
  /** Unit-ish direction the camera sits along from the target, before scaling by distance. Default a fixed 3/4 angle `(0.6, 0.45, 1)`, matching flower's original framing. */
  direction?: THREE.Vector3;
}

export interface CameraFit {
  target: THREE.Vector3;
  position: THREE.Vector3;
  distance: number;
  near: number;
  far: number;
}

const DEFAULT_DIRECTION = new THREE.Vector3(0.6, 0.45, 1);
const DEFAULT_PADDING = 1.35;

/**
 * Pure bounding-sphere camera fit — flower's `fitCameraToObject` math
 * (`viewer.ts:1068-1082`) split out from its `THREE.PerspectiveCamera`/
 * `OrbitControls` side effects so it's unit-testable without either. Frames
 * `box` from a fixed angle at a distance derived from the box's bounding
 * sphere and `fovDeg`, the generic "look at the whole thing" framing with no
 * per-asset tuning — this is what replaces hunter's inline centroid+maxDist
 * fit (`viewer.ts:416-430`, magic `200`/`2.5` constants).
 *
 * Returns `null` for an empty box (no geometry to fit — mirrors flower's
 * `if (box.isEmpty()) return;` early-out).
 */
export function computeCameraFit(box: THREE.Box3, fovDeg: number, opts: CameraFitOptions = {}): CameraFit | null {
  if (box.isEmpty()) return null;

  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.001);
  const padding = opts.padding ?? DEFAULT_PADDING;
  const distance = (radius / Math.sin((fovDeg * Math.PI) / 360)) * padding;

  const dir = (opts.direction ?? DEFAULT_DIRECTION).clone().normalize();
  const position = center.clone().addScaledVector(dir, distance);

  return {
    target: center,
    position,
    distance,
    near: Math.max(distance / 1000, 0.001),
    far: distance * 100,
  };
}

/**
 * Applies `computeCameraFit` to `camera`/`controls`, framing `object`'s
 * current world-space bounds. No-op if `object` has no geometry to bound.
 */
export function fitCameraToObject(camera: THREE.PerspectiveCamera, controls: OrbitControls, object: THREE.Object3D, opts: CameraFitOptions = {}): void {
  const box = new THREE.Box3().setFromObject(object);
  const fit = computeCameraFit(box, camera.fov, opts);
  if (!fit) return;

  controls.target.copy(fit.target);
  camera.position.copy(fit.position);
  camera.near = fit.near;
  camera.far = fit.far;
  camera.updateProjectionMatrix();
  controls.update();
}
