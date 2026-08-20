import { createViewport, type Viewport, type ViewportOptions } from './viewport.js';
import { createAnimationController, type AnimationController } from './animation.js';
import { applyRenderMode, defaultRenderMode, type RenderMode } from './render-modes.js';
import {
  applyMeshShading,
  clearGeneratedShadingMaterials,
  type MeshShadingMode,
  type GeneratedShadingMaterials,
} from './mesh-shading.js';
import {
  applyMeshPolish,
  captureOriginalGeometry,
  disposeOriginalGeometry,
  type OriginalGeometryCache,
} from './mesh-polish.js';
import { applyTextureFilter, type TextureFilterOptions } from './texture-filter.js';
import { recolorPolygonModel } from './polygon.js';
import type { ColorMode, ColorResolver } from './color-modes.js';
import { fitCameraToObject } from './camera-fit.js';
import { disposeObject3D } from './dispose.js';
import { meshStats, type MeshStats } from './stats.js';
import type { Model3D } from './types.js';
import * as THREE from 'three';

export type MeshSessionOptions = ViewportOptions;

/** Session-wide default until a host calls `setTextureFilter` — matches three.js's own out-of-the-box texture defaults (trilinear, no anisotropy), so adding this feature changes no existing viewer's rendered appearance until the host opts in. */
const DEFAULT_TEXTURE_FILTER: TextureFilterOptions = { mode: 'trilinear', anisotropy: 1 };

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
  /** Shading override layered on top of `renderMode`. Reset to `'lit'` on every `setModel`. */
  readonly shading: MeshShadingMode;
  /** Whether normals are averaged across coincident vertices (smooth) or left per-face (flat/faceted). Reset to `false` on every `setModel`. */
  readonly smooth: boolean;
  /** Current subdivision intensity (`0` = original geometry, unsubdivided). Reset to `0` on every `setModel`. */
  readonly subdivision: number;
  /** Current texture filter. Persists across `setModel` calls — a viewer-wide preference, not a per-model one. */
  readonly textureFilter: TextureFilterOptions;
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
  /** Switches `model`'s shading override (see `MeshShadingMode`). No-op if no model is set or the model isn't glTF-sourced. */
  setShading(mode: MeshShadingMode): void;
  /** Toggles smooth vs. flat/faceted normals — rebuilds geometry from the captured original at the current `subdivision` level, so it reflects immediately. No-op if no model is set or the model isn't glTF-sourced. */
  setSmooth(smooth: boolean): void;
  /** Sets subdivision intensity (`0` = original geometry). Rebuilds geometry from the captured original — see `mesh-polish.ts`'s `subdivideGeometry` for what the value means. No-op if no model is set or the model isn't glTF-sourced. */
  setSubdivision(multiplier: number): void;
  /** Sets the texture filter/anisotropy applied to `model`'s original materials — persists across future `setModel` calls until changed again. No-op (but still remembered for the next model) if no model is set or the model isn't glTF-sourced. */
  setTextureFilter(options: TextureFilterOptions): void;
  /** The renderer's `getMaxAnisotropy()` — the ceiling a host's anisotropy control should clamp its own range to. */
  getMaxAnisotropy(): number;
  /** Recolors `model`'s polygon faces (a no-op for a glTF-sourced model — see `recolorPolygonModel`). No-op if no model is set. */
  setColorMode(mode: ColorMode, resolver?: ColorResolver): void;
  /** Re-frames the camera on everything currently in `viewport.root`. */
  fit(): void;
  /** Vertex/triangle counts for everything currently visible in `viewport.root`. */
  stats(): MeshStats;
  /** Disposes every model ever added, the animation controller, and the viewport itself. Idempotent. */
  dispose(): void;
}

export function createMeshSession(
  container: HTMLElement,
  opts: MeshSessionOptions = {},
): MeshSession {
  const viewport = createViewport(container, opts);
  const trackedModels: Model3D[] = [];

  let model: Model3D | null = null;
  let animation: AnimationController | null = null;
  let renderMode: RenderMode | null = null;
  let shading: MeshShadingMode = 'lit';
  let smooth = false;
  let subdivision = 0;
  let textureFilter: TextureFilterOptions = { ...DEFAULT_TEXTURE_FILTER };
  let disposed = false;

  const shadingCache: GeneratedShadingMaterials = new Map();
  let originalGeometry: OriginalGeometryCache = new Map();

  const clearTracked = () => {
    for (const tracked of trackedModels) {
      viewport.root.remove(tracked.object);
      disposeObject3D(tracked.object);
    }
    trackedModels.length = 0;
  };

  /** Reapplies render mode + shading together — the pair `render-modes.ts`/`mesh-shading.ts` must stay in sync on (shading defers to render mode for wireframe/points). Does not touch geometry. */
  const refreshAppearance = () => {
    if (disposed || !model) return;
    applyRenderMode(model, renderMode!);
    applyMeshShading(model, shadingCache, { shading, smooth, renderMode: renderMode! });
  };

  /** Rebuilds geometry from `originalGeometry` at the current subdivision/smooth settings, then refreshes appearance — mirrors what a render-mode-only change does, but geometry changes need the rebuild first. */
  const refreshPolish = () => {
    if (disposed || !model) return;
    applyMeshPolish(model, originalGeometry, { subdivision, smooth });
    refreshAppearance();
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
    get shading() {
      return shading;
    },
    get smooth() {
      return smooth;
    },
    get subdivision() {
      return subdivision;
    },
    get textureFilter() {
      return textureFilter;
    },
    get disposed() {
      return disposed;
    },

    setModel(next, setOpts = {}) {
      if (disposed) return;

      animation?.dispose();
      animation = null;

      clearTracked();
      clearGeneratedShadingMaterials(shadingCache);
      disposeOriginalGeometry(originalGeometry);

      model = next;
      shading = 'lit';
      smooth = false;
      subdivision = 0;
      trackedModels.push(next);
      viewport.root.add(next.object);
      originalGeometry = captureOriginalGeometry(next);

      renderMode = setOpts.renderMode ?? defaultRenderMode(next);
      refreshAppearance();
      applyTextureFilter(next, textureFilter, session.getMaxAnisotropy());

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
      refreshAppearance();
    },

    setShading(mode) {
      if (disposed || !model) return;
      shading = mode;
      refreshAppearance();
    },

    setSmooth(next) {
      if (disposed || !model) return;
      smooth = next;
      refreshPolish();
    },

    setSubdivision(multiplier) {
      if (disposed || !model) return;
      subdivision = multiplier;
      refreshPolish();
    },

    setTextureFilter(options) {
      textureFilter = options;
      if (disposed || !model) return;
      applyTextureFilter(model, options, session.getMaxAnisotropy());
    },

    getMaxAnisotropy() {
      return viewport.renderer.capabilities.getMaxAnisotropy();
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
      clearGeneratedShadingMaterials(shadingCache);
      disposeOriginalGeometry(originalGeometry);
      model = null;
      renderMode = null;
      viewport.dispose();
    },
  };

  return session;
}
