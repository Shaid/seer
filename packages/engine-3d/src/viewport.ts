import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createFrameLimiter, type FrameLimiterOptions } from './frame-limiter.js';
import type { RenderPath } from './render-path.js';
import {
  applyShadowSettings,
  applyLightShadowSettings,
  fitShadowCamera,
  createShadowCatcher,
  updateShadowCatcher,
  type ShadowOptions,
} from './shadows.js';

export type { ShadowOptions } from './shadows.js';

export interface LightConfig {
  color?: THREE.ColorRepresentation;
  intensity?: number;
  position?: [number, number, number];
  /**
   * Only meaningful on the `key` light — see `shadows.ts`'s
   * `ShadowOptions` doc comment for why this field exists on all three
   * light slots uniformly despite that. Sets the light's *initial*
   * shadow-casting state and quality at construction; `Viewport.setShadows()`
   * is the runtime toggle and takes precedence once called.
   */
  castShadow?: boolean;
  shadow?: ShadowOptions;
}

/** All three default to flower's original lighting rig (`viewer.ts:1140-1146`) — set any of them to `false` to omit just that light, or `lights: false` on `ViewportOptions` to omit lighting entirely (a host that wants fully unlit/vertex-color-only rendering, e.g. hunter's polygon models). */
export interface ViewportLights {
  ambient?: LightConfig | false;
  key?: LightConfig | false;
  fill?: LightConfig | false;
}

export interface GridConfig {
  size: number;
  divisions: number;
  color1?: THREE.ColorRepresentation;
  color2?: THREE.ColorRepresentation;
  /** World-space Y the grid plane sits at. Default `0`. */
  y?: number;
}

export interface ViewportOptions {
  /** Scene background color. Default `0x161616` (flower's original). */
  background?: THREE.ColorRepresentation;
  fov?: number;
  near?: number;
  far?: number;
  cameraPosition?: [number, number, number];
  /**
   * `false` omits the grid entirely. A concrete `GridConfig` builds it
   * immediately. `'auto'` defers grid creation until the first
   * `setGridBounds()` call — `session.ts`'s `fit()` calls this right after
   * computing the model's bounds, so the grid ends up sized to whatever was
   * just framed instead of a fixed guess made before any model existed.
   */
  grid?: false | GridConfig | 'auto';
  lights?: false | ViewportLights;
  /** Sets the renderer canvas's CSS `image-rendering` to `pixelated`. Off (smooth-shaded default) unless set — flower's viewport explicitly overrides a project-wide `canvas { image-rendering: pixelated }` rule for its smooth 3D render; a host with the opposite default convention sets this instead. */
  pixelated?: boolean;
  /** `OrbitControls.dampingFactor`. Default `0.12` (flower's original; hunter's is `0.15`). */
  damping?: number;
  /** `false` disables the frame-rate limiter entirely (render every rAF tick). Default: enabled with `createFrameLimiter`'s own defaults. */
  frameLimiter?: FrameLimiterOptions | false;
  /** Called once per rendered frame (post frame-limiter) with the real elapsed seconds since the last rendered frame — `session.ts` wires an `AnimationController.update` here. */
  onFrame?: (deltaSeconds: number) => void;
  /**
   * Enables shadow-casting from the key light at construction — equivalent
   * to calling `setShadows(...)` immediately after `createViewport()`.
   * Default off (`undefined`/`false`), so an existing consumer sees zero
   * behavior change until it opts in. See `Viewport.setShadows()`'s doc
   * comment for what enabling this actually changes (it dims ambient
   * light too, not just shadows appearing).
   */
  shadows?: boolean | ShadowOptions;
}

