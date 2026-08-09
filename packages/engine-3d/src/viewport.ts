import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createFrameLimiter, type FrameLimiterOptions } from './frame-limiter.ts';

export interface LightConfig {
  color?: THREE.ColorRepresentation;
  intensity?: number;
  position?: [number, number, number];
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
}

export interface Viewport {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  /** Every model a host adds goes under here, never directly under `scene` — keeps lights/grid/camera untouched by whatever `disposeObject3D`/`.clear()` a host does when switching models. */
  root: THREE.Group;
  container: HTMLElement;
  setOnFrame(fn: ((deltaSeconds: number) => void) | undefined): void;
  /** Regenerates an `'auto'`-configured grid to fit `box`. No-op if `grid` wasn't `'auto'`, or if `box` is empty. */
  setGridBounds(box: THREE.Box3): void;
  /** Re-reads `container`'s current size and applies it to the renderer/camera. Called automatically on a `ResizeObserver` tick (when the host environment has one); exposed directly too, since jsdom (this package's own test environment) doesn't implement `ResizeObserver`. */
  resize(): void;
  /** Cancels the render loop's *own* pending frame (fixing flower's original bug, which only ever tracked the first `requestAnimationFrame` id — see `viewer.ts:1115`'s doc comment on the old `createThreeViewport`), disconnects the resize observer, and disposes the renderer. Does not touch anything under `root` — call `disposeObject3D(viewport.root)` first if a model is still loaded. */
  dispose(): void;
}

function addLights(scene: THREE.Scene, lights: ViewportOptions['lights']): void {
  if (lights === false) return;
  const cfg = lights ?? {};

  if (cfg.ambient !== false) {
    const a = cfg.ambient ?? {};
    scene.add(new THREE.AmbientLight(a.color ?? 0x606060, a.intensity ?? 1.2));
  }
  if (cfg.key !== false) {
    const k = cfg.key ?? {};
    const light = new THREE.DirectionalLight(k.color ?? 0xffffff, k.intensity ?? 1.6);
    light.position.set(...(k.position ?? [3, 5, 4]));
    scene.add(light);
  }
  if (cfg.fill !== false) {
    const f = cfg.fill ?? {};
    const light = new THREE.DirectionalLight(f.color ?? 0x88aaff, f.intensity ?? 0.5);
    light.position.set(...(f.position ?? [-3, -1, -2]));
    scene.add(light);
  }
}

function buildGrid(cfg: GridConfig): THREE.GridHelper {
  const grid = new THREE.GridHelper(cfg.size, cfg.divisions, cfg.color1 ?? 0x3a3a3a, cfg.color2 ?? 0x2a2a2a);
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

  const camera = new THREE.PerspectiveCamera(opts.fov ?? 45, width / height, opts.near ?? 0.01, opts.far ?? 10000);
  if (opts.cameraPosition) camera.position.set(...opts.cameraPosition);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  const devicePixelRatio = typeof window !== 'undefined' ? (window.devicePixelRatio ?? 1) : 1;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.imageRendering = opts.pixelated ? 'pixelated' : 'auto';
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = opts.damping ?? 0.12;

  addLights(scene, opts.lights);

  const gridOption = opts.grid;
  let gridHelper: THREE.GridHelper | null = null;
  if (gridOption && gridOption !== 'auto') {
    gridHelper = buildGrid(gridOption);
    scene.add(gridHelper);
  }

  const root = new THREE.Group();
  scene.add(root);

  const clock = new THREE.Clock();
  const limiter = opts.frameLimiter === false ? null : createFrameLimiter(opts.frameLimiter ?? {});

  let onFrame: ((deltaSeconds: number) => void) | undefined = opts.onFrame;
  let running = true;
  let animId = 0;

  const animate = () => {
    if (!running) return;
    animId = requestAnimationFrame(animate);
    if (limiter && !limiter.shouldRender()) return;

    const delta = clock.getDelta();
    const workStart = performance.now();
    onFrame?.(delta);
    controls.update();
    renderer.render(scene, camera);
    limiter?.recordWork(performance.now() - workStart);
  };
  animId = requestAnimationFrame(animate);

  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(container);

  const viewport: Viewport = {
    scene,
    camera,
    renderer,
    controls,
    root,
    container,
    setOnFrame(fn) {
      onFrame = fn;
    },
    setGridBounds(box) {
      if (gridOption !== 'auto' || box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const footprint = Math.max(size.x, size.z, 0.001);
      const gridSize = footprint * 2;
      const divisions = Math.max(4, Math.min(40, Math.round(gridSize / 10)) || 4);
      if (gridHelper) scene.remove(gridHelper);
      gridHelper = buildGrid({ size: gridSize, divisions, y: box.min.y });
      scene.add(gridHelper);
    },
    resize,
    dispose() {
      running = false;
      cancelAnimationFrame(animId);
      resizeObserver?.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  return viewport;
}
