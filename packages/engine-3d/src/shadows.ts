import * as THREE from 'three';

function isMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as { isMesh?: boolean }).isMesh === true;
}

/**
 * Shadow-map quality knobs for a single shadow-casting light. Meaningless
 * on `ambient`/`fill` lights in practice — three.js's shadow system only
 * ever reads these off a light that also has `castShadow: true`, and this
 * package only ever sets that on the key light (see `viewport.ts`'s
 * `setShadows()`) — but `LightConfig` carries the fields on all three light
 * slots uniformly, the same way `position` is already meaningless on
 * `ambient`.
 */
export interface ShadowOptions {
  /** Shadow map resolution (square). Default `2048`. */
  mapSize?: number;
  /** Depth-map bias — a small negative value fights shadow acne without introducing visible peter-panning. Default `-0.0005`. */
  bias?: number;
  /** Bias along the surface normal — usually a better acne fix than `bias` alone for a coarse/low-poly mesh. Default `0.02`. */
  normalBias?: number;
  /** Blur radius, meaningful only with `THREE.PCFSoftShadowMap` (what `applyShadowSettings` enables). Default `1`. */
  radius?: number;
}

/**
 * Turns the renderer's shadow map on/off. `THREE.PCFSoftShadowMap` is
 * fixed, not configurable — it's the type `ShadowOptions.radius` assumes,
 * and there is no real ask from any consumer project for the harder-edged
 * alternatives.
 */
export function applyShadowSettings(renderer: THREE.WebGLRenderer, enabled: boolean): void {
  renderer.shadowMap.enabled = enabled;
  if (enabled) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

/** Configures one light's shadow-map quality. Does not touch `castShadow` itself — the caller decides which light(s) cast, this only shapes the map once a light does. */
export function applyLightShadowSettings(
  light: THREE.DirectionalLight,
  opts: ShadowOptions = {},
): void {
  const mapSize = opts.mapSize ?? 2048;
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.bias = opts.bias ?? -0.0005;
  light.shadow.normalBias = opts.normalBias ?? 0.02;
  light.shadow.radius = opts.radius ?? 1;
}

export interface ModelShadowOptions {
  /** Default `true`. */
  cast?: boolean;
  /** Default `true`. */
  receive?: boolean;
}

/** Sets `castShadow`/`receiveShadow` on every mesh under `object`. Call whenever a model is loaded while shadows are enabled (`session.ts`'s `setModel`/`addModel`) — a freshly-added mesh doesn't inherit these flags from its parent. */
export function enableModelShadows(object: THREE.Object3D, opts: ModelShadowOptions = {}): void {
  const cast = opts.cast ?? true;
  const receive = opts.receive ?? true;
  object.traverse((child) => {
    if (!isMesh(child)) return;
    child.castShadow = cast;
    child.receiveShadow = receive;
  });
}

export interface FitShadowCameraOptions {
  /** Fractional padding added around the model's bounding radius, so a shadow isn't clipped right at the model's silhouette. Default `0.25` (25%). */
  padding?: number;
}

/**
 * Fits `light`'s orthographic shadow-camera frustum to `box`, replacing
 * three.js's default `[-5, 5, 5, -5, 0.5, 500]` (`DirectionalLightShadow`'s
 * own default) — fine for a toy demo scene, but it clips any model whose
 * footprint exceeds 10 units, silently dropping its shadow with no error.
 *
 * Repositions `light` itself, too, along whatever direction it's already
 * offset from its target (preserving the artistic "light comes from this
 * angle" choice a fixed default like `[3, 5, 4]` — `viewport.ts` — encodes)
 * but scaled to a distance the model's own size actually needs. Left at its
 * construction-time position, any model whose bounding-sphere radius
 * exceeds that default's own ~7-unit magnitude would contain the light
 * outright, and even a smaller-but-not-tiny model would put casters behind
 * the shadow camera's near plane — the same "silently drops the shadow"
 * failure this function exists to fix at the frustum's own scale, just
 * caused by the light instead of the frustum.
 *
 * Also repoints `light.target` at the box's center — `viewport.ts` adds the
 * key light's target to the scene at construction specifically so this has
 * somewhere to point it; a `DirectionalLight`'s shadow camera looks from
 * `light.position` toward `light.target.position`, so the target has to
 * track whatever's actually in frame for the shadow to land on it.
 *
 * No-op if `box` is empty (nothing loaded yet).
 */
export function fitShadowCamera(
  light: THREE.DirectionalLight,
  box: THREE.Box3,
  opts: FitShadowCameraOptions = {},
): void {
  if (box.isEmpty()) return;
  const padding = opts.padding ?? 0.25;
  const center = box.getCenter(new THREE.Vector3());
  // The real bounding-SPHERE radius, not half the longest box dimension —
  // half-dimension under-covers a box's own corners (a cube's true
  // circumscribing radius is ~0.866x its half-dimension), which is exactly
  // the "corner geometry clips despite padding" failure this fixes.
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.001) * (1 + padding);

  // Preserve the light's current direction from its target (its already-set
  // position encodes an artistic choice — "upper right front" for the
  // default [3, 5, 4] — that should survive regardless of model scale);
  // only the DISTANCE changes, to keep the light outside the model at any
  // size. Falls back to a fixed direction only in the degenerate case where
  // light and target already coincide (nothing to normalize).
  const direction = light.position.clone().sub(light.target.position);
  if (direction.lengthSq() < 1e-8) direction.set(1, 1, 1);
  direction.normalize();
  const distance = radius * 2;
  light.position.copy(center).addScaledVector(direction, distance);
  light.target.position.copy(center);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();

  const cam = light.shadow.camera;
  cam.left = -radius;
  cam.right = radius;
  cam.top = radius;
  cam.bottom = -radius;
  // near/far span the light's own distance from the model plus the model's
  // own depth, generously padded — too tight clips the shadow, too loose
  // just wastes depth precision, not correctness.
  cam.near = 0.5;
  cam.far = distance + radius;
  cam.updateProjectionMatrix();
}