export interface Viewport {
  scene: THREE.Scene;
  /**
   * The active camera. A getter, not a plain field — `setCamera()` can
   * swap it (for a future photo-mode `PhysicalCamera`), and every reader
   * needs to see the current one, not whatever was live at the time it
   * first read `viewport.camera`. A host that ever *assigned* to this
   * directly (`viewport.camera = x`) needs to switch to `setCamera(x)`.
   */
  readonly camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  /** Every model a host adds goes under here, never directly under `scene` — keeps lights/grid/camera untouched by whatever `disposeObject3D`/`.clear()` a host does when switching models. */
  root: THREE.Group;
  container: HTMLElement;
  /** The key `DirectionalLight`, or `null` if `lights.key` was `false` — `addLights()` otherwise drops the reference entirely. Needed by shadow-frustum fitting (`@seer-project/engine-3d`'s `shadows.ts`); read-only, since replacing it isn't a supported operation (recreate the viewport instead). */
  readonly keyLight: THREE.DirectionalLight | null;
  /** Swaps the active render tier — `null` restores today's plain `renderer.render(scene, camera)`. Disposes whatever *different* path was previously installed (installing the same instance again is a no-op, not a dispose-and-reinstall). */
  setRenderPath(path: RenderPath | null): void;
  /** The currently installed render path, or `null` for the default flat renderer. */
  readonly renderPath: RenderPath | null;
  /** Swaps the active camera — repoints `controls.object` and notifies the installed `RenderPath` (if any) so both stay in sync with `viewport.camera`. */
  setCamera(camera: THREE.PerspectiveCamera): void;
  setOnFrame(fn: ((deltaSeconds: number) => void) | undefined): void;
  /**
   * Additional per-frame callbacks, alongside `setOnFrame`'s single slot
   * (which the animation mixer already claims). Runs every rendered frame,
   * after `onFrame`, in subscription order. Returns an unsubscribe.
   */
  addFrameHook(fn: (deltaSeconds: number) => void): () => void;
  /**
   * Bypasses the frame-rate limiter (if any) for as long as at least one
   * lease is outstanding — every rAF tick renders, and none of them feed
   * the limiter's adaptive sampling (a lease-covered frame's cost, e.g. a
   * progressive path-tracer sample, says nothing about steady-state
   * real-time render cost and would otherwise corrupt the fallback-FPS
   * heuristic). Refcounted: nest freely, the limiter only resumes once
   * every lease has been released. Returns the release function — call it
   * exactly once.
   */
  requestEveryFrame(): () => void;
  /**
   * Draws one frame synchronously, right now, outside the render loop's own
   * cadence — for a caller that needs to be certain the canvas holds a
   * freshly-rendered frame before reading its pixels (a screenshot; a
   * frame-stepped video capture). Deliberately minimal: does NOT call
   * `onFrame`/the frame hooks (a capture shouldn't advance the animation
   * mixer or any other per-frame state as a side effect of being read) and
   * does NOT feed the frame limiter (a synchronous full-quality draw
   * shouldn't poison its cost average). Also does NOT call
   * `controls.update()` — this draws whatever camera/damping state is
   * already current, rather than advancing it; a caller that needs damping
   * to settle first should call `controls.update()` itself before this.
   */
  renderNow(): void;
  /** Tells the installed `RenderPath` (if any) that scene contents changed underneath it — geometry rebuilt, materials swapped, model replaced — so it can rebuild whatever state it derived from the scene (a BVH, an accumulated image). No-op with no path installed, or one that doesn't implement it. */
  invalidateSceneContents(): void;
  /**
   * Toggles shadow-casting from the key light. `false` turns everything
   * back off (shadow map, the key light's `castShadow`, the shadow-catcher
   * plane, restored ambient intensity); `true` or a `ShadowOptions` object
   * turns it on with default or overridden shadow-map quality respectively.
   * No-op if there is no key light (`lights.key === false`).
   *
   * **Also dims ambient light while enabled** — the default rig's
   * `AmbientLight(0x606060, 1.2)` against a `1.6`-intensity key would
   * otherwise wash a shadow out almost to invisibility. This is a real,
   * visible change to the scene beyond "a shadow appears," not just an
   * implementation detail — restored exactly on `setShadows(false)`.
   *
   * Fits the shadow-camera frustum and (re)builds the shadow-catcher plane
   * against whatever bounds `setSceneBounds()` was last called with; call
   * `setSceneBounds()` again after loading a new model if shadows are
   * already on, the same way the grid needs it.
   */
  setShadows(opts: boolean | ShadowOptions): void;
  /** Regenerates an `'auto'`-configured grid to fit `box`, and — if shadows are currently enabled — refits the shadow-camera frustum and resizes/repositions the shadow-catcher plane to match. No-op for the grid half if `grid` wasn't `'auto'`; no-op for the shadow half if shadows aren't enabled or there's no key light. Both halves no-op on an empty `box`. */
  setSceneBounds(box: THREE.Box3): void;
  /** @deprecated Renamed to `setSceneBounds` (which now does more than the grid alone) — this remains as a forwarding alias for existing callers. */
  setGridBounds(box: THREE.Box3): void;
  /** Re-reads `container`'s current size and applies it to the renderer/camera, then to the installed `RenderPath` (if any). Called automatically on a `ResizeObserver` tick (when the host environment has one); exposed directly too, since jsdom (this package's own test environment) doesn't implement `ResizeObserver`. */
  resize(): void;
  /** Cancels the render loop's *own* pending frame (fixing flower's original bug, which only ever tracked the first `requestAnimationFrame` id — see `viewer.ts:1115`'s doc comment on the old `createThreeViewport`), disconnects the resize observer, disposes the installed `RenderPath` (if any), and disposes the renderer. Does not touch anything under `root` — call `disposeObject3D(viewport.root)` first if a model is still loaded. */
  dispose(): void;
}

