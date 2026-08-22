import type * as THREE from 'three';
import type { RenderPath } from './render-path.js';
import type { Viewport } from './viewport.js';
import { importPathTracer, isPhotoModeAvailable, type PathTracerLike } from './pathtracer-shim.js';

export { isPhotoModeAvailable };

/**
 * A small UI-facing projection derived from the path tracer's own live
 * state — not independently-tracked state that could drift from it.
 * `'off'`/`'loading'` are session-level concepts (there's no
 * `PhotoModeController` to ask before `createPhotoMode()` resolves); a
 * live controller only ever reports `'tracing'`/`'converged'`.
 */
export type PhotoModePhase = 'off' | 'loading' | 'tracing' | 'converged';

export interface PhotoModeOptions {
  /**
   * UI-facing "looks fully converged" sample count — distinct from the
   * library's own `minSamples` (the minimum before the traced image starts
   * fading in over the rasterized fallback at all). Default `64`.
   */
  targetSamples?: number;
  /** Passed straight through to `WebGLPathTracer.renderDelay` — ms of camera idle before accumulation (re)starts after a reset. Default `100` (the library's own default). */
  renderDelay?: number;
  /** `WebGLPathTracer.minSamples`. Default `5` (the library's own default). */
  minSamples?: number;
  /** `WebGLPathTracer.fadeDuration`, ms. Default `500` (the library's own default). */
  fadeDuration?: number;
  dynamicLowRes?: boolean;
  lowResScale?: number;
}

export interface PhotoModeController extends RenderPath {
  /** `'tracing'` while accumulating below `targetSamples`, `'converged'` at or above it. */
  readonly phase: 'tracing' | 'converged';
  readonly samples: number;
  setOptions(next: PhotoModeOptions): void;
}

function applyPhotoModeOptions(pathTracer: PathTracerLike, opts: PhotoModeOptions): void {
  pathTracer.renderDelay = opts.renderDelay ?? 100;
  pathTracer.minSamples = opts.minSamples ?? 5;
  pathTracer.fadeDuration = opts.fadeDuration ?? 500;
  pathTracer.dynamicLowRes = opts.dynamicLowRes ?? false;
  pathTracer.lowResScale = opts.lowResScale ?? 0.25;
}

/**
 * Builds the `photo` tier. Async, unlike every other render-tier
 * constructor in this package — `three-gpu-pathtracer` is lazy-loaded (see
 * `pathtracer-shim.ts`); that's what the caller shouldn't block on
 * synchronously. `session.ts`'s `setPhotoMode()` is correspondingly the
 * only async setter among the render tiers. The BVH build itself
 * (`setScene`) is synchronous — see that call's own comment for why.
 *
 * Swaps in a `PhysicalCamera` for true depth-of-field/aperture (it `extends
 * PerspectiveCamera`, so `Viewport.setCamera()` accepts it directly),
 * matching the outgoing camera's basic framing (fov/aspect/near/far,
 * position, orientation, zoom) so the transition isn't a visible jump cut.
 * `dispose()` swaps the original camera back.
 *
 * The headline requirement — "instantly reverts to real-time rendering the
 * moment the camera moves" — needs no state machine: `WebGLPathTracer`'s
 * own `rasterizeScene`/`renderDelay`/`minSamples`/`fadeDuration` already
 * implement exactly that (rasterized fallback below `minSamples`, crossfade
 * over `fadeDuration` once past `renderDelay`), and `updateCamera()`
 * — wired to `viewport.controls`' `change` event — calls the library's own
 * `reset()` internally. `render()` is correspondingly just one call to
 * `renderSample()`; `WebGLPathTracer.renderToCanvas` (on by default)
 * composites its own output directly, so there's nothing else to draw.
 */
export async function createPhotoMode(
  viewport: Viewport,
  opts: PhotoModeOptions = {},
): Promise<PhotoModeController> {
  const { WebGLPathTracer, PhysicalCamera } = await importPathTracer();
  const pathTracer = new WebGLPathTracer(viewport.renderer);
  applyPhotoModeOptions(pathTracer, opts);
  let targetSamples = opts.targetSamples ?? 64;

  // Known residual gap: if photo mode is already active when this runs
  // (setPhotoMode() called again while `phase` is 'tracing'/'converged'),
  // `original` captures the PREVIOUS controller's own `physicalCamera`,
  // not the true pre-photo-mode camera — this function has no way to tell
  // "the current camera" apart from "a stray PhysicalCamera some earlier
  // photo session installed" from viewport.camera alone. Viewport's own
  // setRenderPath() -> setCamera() relay (see its doc comment) still keeps
  // whichever camera the controls actually drive in sync with whatever
  // renders, so the view itself won't freeze or desync across the swap —
  // but the camera object the session eventually settles back on for the
  // flat tier may end up being one of these intermediate PhysicalCameras
  // rather than the session's original THREE.PerspectiveCamera. A full fix
  // needs a session-level "true original camera" reference independent of
  // any one controller's own closure, threaded in rather than read off
  // viewport.camera here.
  const original = viewport.camera;
  const physicalCamera = new PhysicalCamera(original.fov, original.aspect, original.near, original.far);
  physicalCamera.position.copy(original.position);
  physicalCamera.quaternion.copy(original.quaternion);
  physicalCamera.zoom = original.zoom;
  physicalCamera.updateProjectionMatrix();

  // The synchronous setScene(), not setSceneAsync() — the async variant's
  // generateAsync() throws unless setBVHWorker() was called first (a real
  // Web Worker for BVH construction, which three-mesh-bvh ships but which
  // this package doesn't wire up — a genuinely broken combination, caught
  // via browser verification, not something noticed reading the .d.ts).
  // Building a BVH synchronously for one small game-asset mesh (the actual
  // scale every consumer of this package works at) is fast enough not to
  // need offloading to begin with.
  pathTracer.setScene(viewport.scene, physicalCamera);

  const onControlsChange = (): void => {
    pathTracer.updateCamera();
  };
  viewport.controls.addEventListener('change', onControlsChange);

  let disposed = false;
  // Tracks whichever camera the path tracer is actually pointed at right
  // now, so invalidateSceneContents() below can rebuild against the right
  // one — starts as `physicalCamera`, but `setCamera()` can repoint it.
  let currentCamera: THREE.PerspectiveCamera = physicalCamera;

  const controller: PhotoModeController = {
    get phase() {
      return pathTracer.samples >= targetSamples ? 'converged' : 'tracing';
    },
    get samples() {
      return pathTracer.samples;
    },
    render() {
      pathTracer.renderSample();
    },
    setCamera(next) {
      currentCamera = next;
      pathTracer.setCamera(next);
    },
    setOptions(next) {
      applyPhotoModeOptions(pathTracer, next);
      targetSamples = next.targetSamples ?? targetSamples;
    },
    // Scene geometry/materials changed underneath the path tracer's BVH —
    // rebuild it the same way construction did. WebGLPathTracer.setScene()
    // (real library source, confirmed by reading it) internally resets
    // accumulated samples too (each of updateCamera/updateMaterials/
    // updateEnvironment/updateLights calls its own reset()), so a fresh
    // accumulation correctly starts over the new contents.
    invalidateSceneContents() {
      pathTracer.setScene(viewport.scene, currentCamera);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      viewport.controls.removeEventListener('change', onControlsChange);
      pathTracer.dispose();
      viewport.setCamera(original);
    },
  };

  viewport.setCamera(physicalCamera);
  return controller;
}
