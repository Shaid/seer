import { createViewport, type Viewport, type ViewportOptions } from './viewport.ts';
import { createAnimationController, type AnimationController } from './animation.ts';
import { applyRenderMode, defaultRenderMode, type RenderMode } from './render-modes.ts';
import { recolorPolygonModel } from './polygon.ts';
import type { ColorMode, ColorResolver } from './color-modes.ts';
import { fitCameraToObject } from './camera-fit.ts';
import { disposeObject3D } from './dispose.ts';
import { meshStats, type MeshStats } from './stats.ts';
import type { Model3D } from './types.ts';
import * as THREE from 'three';

export type MeshSessionOptions = ViewportOptions;

export interface SetModelOptions {
  /** Frame the camera on the new model right after setting it. Default `true`. */
  fit?: boolean;
  /** Initial render mode. Defaults to `defaultRenderMode(model)`. */
  renderMode?: RenderMode;
}

/**
 * The orchestrator replacing flower's `MeshViewerState` / hunter's
 * module-global `scene`/`selectedObject` bookkeeping — one viewport, the
 * currently-active model (if any), and its animation controller (if any),
 * with the same in-flight-guard shape both hosts already use (`if
 * (session.disposed) return;`, same as today's `if (meshState !== state)
 * return;`).
 */
export interface MeshSession {
  readonly viewport: Viewport;
  /** The model set via `setModel` — `null` before the first call, or after `dispose()`. Does not reflect models added via `addModel` (a session can have many of those with no single "the" model). */
  readonly model: Model3D | null;
  readonly animation: AnimationController | null;
  readonly renderMode: RenderMode | null;
  readonly disposed: boolean;
  /**
   * Replaces the session's entire contents with `model`: disposes and
   * removes whatever was previously shown (both a prior `setModel` and any
   * `addModel`-added models), wires up its `AnimationController` if it has
   * clips, applies the initial render mode, and (by default) fits the
   * camera to it.
   */
  setModel(model: Model3D, opts?: SetModelOptions): void;
  /**
   * Adds `model` alongside whatever's already in the session without
   * disturbing it — the placed-scene case, where many models share one
   * session (`loadPlacedScene` builds raw placed instances directly; this
   * is for a host that's built several independent `Model3D`s of its own
   * and wants them all visible together).
   */
  addModel(model: Model3D): void;
  /** Switches `model`'s render mode. No-op if no model is set. */
  setRenderMode(mode: RenderMode): void;
  /** Recolors `model`'s polygon faces (a no-op for a glTF-sourced model — see `recolorPolygonModel`). No-op if no model is set. */
  setColorMode(mode: ColorMode, resolver?: ColorResolver): void;
  /** Re-frames the camera on everything currently in `viewport.root`. */
  fit(): void;
  /** Vertex/triangle counts for everything currently visible in `viewport.root`. */
  stats(): MeshStats;
  /** Disposes every model ever added, the animation controller, and the viewport itself. Idempotent. */
  dispose(): void;
}

export function createMeshSession(container: HTMLElement, opts: MeshSessionOptions = {}): MeshSession {
  const viewport = createViewport(container, opts);
  const trackedModels: Model3D[] = [];

  let model: Model3D | null = null;
  let animation: AnimationController | null = null;
  let renderMode: RenderMode | null = null;
  let disposed = false;

  const clearTracked = () => {
    for (const tracked of trackedModels) {
      viewport.root.remove(tracked.object);
      disposeObject3D(tracked.object);
    }
    trackedModels.length = 0;
  };

  viewport.setOnFrame((delta) => {
    animation?.update(delta);
  });

  const session: MeshSession = {
    get viewport() {
      return viewport;
    },
    get model() {
      return model;
    },
    get animation() {
      return animation;
    },
    get renderMode() {
      return renderMode;
    },
    get disposed() {
      return disposed;
    },

    setModel(next, setOpts = {}) {
      if (disposed) return;

      animation?.dispose();
      animation = null;

      clearTracked();
      model = next;
      trackedModels.push(next);
      viewport.root.add(next.object);

      renderMode = setOpts.renderMode ?? defaultRenderMode(next);
      applyRenderMode(next, renderMode);

      if (next.animations.length > 0) {
        animation = createAnimationController(next.object, next.animations);
      }

      if (setOpts.fit ?? true) session.fit();
    },

    addModel(next) {
      if (disposed) return;
      trackedModels.push(next);
      viewport.root.add(next.object);
    },

    setRenderMode(mode) {
      if (disposed || !model) return;
      renderMode = mode;
      applyRenderMode(model, mode);
    },

    setColorMode(mode, resolver) {
      if (disposed || !model) return;
      recolorPolygonModel(model, mode, resolver);
    },

    fit() {
      if (disposed) return;
      const box = new THREE.Box3().setFromObject(viewport.root);
      fitCameraToObject(viewport.camera, viewport.controls, viewport.root);
      viewport.setGridBounds(box);
    },

    stats() {
      return meshStats(viewport.root);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      animation?.dispose();
      animation = null;
      clearTracked();
      model = null;
      renderMode = null;
      viewport.dispose();
    },
  };

  return session;
}