function addLights(
  scene: THREE.Scene,
  lights: ViewportOptions['lights'],
): { keyLight: THREE.DirectionalLight | null; ambientLight: THREE.AmbientLight | null } {
  if (lights === false) return { keyLight: null, ambientLight: null };
  const cfg = lights ?? {};

  let ambientLight: THREE.AmbientLight | null = null;
  if (cfg.ambient !== false) {
    const a = cfg.ambient ?? {};
    ambientLight = new THREE.AmbientLight(a.color ?? 0x606060, a.intensity ?? 1.2);
    scene.add(ambientLight);
  }
  let keyLight: THREE.DirectionalLight | null = null;
  if (cfg.key !== false) {
    const k = cfg.key ?? {};
    const light = new THREE.DirectionalLight(k.color ?? 0xffffff, k.intensity ?? 1.6);
    light.position.set(...(k.position ?? [3, 5, 4]));
    scene.add(light);
    // The shadow camera looks from light.position toward light.target —
    // added here, unconditionally, regardless of whether shadows end up
    // enabled, so fitShadowCamera() always has somewhere in the actual
    // scene graph to point (an unparented default target still works for
    // matrix math, but keeping it a real scene child is the standard,
    // least-surprising three.js shadow setup).
    scene.add(light.target);
    keyLight = light;
  }
  if (cfg.fill !== false) {
    const f = cfg.fill ?? {};
    const light = new THREE.DirectionalLight(f.color ?? 0x88aaff, f.intensity ?? 0.5);
    light.position.set(...(f.position ?? [-3, -1, -2]));
    scene.add(light);
  }
  return { keyLight, ambientLight };
}

function disposeGrid(scene: THREE.Scene, grid: THREE.GridHelper): void {
  scene.remove(grid);
  grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
}

function buildGrid(cfg: GridConfig): THREE.GridHelper {
  const grid = new THREE.GridHelper(
    cfg.size,
    cfg.divisions,
    cfg.color1 ?? 0x3a3a3a,
    cfg.color2 ?? 0x2a2a2a,
  );
  if (cfg.y !== undefined) grid.position.y = cfg.y;
  return grid;
}

/**
 * Generic scene/camera/renderer/controls/resize/render-loop bootstrap —
 * flower's `createThreeViewport` (`viewer.ts:1107-1214`), generalized to fix
 * its two host-coupling bugs: it now reads/observes the passed-in
 * `container` instead of a module-global `canvasWrap`, and the render loop
 * calls a passed-in `onFrame(delta)` instead of reaching for a global
 * `meshState?.mixer`. All of hunter's divergent settings (background color,
 * near/far, starting camera position, grid size, damping factor) are now
 * `ViewportOptions` fields, which is what makes one implementation cover
 * both real consumers.
 */
