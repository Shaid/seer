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
import {
  createSpringBoneSolver,
  readSpringBoneConfig,
  deriveSpringBonesFromNames,
  excludeAnimatedChains,
  type SpringBoneConfig,
  type SpringBoneSolver,
} from './spring-bones.js';
import type { Model3D } from './types.js';
import * as THREE from 'three';

/**
 * `session.setSpringBones()`'s options. Config resolution order: `config` →
 * the model's own baked `SEER_spring_bones` glTF extras (`readSpringBoneConfig`)
 * → (only if `autoDerive`) a name-pattern guess (`deriveSpringBonesFromNames`)
 * → nothing. See `spring-bones.ts` for why none of this is measured from
 * either requesting game's real data.
 */
export interface SpringBoneOptions {
  config?: SpringBoneConfig;
  /** Falls back to a bone-name guess when neither `config` nor a baked config is present. Off by default — never applied silently, since a wrong guess is worse than no physics. */
  autoDerive?: boolean;
  /** Drops any chain containing a bone the active animation clip already keyframes, so the sim never fights baked cloth/hair motion (flower's Drakengard 3 corpus has both: some clips fully keyframe cape/hair bones, most don't touch them at all). Default `true`. */
  skipAnimatedBones?: boolean;
  fixedStep?: number;
  maxSubSteps?: number;
  strength?: number;
}

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
  /** `false`, or the spring-bone options currently active. Reset to `false` on every `setModel` — a cloth/hair rig is resolved against one specific model's bone names (see `spring-bones.ts` on why a config baked into one GLB isn't portable to another), the same per-model-not-persisted category as `shading`/`smooth`/`subdivision`. */
  readonly springBones: false | SpringBoneOptions;
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
   * and wants them all visible together). Once added, `model` responds to
   * every subsequent `setRenderMode`/`setShading`/`setSmooth`/
   * `setSubdivision`/`setTextureFilter` call exactly like the model set via
   * `setModel` — there is no separate "just added, inert" state.
   */
  addModel(model: Model3D): void;
  /** Switches the render mode of every model currently in the session (both the one set via `setModel` and any added via `addModel`). No-op if no model has ever been set via `setModel`. */
  setRenderMode(mode: RenderMode): void;
  /** Switches the shading override (see `MeshShadingMode`) of every model currently in the session. No-op if no model has ever been set via `setModel`; a no-op per-model for one that isn't glTF-sourced. */
  setShading(mode: MeshShadingMode): void;
  /** Toggles smooth vs. flat/faceted normals for every model currently in the session — rebuilds geometry from each one's captured original at the current `subdivision` level, so it reflects immediately. No-op if no model has ever been set via `setModel`; a no-op per-model for one that isn't glTF-sourced. */
  setSmooth(smooth: boolean): void;
  /** Sets subdivision intensity (`0` = original geometry) for every model currently in the session. Rebuilds geometry from each one's captured original — see `mesh-polish.ts`'s `subdivideGeometry` for what the value means. No-op if no model has ever been set via `setModel`; a no-op per-model for one that isn't glTF-sourced. */
  setSubdivision(multiplier: number): void;
  /** Sets the texture filter/anisotropy applied to every model's original materials — persists across future `setModel`/`addModel` calls until changed again. No-op (but still remembered for future models) if no model has ever been set via `setModel`; a no-op per-model for one that isn't glTF-sourced. */
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
  /**
   * Rebuilds the animation controller for the model set via `setModel` from
   * `clips` instead of that model's own embedded `animations` — for a host
   * that sources motion data from a GLB other than the one it's displaying
   * (e.g. a skeleton-only "action" file exported from the same underlying
   * rig as a mesh-only body file, or — approximately, as a stopgap — a
   * different character's rig that shares enough bone names to produce
   * recognizable motion). `THREE.AnimationMixer` binds each track to the
   * CURRENTLY set model's `Object3D` (`session.model.object`) by node NAME,
   * not identity, so this works whether `clips` came from `model` itself or
   * from an entirely different loaded GLB: a bone name with no match under
   * `model.object` just doesn't animate (three.js logs a `console.warn`,
   * not an error, and every other bound track still plays normally) — see
   * `PropertyBinding.bind()`'s own `"No target node found for track"`
   * fallback.
   *
   * No-op if no model is set via `setModel`. Passing an empty array disposes
   * the current controller (same end state as a model with no clips of its
   * own) rather than leaving a stale one bound to a since-replaced model.
   */
  setExternalAnimations(clips: THREE.AnimationClip[]): void;
  /**
   * Enables (`opts` truthy), reconfigures, or disables (`false`) cloth/hair
   * spring-bone simulation for the model set via `setModel` — see
   * `SpringBoneOptions` for config resolution order. Registers one
   * `viewport.addFrameHook`, which runs after the animation mixer's own
   * `onFrame` update and before the render call, so a simulated bone's
   * rotation composes with (rather than fights) whatever the mixer just
   * wrote — see `spring-bones.ts`'s module doc for the full frame-ordering
   * contract, including why it calls `updateMatrixWorld` itself. No-op if no
   * model is set via `setModel`; re-resolved automatically by
   * `setExternalAnimations` (the animated-bone set `skipAnimatedBones`
   * checks against changes when the clips do).
   */
  setSpringBones(opts: false | SpringBoneOptions): void;
  /**
   * Advances the spring-bone solver by `dt` seconds directly, bypassing the
   * frame hook — for the same reason `Turntable` exposes its own `step()`:
   * `viewport.renderNow()` (the deterministic screenshot/video-export path)
   * deliberately skips every frame hook, so an exporter recording a clip
   * with spring bones active must drive this by hand alongside
   * `session.animation?.update(dt)`. No-op if spring bones aren't active.
   */
  stepSpringBones(dt: number): void;
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
  let springBoneOptions: false | SpringBoneOptions = false;
  let springBoneSolver: SpringBoneSolver | null = null;
  let springBoneUnsubscribe: (() => void) | null = null;
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

  /**
   * Reapplies render mode + shading together — the pair `render-modes.ts`/
   * `mesh-shading.ts` must stay in sync on (shading defers to render mode
   * for wireframe/points). Does not touch geometry. Invalidates any
   * render-tier state built over the model's materials (a path tracer's
   * BVH/material data) — covers `setRenderMode`/`setShading`/`setModel`
   * directly, and `refreshPolish` transitively (it always calls this after
   * rebuilding geometry), so neither of those needs its own separate call.
   *
   * Applies to every model in `trackedModels`, not just the one set via
   * `setModel` — this is what makes an `addModel()`-added piece (e.g. a
   * host compositing a separately-loaded head onto a body) respond to the
   * SAME render-mode/shading toggles as the primary model, instead of
   * being frozen at whatever it looked like when added. Gated on `model`
   * (not `trackedModels.length`) so this stays a no-op for a host that only
   * ever calls `addModel()` and never establishes a primary model via
   * `setModel()` — that host never calls `setRenderMode`/`setShading`
   * either, so the gate is never actually exercised there, but keeping it
   * preserves the documented "no-op before any model is set" contract.
   */
  const refreshAppearance = () => {
    if (disposed || !model) return;
    for (const tracked of trackedModels) {
      applyRenderMode(tracked, renderMode!);
      applyMeshShading(tracked, shadingCache, { shading, smooth, renderMode: renderMode! });
    }
    viewport.invalidateSceneContents();
  };

  /** Rebuilds geometry from `originalGeometry` at the current subdivision/smooth settings, then refreshes appearance — mirrors what a render-mode-only change does, but geometry changes need the rebuild first. Applies to every model in `trackedModels`, same reasoning as `refreshAppearance`; relies on `addModel()` having merged each added model's meshes into `originalGeometry` (see there) so a mesh added after the fact isn't silently skipped as "missing from originalGeometry" (`applyMeshPolish`'s own no-op-for-unknown-mesh behavior). */
  const refreshPolish = () => {
    if (disposed || !model) return;
    for (const tracked of trackedModels) applyMeshPolish(tracked, originalGeometry, { subdivision, smooth });
    refreshAppearance();
  };

  const teardownSpringBones = () => {
    springBoneUnsubscribe?.();
    springBoneUnsubscribe = null;
    springBoneSolver?.dispose();
    springBoneSolver = null;
  };

  /**
   * (Re)builds the spring-bone solver from `springBoneOptions` against the
   * current `model`/`animation` — called on `setSpringBones` itself, and
   * again from `setExternalAnimations` (whose new clips can change which
   * bones `skipAnimatedBones` excludes). Always tears down first: disabling
   * (`springBoneOptions === false`), a config that resolves to nothing, or
   * no model at all should all leave no solver and no dangling frame hook.
   */
  const applySpringBones = () => {
    teardownSpringBones();
    if (!springBoneOptions || !model) return;
    const opts = springBoneOptions;
    let config = opts.config ?? readSpringBoneConfig(model.object);
    if (!config && opts.autoDerive) config = deriveSpringBonesFromNames(model.object);
    if (!config) return;
    if ((opts.skipAnimatedBones ?? true) && animation) {
      config = excludeAnimatedChains(config, animation.animatedNodeNames());
    }
    springBoneSolver = createSpringBoneSolver(model.object, config, {
      fixedStep: opts.fixedStep,
      maxSubSteps: opts.maxSubSteps,
      strength: opts.strength,
    });
    if (springBoneSolver) {
      const solver = springBoneSolver;
      springBoneUnsubscribe = viewport.addFrameHook((dt) => solver.step(dt));
    }
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
    get springBones() {
      return springBoneOptions;
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
      teardownSpringBones();
      springBoneOptions = false;

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
      // Merge this model's meshes into the session-wide original-geometry
      // cache (keyed by mesh, so entries from different models never
      // collide) — a no-op capture (empty map) for a polygon model, but
      // required for a glTF model to respond to a LATER setSmooth()/
      // setSubdivision() call the same way setModel()'s own model does; see
      // `refreshPolish`'s doc comment. Deliberately NOT eagerly re-running
      // applyMeshPolish/applyRenderMode/applyMeshShading on `next` here: at
      // its default state (subdivision 0, smooth off, shading 'lit',
      // render mode 'textured') every one of those is a no-op restore of
      // the model's own native geometry/materials (verified in
      // `render-modes.ts`'s 'textured' branch and `mesh-polish.ts`'s
      // subdivision-0 path), so a freshly-added model already looks
      // correct without touching it — actually applying happens the first
      // time a host calls one of the `set*` methods below, which now
      // reaches every tracked model, not just the primary one.
      for (const [mesh, geometry] of captureOriginalGeometry(next)) originalGeometry.set(mesh, geometry);
      applyTextureFilter(next, textureFilter, session.getMaxAnisotropy());
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
      for (const tracked of trackedModels) applyTextureFilter(tracked, options, session.getMaxAnisotropy());
    },

    getMaxAnisotropy() {
      return viewport.renderer.capabilities.getMaxAnisotropy();
    },

    setColorMode(mode, resolver) {
      if (disposed || !model) return;
      recolorPolygonModel(model, mode, resolver);
      viewport.invalidateSceneContents();
    },

    setExternalAnimations(clips) {
      if (disposed || !model) return;
      animation?.dispose();
      animation = clips.length > 0 ? createAnimationController(model.object, clips) : null;
      // The animated-node set `skipAnimatedBones` excludes against just
      // changed (or vanished, if `clips` is empty) — re-resolve rather than
      // leaving chains filtered against the previous clip's bones.
      if (springBoneOptions) applySpringBones();
    },

    setSpringBones(opts) {
      if (disposed || !model) return;
      springBoneOptions = opts;
      applySpringBones();
    },

    stepSpringBones(dt) {
      springBoneSolver?.step(dt);
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
      teardownSpringBones();
      springBoneOptions = false;
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
