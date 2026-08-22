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
      pathTracer.setCamera(next);
    },
    setOptions(next) {
      applyPhotoModeOptions(pathTracer, next);
      targetSamples = next.targetSamples ?? targetSamples;
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