export interface ShadowCatcherOptions {
  /** Default `0.35`. */
  opacity?: number;
  /** Multiplier over the model's footprint (matches `viewport.ts`'s `'auto'`-grid sizing logic, `gridSize = footprint * 2`). Default `2`. */
  sizeFactor?: number;
}

const DEFAULT_SHADOW_CATCHER_OPTIONS: Required<ShadowCatcherOptions> = {
  opacity: 0.35,
  sizeFactor: 2,
};

/**
 * A `y` offset below `box.min.y`, scaled to the model's own size rather
 * than a fixed constant — `setSceneBounds`'s `'auto'` grid sits exactly at
 * `box.min.y` (`viewport.ts`), so an un-offset catcher would be perfectly
 * coplanar with it and z-fight. Scaling with the box keeps the offset
 * visually negligible (the catcher still reads as "at the model's base")
 * across wildly different model scales, where a fixed epsilon would either
 * be invisible on a huge model or comically far below a tiny one.
 */
function catcherYOffset(box: THREE.Box3): number {
  const size = box.getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z, 0.001) * 0.001;
}

function catcherSize(box: THREE.Box3, sizeFactor: number): number {
  const size = box.getSize(new THREE.Vector3());
  const footprint = Math.max(size.x, size.z, 0.001);
  return footprint * sizeFactor;
}

/** A flat, shadow-only plane (`THREE.ShadowMaterial` — invisible except where a shadow falls on it) sized and positioned to sit just under `box`. No-op-safe to call with an empty `box`: sizes to the `0.001` floor rather than throwing or producing a zero-size plane. */
export function createShadowCatcher(box: THREE.Box3, opts: ShadowCatcherOptions = {}): THREE.Mesh {
  const { opacity, sizeFactor } = { ...DEFAULT_SHADOW_CATCHER_OPTIONS, ...opts };
  const size = catcherSize(box, sizeFactor);
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShadowMaterial({ opacity });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.position.y = box.isEmpty() ? 0 : box.min.y - catcherYOffset(box);
  return mesh;
}

/** Resizes/repositions an existing catcher (from `createShadowCatcher`) to a new `box` — disposes and replaces its geometry (a plane's size isn't mutable in place) but keeps the same `THREE.Mesh`/material instance, so a caller holding a scene reference to it doesn't need to re-add it. */
export function updateShadowCatcher(
  catcher: THREE.Mesh,
  box: THREE.Box3,
  opts: ShadowCatcherOptions = {},
): void {
  const { opacity, sizeFactor } = { ...DEFAULT_SHADOW_CATCHER_OPTIONS, ...opts };
  const size = catcherSize(box, sizeFactor);
  catcher.geometry.dispose();
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  catcher.geometry = geometry;
  (catcher.material as THREE.ShadowMaterial).opacity = opacity;
  catcher.position.y = box.isEmpty() ? catcher.position.y : box.min.y - catcherYOffset(box);
}