export function createViewport(container: HTMLElement, opts: ViewportOptions = {}): Viewport {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.background ?? 0x161616);

  // Mutable, not const: `setCamera()` swaps this (for a future photo-mode
  // `PhysicalCamera`) — every closure below reads the live binding, not a
  // snapshot, so a swap takes effect everywhere on the very next frame.
  let camera = new THREE.PerspectiveCamera(
    opts.fov ?? 45,
    width / height,
    opts.near ?? 0.01,
    opts.far ?? 10000,
  );
  if (opts.cameraPosition) camera.position.set(...opts.cameraPosition);

  // preserveDrawingBuffer: a screenshot (@seer-project/canvas-export) reads
  // this canvas's pixels some time after the last render() call, with no
  // guaranteed-fresh render immediately before the read — without this,
  // toBlob()/toDataURL() can capture an already-cleared or about-to-swap
  // buffer instead of the last rendered frame. A `renderNow()` + explicit
  // pre-capture render is the more precise fix (planned alongside the
  // render-path seam), but costs real new API surface; this flag is the
  // narrow, already-correct fix needed today. Revisit if it turns out to
  // matter on real GPU hardware — see render-quality-proposal.md's Phase 0(b).
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  const devicePixelRatio = typeof window !== 'undefined' ? (window.devicePixelRatio ?? 1) : 1;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.imageRendering = opts.pixelated ? 'pixelated' : 'auto';
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = opts.damping ?? 0.12;

  const { keyLight, ambientLight } = addLights(scene, opts.lights);
  // Captured once, at whatever intensity the host configured — setShadows()
  // dims from this baseline and restores exactly back to it, rather than
  // hardcoding a value that would clobber a host's own customization.
  const baseAmbientIntensity = ambientLight?.intensity ?? 0;
  // A shadow this strongly lit washes out almost to invisibility (the
  // default rig's AmbientLight(0x606060, 1.2) against a 1.6-intensity key)
  // — dimmed to 40% of whatever the host configured while shadows are on.
  const SHADOW_AMBIENT_FACTOR = 0.4;

  const gridOption = opts.grid;
  let gridHelper: THREE.GridHelper | null = null;
  if (gridOption && gridOption !== 'auto') {
    gridHelper = buildGrid(gridOption);
    scene.add(gridHelper);
  }

  let shadowsEnabled = false;
  let shadowCatcher: THREE.Mesh | null = null;
  let lastBounds: THREE.Box3 | null = null;

  /** Fits the shadow-camera frustum and (re)builds the catcher plane to `box` — the shared tail end of both `updateSceneBounds()` (a new model changed the bounds) and `applyShadows(true)` (shadows just turned on, against whatever bounds are already known). No-op if shadows are off, there's no key light, or `box` is empty/unknown. */
  const fitShadowsToBounds = (box: THREE.Box3 | null): void => {
    if (!shadowsEnabled || !keyLight || !box || box.isEmpty()) return;
    fitShadowCamera(keyLight, box);
    if (shadowCatcher) {
      updateShadowCatcher(shadowCatcher, box);
    } else {
      shadowCatcher = createShadowCatcher(box);
      scene.add(shadowCatcher);
    }
  };

  const updateSceneBounds = (box: THREE.Box3): void => {
    lastBounds = box;
    if (gridOption === 'auto' && !box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3());
      const footprint = Math.max(size.x, size.z, 0.001);
      const gridSize = footprint * 2;
      const divisions = Math.max(4, Math.min(40, Math.round(gridSize / 10)) || 4);
      if (gridHelper) disposeGrid(scene, gridHelper);
      gridHelper = buildGrid({ size: gridSize, divisions, y: box.min.y });
      scene.add(gridHelper);
    }
    fitShadowsToBounds(box);
  };

  /** Shared by `ViewportOptions.shadows` (construction-time) and `Viewport.setShadows()` (runtime) — see that method's doc comment for the full behavior. */
  const applyShadows = (next: boolean | ShadowOptions): void => {
    const enabled = next !== false;
    shadowsEnabled = enabled;
    applyShadowSettings(renderer, enabled);
    if (keyLight) {
      keyLight.castShadow = enabled;
      if (enabled) applyLightShadowSettings(keyLight, typeof next === 'object' ? next : {});
    }
    if (ambientLight) {
      ambientLight.intensity = enabled ? baseAmbientIntensity * SHADOW_AMBIENT_FACTOR : baseAmbientIntensity;
    }
    if (enabled) {
      fitShadowsToBounds(lastBounds);
    } else if (shadowCatcher) {
      scene.remove(shadowCatcher);
      shadowCatcher.geometry.dispose();
      (shadowCatcher.material as THREE.Material).dispose();
      shadowCatcher = null;
    }
  };
  if (opts.shadows) applyShadows(opts.shadows);

  const root = new THREE.Group();
  scene.add(root);

  const clock = new THREE.Clock();
  const limiter = opts.frameLimiter === false ? null : createFrameLimiter(opts.frameLimiter ?? {});

  let onFrame: ((deltaSeconds: number) => void) | undefined = opts.onFrame;
  const frameHooks = new Set<(deltaSeconds: number) => void>();
  let renderPath: RenderPath | null = null;
  let leaseCount = 0;
  let running = true;
  let animId = 0;

  /** Dispatches to the installed `RenderPath`, or today's plain render call. Shared by the render loop and `renderNow()`. */
  const draw = (delta: number): void => {
    if (renderPath) renderPath.render(scene, camera, delta);
    else renderer.render(scene, camera);
  };

  const animate = () => {
    if (!running) return;
    animId = requestAnimationFrame(animate);

    // A lease bypasses the limiter's gate entirely — every tick renders —
    // and its cost is deliberately excluded from `recordWork`'s sample
    // (see `requestEveryFrame()`'s doc comment on `Viewport`).
    const leased = leaseCount > 0;
    if (!leased && limiter && !limiter.shouldRender()) return;

    const delta = clock.getDelta();
    const workStart = performance.now();
    onFrame?.(delta);
    for (const hook of frameHooks) hook(delta);
    controls.update();
    draw(delta);
    if (!leased) limiter?.recordWork(performance.now() - workStart);
  };
  animId = requestAnimationFrame(animate);

  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderPath?.setSize?.(w, h, renderer.getPixelRatio());
  };

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(container);

  const viewport: Viewport = {
    scene,
    get camera() {
      return camera;
    },
    renderer,
    controls,
    root,
    container,
    keyLight,
    get renderPath() {
      return renderPath;
    },
    setRenderPath(path) {
      if (path === renderPath) return;
      renderPath?.dispose();
      renderPath = path;
      // The outgoing path's dispose() can change `camera` as a side effect
      // (PhotoModeController.dispose() restores the pre-photo-mode camera
      // via viewport.setCamera()) — that notification lands on the OLD
      // path (still installed at the moment dispose() runs it), never the
      // new one, which may have been constructed against a camera that's
      // since been swapped out from under it (e.g. Photo -> Cinematic:
      // createCinematicPath() reads viewport.camera before this call,
      // which at that point is still photo mode's PhysicalCamera). Telling
      // the incoming path what the camera actually is right now — whatever
      // it ended up being after the outgoing path's own teardown — keeps
      // every render tier pointed at the same live camera the controls
      // actually drive, instead of a frozen, abandoned one.
      renderPath?.setCamera?.(camera);
    },
    setCamera(next) {
      camera = next;
      controls.object = next;
      renderPath?.setCamera?.(next);
    },
    setOnFrame(fn) {
      onFrame = fn;
    },
    addFrameHook(fn) {
      frameHooks.add(fn);
      return () => frameHooks.delete(fn);
    },
    requestEveryFrame() {
      leaseCount++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leaseCount--;
        if (leaseCount === 0) limiter?.resetClock();
      };
    },
    renderNow() {
      draw(0);
    },
    invalidateSceneContents() {
      renderPath?.invalidateSceneContents?.();
    },
    setShadows: applyShadows,
    setSceneBounds: updateSceneBounds,
    setGridBounds: updateSceneBounds,
    resize,
    dispose() {
      running = false;
      cancelAnimationFrame(animId);
      resizeObserver?.disconnect();
      if (shadowCatcher) {
        shadowCatcher.geometry.dispose();
        (shadowCatcher.material as THREE.Material).dispose();
        shadowCatcher = null;
      }
      if (gridHelper) {
        disposeGrid(scene, gridHelper);
        gridHelper = null;
      }
      renderPath?.dispose();
      renderPath = null;
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  return viewport;
}
