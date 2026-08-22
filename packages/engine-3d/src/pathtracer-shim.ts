import type * as THREE from 'three';

/**
 * The **only** file in this package that mentions `three-gpu-pathtracer`.
 *
 * Two deliberate choices:
 *
 * 1. **Hand-declared types, never `import type` from the real package.**
 *    Phase 0's probe (see `render-quality-proposal.md`'s Phase 0a) measured
 *    zero real damage from that package's ambient `MeshStandardMaterial`
 *    augmentation in this codebase — every existing usage is a type
 *    assertion, never an object literal typed as `MeshStandardMaterial`,
 *    and `skipLibCheck: true` is already set everywhere. So this isn't
 *    containing a measured risk; it's cheap hygiene that keeps the rest of
 *    the package's compile graph from ever transitively depending on the
 *    real package's types at all, even by accident through a stray
 *    `import type` years from now.
 * 2. **A literal dynamic-import specifier**, not a computed one. An
 *    earlier revision of this design tried to also hide the import from
 *    TypeScript's *type* resolution via `import(someVariable)` — that
 *    doesn't survive Vite: a non-literal specifier is opaque to Vite's
 *    import analysis and to Rollup, so the browser gets an unresolvable
 *    bare specifier at runtime. A literal `await import('three-gpu-pathtracer')`
 *    is what Vite actually code-splits, which is the real lazy-load
 *    benefit this file exists to provide.
 */

export interface PathTracerLike {
  readonly samples: number;
  renderDelay: number;
  minSamples: number;
  fadeDuration: number;
  dynamicLowRes: boolean;
  lowResScale: number;
  pausePathTracing: boolean;
  setScene(scene: THREE.Scene, camera: THREE.Camera): void;
  setCamera(camera: THREE.Camera): void;
  updateCamera(): void;
  renderSample(): void;
  reset(): void;
  dispose(): void;
}

export interface PhysicalCameraLike extends THREE.PerspectiveCamera {
  focusDistance: number;
  fStop: number;
  bokehSize: number;
}

export interface PathTracerModule {
  WebGLPathTracer: new (renderer: THREE.WebGLRenderer) => PathTracerLike;
  PhysicalCamera: new (fov?: number, aspect?: number, near?: number, far?: number) => PhysicalCameraLike;
}

/**
 * Loads `three-gpu-pathtracer`, or throws (a missing optional peer
 * dependency, or any other import failure) — callers that need to
 * distinguish "not installed" from "actually broken" should use
 * `isPhotoModeAvailable()` first.
 */
export async function importPathTracer(): Promise<PathTracerModule> {
  const mod = await import('three-gpu-pathtracer');
  return mod as unknown as PathTracerModule;
}

/** Whether `three-gpu-pathtracer` is installed and importable — a host uses this to hide the photo-mode UI row when its optional dependency is absent, rather than surfacing a raw import failure. */
export async function isPhotoModeAvailable(): Promise<boolean> {
  try {
    await importPathTracer();
    return true;
  } catch {
    return false;
  }
}
