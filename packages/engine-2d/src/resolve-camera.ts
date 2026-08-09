/**
 * Camera resolution, deliberately kept out of `Game.ts`.
 *
 * `Game.ts` imports PixiJS at module scope, and PixiJS reads `navigator`
 * while it initialises — fine in a browser, but `globalThis.navigator` only
 * exists in Node 21 and later. So *importing* anything from `Game.ts` throws
 * `ReferenceError: navigator is not defined` under Node 20, even when the
 * thing being imported is pure logic that never touches PixiJS.
 *
 * That is exactly what happened: the camera-resolution test was written to be
 * DOM-free on purpose, but imported its subject from `Game.ts` and so dragged
 * PixiJS in anyway. It passed only on Node versions new enough to define
 * `navigator`, and failed on the project's own declared floor.
 *
 * Living here, `resolveCamera` is importable from plain Node on any supported
 * version. `Game.ts` re-exports it, so this is not a breaking change.
 */
import type { BaseCamera } from './BaseCamera.js';
import type { DisplayMode } from './DisplayMode.js';
import { TopDownCamera } from './TopDownCamera.js';

/** The subset of `GameOptions` camera resolution actually needs. */
export interface CameraOptions<TCamera extends BaseCamera> {
  /** World size in pixels, used to size the default camera. */
  worldWidth: number;
  worldHeight: number;
  /**
   * Camera to use, or a factory to build one from the initial viewport size
   * and display mode. Omit to get a `TopDownCamera` sized from
   * `worldWidth`/`worldHeight` (the default today).
   */
  camera?: TCamera | ((viewWidth: number, viewHeight: number, displayMode: DisplayMode) => TCamera);
}

/**
 * Resolve the camera to use for a `Game`, given its options and the initial
 * viewport size/display mode. Pure — no PixiJS, no DOM — so the
 * camera-selection logic is unit-testable without spinning up a real
 * `Application`.
 */
export function resolveCamera<TCamera extends BaseCamera>(
  options: CameraOptions<TCamera>,
  viewWidth: number,
  viewHeight: number,
  displayMode: DisplayMode,
): TCamera {
  const { camera } = options;
  if (typeof camera === 'function') {
    return camera(viewWidth, viewHeight, displayMode);
  }
  if (camera) {
    return camera;
  }
  // Default: a TopDownCamera sized from worldWidth/worldHeight, matching
  // today's behavior for consumers that don't pass a `camera` option.
  return new TopDownCamera(
    options.worldWidth,
    options.worldHeight,
    viewWidth,
    viewHeight,
    displayMode,
  ) as unknown as TCamera;
}
