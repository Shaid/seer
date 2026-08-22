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
import { enableModelShadows } from './shadows.js';
import type { ShadowOptions } from './shadows.js';
import { createCinematicPath, cinematicPlansEqual, planCinematicPasses, applyToneMapping } from './postprocessing.js';
import type { CinematicOptions, CinematicPath } from './postprocessing.js';
import { createPhotoMode } from './photo-mode.js';
import type { PhotoModeOptions, PhotoModeController, PhotoModePhase } from './photo-mode.js';
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
  /** Whether shadow-casting is on. Persists across `setModel` calls — a viewer-wide preference, like `textureFilter`, not a per-model one (the *materials* that make shadows visible are per-model, so every `setModel`/`addModel` re-applies `castShadow`/`receiveShadow` to the new model's meshes whenever this is `true`). */
  readonly shadows: boolean;
  /** `false`, or the options the `cinematic` render tier is currently active with. Persists across `setModel` calls — viewport-scoped, like `shadows`, not a per-model property. */
  readonly cinematic: false | CinematicOptions;
  /** `'off'` / `'loading'` (constructing — `three-gpu-pathtracer` is lazy-loaded) / `'tracing'` / `'converged'`. See `setPhotoMode()`. */
  readonly photoMode: PhotoModePhase;
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
  /**
   * Toggles shadow-casting — thin delegation to `viewport.setShadows()`
   * (see its doc comment for what enabling this actually changes: a
   * shadow map, the key light casting, a shadow-catcher plane, AND dimmed
   * ambient light). Also applies `enableModelShadows()` to the currently
   * loaded model immediately, and to every subsequently `setModel`/
   * `addModel`-ed one automatically — a freshly-loaded mesh doesn't
   * inherit `castShadow`/`receiveShadow` from anywhere else.
   */
  setShadows(opts: boolean | ShadowOptions): void;
  /**
   * Switches the `cinematic` render tier on/off, or updates its options
   * while already on — thin delegation to `viewport.setRenderPath()`.
   * `false` restores the plain `flat` renderer. Installing `cinematic`
   * implicitly replaces whichever other render tier (e.g. a future `photo`
   * mode) was previously installed — mutual exclusivity is enforced by
   * `Viewport`'s single `renderPath` slot, not re-implemented here.
   *
   * Changing only numeric option values (bloom strength, AO radius, ...)
   * while the pass composition stays the same updates the existing
   * `EffectComposer` chain's uniforms in place, via `CinematicPath.setOptions()`
   * — three.js has no supported way to insert/remove a pass from a live
   * composer, so a shape change (an effect toggled on/off, the antialias
   * strategy changed) instead disposes the old chain and builds a fresh
   * one; see `postprocessing.ts`'s `cinematicPlansEqual`.
   */
  setCinematic(opts: false | CinematicOptions): void;
  /**
   * Switches the `photo` render tier on/off — like `setCinematic`, thin
   * delegation to `viewport.setRenderPath()`, mutually exclusive with it
   * for the same reason. **Async**, unlike every other setter here:
   * `three-gpu-pathtracer` is lazy-loaded and building its BVH over the
   * current scene takes real time, so `session.photoMode` reports
   * `'loading'` for the duration. Safe to call again (including with
   * `false`) before a previous call resolves — the superseded call's
   * result is discarded rather than clobbering whatever's active by the
   * time it finishes; the same applies if `setCinematic()` claims the
   * render-tier slot while a `setPhotoMode()` call is still in flight.
   */
  setPhotoMode(opts: false | PhotoModeOptions): Promise<void>;
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
  let shadows = false;
  let cinematic: false | CinematicOptions = false;
  let cinematicPath: CinematicPath | null = null;
  let photoModeController: PhotoModeController | null = null;
  let photoModeLoading = false;
  let photoModeGeneration = 0;
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

  /** Reapplies render mode + shading together — the pair `render-modes.ts`/`mesh-shading.ts` must stay in sync on (shading defers to render mode for wireframe/points). Does not touch geometry. Invalidates any render-tier state built over the model's materials (a path tracer's BVH/material data) — covers `setRenderMode`/`setShading`/`setModel` directly, and `refreshPolish` transitively (it always calls this after rebuilding geometry), so neither of those needs its own separate call. */
  const refreshAppearance = () => {
    if (disposed || !model) return;
    applyRenderMode(model, renderMode!);
    applyMeshShading(model, shadingCache, { shading, smooth, renderMode: renderMode! });
    viewport.invalidateSceneContents();
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

  /** Recomputes the bounds of everything currently in `viewport.root` and reports them to the viewport — the single hook that keeps the auto-grid, and (when shadows are on) the shadow-camera frustum and shadow-catcher plane, fit to whatever's actually loaded. Called from both `setModel` (unconditionally, even when `fit: false`) and `fit()` — `setModel` doesn't route through `session.fit()` for this, so the box isn't computed twice when both need it. */
  const updateSceneBounds = (): THREE.Box3 => {
    const box = new THREE.Box3().setFromObject(viewport.root);
    viewport.setSceneBounds(box);
    return box;
  };

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
    get shadows() {
      return shadows;
    },
    get cinematic() {
      return cinematic;
    },
    get photoMode() {
      if (photoModeController) return photoModeController.phase;
      return photoModeLoading ? 'loading' : 'off';
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
      if (shadows) enableModelShadows(next.object);

      renderMode = setOpts.renderMode ?? defaultRenderMode(next);
      refreshAppearance();
      applyTextureFilter(next, textureFilter, session.getMaxAnisotropy());

      if (next.animations.length > 0) {
        animation = createAnimationController(next.object, next.animations);
      }

      updateSceneBounds();
      if (setOpts.fit ?? true) fitCameraToObject(viewport.camera, viewport.controls, viewport.root);
    },

    addModel(next) {
      if (disposed) return;
      trackedModels.push(next);
      viewport.root.add(next.object);
      if (shadows) enableModelShadows(next.object);
      viewport.invalidateSceneContents();
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
      viewport.invalidateSceneContents();
    },

    setShadows(opts) {
      shadows = opts !== false;
      if (disposed) return;
      viewport.setShadows(opts);
      for (const tracked of trackedModels) {
        enableModelShadows(tracked.object, { cast: shadows, receive: shadows });
      }
    },

    setCinematic(opts) {
      if (disposed) return;
      // Bumped on every call (not just a photoModeController-clearing one)
      // so an in-flight setPhotoMode() can never mistake this session's
      // intent for "still current" via an ABA on viewport.renderPath alone
      // — e.g. setPhotoMode({}) (renderPath null while pending) racing
      // against setCinematic(opts) then setCinematic(false), which leaves
      // renderPath null again by the time the photo controller resolves.
      // Without this, the pathBeforeAwait/renderPath comparison in
      // setPhotoMode() below would see "unchanged" and let a stale
      // controller install anyway.
      photoModeGeneration++;

      if (opts === false) {
        cinematic = false;
        // Only clear the slot if cinematic is actually the thing holding
        // it — a photo-mode controller could be active instead, and
        // unconditionally clearing here would tear that down too.
        if (cinematicPath && viewport.renderPath === cinematicPath) {
          viewport.setRenderPath(null);
          // CinematicPath.dispose() deliberately doesn't reset
          // renderer.toneMapping itself (see its doc comment — resetting
          // there would race with a replacement path's own
          // applyToneMapping() call when swapping between two cinematic
          // configurations). Going back to flat has no replacement path
          // to set it, so this is the one place that has to.
          applyToneMapping(viewport.renderer, false);
        }
        cinematicPath = null;
        return;
      }

      // Reuse the live composer chain when only numeric option values
      // changed and it's still actually installed (nothing else — a
      // photo-mode controller taking over via setPhotoMode() — stole the
      // RenderPath slot out from under it since the last call).
      if (
        cinematicPath &&
        cinematic !== false &&
        viewport.renderPath === cinematicPath &&
        cinematicPlansEqual(planCinematicPasses(cinematic), planCinematicPasses(opts))
      ) {
        cinematicPath.setOptions(opts);
        cinematic = opts;
        return;
      }

      const path = createCinematicPath(viewport.renderer, viewport.scene, viewport.camera, opts);
      viewport.setRenderPath(path);
      cinematicPath = path;
      cinematic = opts;
      // Cinematic now owns the render-tier slot — a stale reference here
      // would otherwise make session.photoMode keep reporting a phase for
      // a controller viewport.setRenderPath() just disposed.
      photoModeController = null;
      photoModeLoading = false;
    },

    setPhotoMode(opts) {
      if (disposed) return Promise.resolve();
      const generation = ++photoModeGeneration;

      if (opts === false) {
        photoModeLoading = false;
        if (photoModeController) {
          if (viewport.renderPath === photoModeController) viewport.setRenderPath(null);
          photoModeController.dispose();
          photoModeController = null;
        }
        return Promise.resolve();
      }

      // Captured before awaiting so the continuation can tell whether
      // something else (setCinematic(), or a newer setPhotoMode() call)
      // claimed the render-tier slot while construction was in flight.
      const pathBeforeAwait = viewport.renderPath;
      photoModeLoading = true;

      return createPhotoMode(viewport, opts).then(
        (controller) => {
          const superseded = disposed || generation !== photoModeGeneration || viewport.renderPath !== pathBeforeAwait;
          if (superseded) {
            controller.dispose();
            if (!disposed && generation === photoModeGeneration) photoModeLoading = false;
            return;
          }
          photoModeLoading = false;
          photoModeController = controller;
          viewport.setRenderPath(controller);
          // Photo mode now owns the render-tier slot — same staleness
          // reasoning as setCinematic() clearing photoModeController.
          cinematic = false;
          cinematicPath = null;
          // A second "nothing replaces it" exit from cinematic, alongside
          // setCinematic(false) — CinematicPath.dispose() deliberately
          // leaves renderer.toneMapping alone (see its doc comment), and
          // PhotoModeController never sets one either (its rasterized
          // fallback goes through renderer.render() too, so a stale ACES
          // setting here would leak into that fallback image, then into the
          // flat tier if setPhotoMode(false) follows without cinematic ever
          // being re-selected in between).
          applyToneMapping(viewport.renderer, false);
        },
        (err) => {
          if (generation === photoModeGeneration) photoModeLoading = false;
          throw err;
        },
      );
    },

    fit() {
      if (disposed) return;
      updateSceneBounds();
      fitCameraToObject(viewport.camera, viewport.controls, viewport.root);
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
      // Explicit, ahead of viewport.dispose() — PhotoModeController.dispose()
      // is idempotent, so this is safe even though viewport.dispose() would
      // also reach it transitively (via renderPath?.dispose()) whenever
      // photoModeController is in fact the installed path.
      photoModeController?.dispose();
      photoModeController = null;
      viewport.dispose();
    },
  };

  return session;
}
