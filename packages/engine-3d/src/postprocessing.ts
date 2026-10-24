import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import type { RenderPath } from './render-path.js';

export interface BloomOptions {
  /** Default `0.6`. */
  strength?: number;
  /** Default `0.4`. */
  radius?: number;
  /** Luminance cutoff below which nothing blooms. Default `0.85`. */
  threshold?: number;
}

export interface AOOptions {
  /** World-space sample radius. Default `0.25` — `GTAOShader`'s own upstream default. */
  radius?: number;
  /**
   * Blend strength over the lit image, 0..1+. Default `0.5`, **not**
   * `GTAOPass`'s own upstream default of `1` — verified in a real browser
   * (SwiftShader) against this viewer's actual asset scale that `1`
   * produces near-total black-out (the denoised occlusion estimate reads
   * high enough here that full-strength blending crushes the image), while
   * `0.5` reads as a normal, subtly-occluded render. Values above roughly
   * `0.6` risk the same over-darkening depending on scene/model geometry —
   * a host exposing this as a UI slider should keep that in mind rather
   * than assuming `1` is a sane maximum.
   */
  intensity?: number;
  /** Default `16`. */
  samples?: number;
}

export interface DOFOptions {
  /** Focus distance, same units as the scene. Default `10`. */
  focus?: number;
  /** Aperture — larger blurs more aggressively away from focus. Default `0.00003` (`BokehPass`'s own scale, not `f`-stop notation). */
  aperture?: number;
  /** Max blur radius, in normalized screen units. Default `0.01`. */
  maxblur?: number;
}

export interface ToneMappingOptions {
  /** Default `1`. */
  exposure?: number;
}

export type AntialiasStrategy = 'msaa' | 'fxaa' | 'none';

export interface CinematicOptions {
  bloom?: false | BloomOptions;
  ao?: false | AOOptions;
  dof?: false | DOFOptions;
  /** ACES filmic tone mapping via `OutputPass`. `false`/omitted restores `NoToneMapping` — opt-in like every other effect here, not implied by switching to the `cinematic` tier alone. */
  toneMapping?: false | ToneMappingOptions;
  /** Default `'msaa'`. `EffectComposer`'s offscreen render targets don't inherit the renderer's own antialiasing (`HalfFloatType`, no `samples`) — see `planCinematicPasses`'s doc comment for the tradeoff between the two real fixes. `'none'` accepts the softer composer output as-is. */
  antialias?: AntialiasStrategy;
}

export type CinematicPassKind = 'msaa-target' | 'render' | 'gtao' | 'bokeh' | 'bloom' | 'output' | 'fxaa';

/** One step of the plan `planCinematicPasses` produces — purely an ordering/composition marker, not a live pass instance. `'msaa-target'` isn't a real `Pass` at all; it tells `createCinematicPath` to construct the composer's own render target with MSAA `samples` rather than adding one. */
export interface CinematicPassPlan {
  readonly kind: CinematicPassKind;
}

/**
 * Encodes cinematic pass ordering and composition as pure data, so both the
 * ordering logic and `cinematicPlansEqual`'s reuse-vs-rebuild decision are
 * testable without constructing a real `EffectComposer`.
 *
 * Order is `render → gtao → bokeh → bloom → output → fxaa`:
 * - DOF before bloom — blooming an already-defocused image is the
 *   conventional cinematic chain; blooming first would blur the bloom.
 * - FXAA strictly after `OutputPass`, never before — `OutputPass`'s own
 *   doc comment states this explicitly: FXAA needs sRGB input, and its
 *   luma heuristic reads wrong on the linear `HalfFloat` buffer every
 *   other pass in this chain operates on.
 *
 * MSAA (the default `antialias` strategy) isn't a pass in the chain at
 * all — it's a property of the composer's own render target, requested by
 * constructing it with `{ samples: 4 }` (`WebGLRenderTarget` supports this
 * on WebGL2, `RenderTarget.js:63,194`) rather than accepting
 * `EffectComposer`'s own `HalfFloatType`-with-no-`samples` default. Real
 * MSAA keeps edges sharp; FXAA smears pixel-art-derived geometry, which is
 * most of what these viewers actually show — `'fxaa'` is offered as an
 * explicit fallback for a host/GPU where the real thing costs too much,
 * not the default.
 */
export function planCinematicPasses(opts: CinematicOptions): CinematicPassPlan[] {
  const antialias = opts.antialias ?? 'msaa';
  const plan: CinematicPassPlan[] = [];
  if (antialias === 'msaa') plan.push({ kind: 'msaa-target' });
  plan.push({ kind: 'render' });
  if (opts.ao) plan.push({ kind: 'gtao' });
  if (opts.dof) plan.push({ kind: 'bokeh' });
  if (opts.bloom) plan.push({ kind: 'bloom' });
  plan.push({ kind: 'output' });
  if (antialias === 'fxaa') plan.push({ kind: 'fxaa' });
  return plan;
}

/**
 * `true` when `a`/`b` have the same pass composition and order — the
 * caller can just push new option values into the existing pass instances'
 * uniforms rather than tearing down and rebuilding the whole chain.
 * `false` on any shape change (an effect toggled on/off, or the antialias
 * strategy changed) — three.js has no supported way to insert/remove a
 * pass from a live `EffectComposer` mid-chain, so a shape change means a
 * full rebuild. Numeric option values (bloom strength, AO radius, ...)
 * never appear in a `CinematicPassPlan` at all, so they're correctly
 * invisible to this comparison — exactly the "only numeric params
 * differ" case this function exists to recognize as a non-rebuild.
 */
export function cinematicPlansEqual(a: CinematicPassPlan[], b: CinematicPassPlan[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.kind === b[i]!.kind);
}

/**
 * Sets ACES filmic tone mapping + exposure on `renderer`, or restores
 * `NoToneMapping` when `opts` is falsy. This is a renderer-level property,
 * not a per-pass one — `OutputPass` reads it to decide what to bake into
 * its output, and `WebGLRenderer` itself forces `NoToneMapping` whenever
 * rendering to an offscreen target (`WebGLRenderer.js:2351-2357`), so
 * tone mapping never double-applies across the composer's intermediate
 * passes even though this sets a value that persists on the renderer
 * beyond a single `render()` call.
 */
export function applyToneMapping(renderer: THREE.WebGLRenderer, opts: false | ToneMappingOptions): void {
  if (!opts) {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    return;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1;
}

export interface CinematicPath extends RenderPath {
  /** Pushes new numeric option values into the live pass instances without rebuilding — only valid when `cinematicPlansEqual(planCinematicPasses(current), planCinematicPasses(next))`; the caller (`session.ts`/`viewport.ts`) is responsible for calling `Viewport.setRenderPath()` with a freshly-constructed path instead when the shape actually changed. */
  setOptions(next: CinematicOptions): void;
}

function applyBloomOptions(pass: UnrealBloomPass, opts: BloomOptions): void {
  pass.strength = opts.strength ?? 0.6;
  pass.radius = opts.radius ?? 0.4;
  pass.threshold = opts.threshold ?? 0.85;
}

function applyAOOptions(pass: GTAOPass, opts: AOOptions): void {
  pass.updateGtaoMaterial({ radius: opts.radius ?? 0.25, samples: opts.samples ?? 16 });
  pass.blendIntensity = opts.intensity ?? 0.5;
}

function applyDOFOptions(pass: BokehPass, opts: DOFOptions): void {
  const uniforms = pass.uniforms as Record<string, { value: number }>;
  uniforms.focus!.value = opts.focus ?? 10;
  uniforms.aperture!.value = opts.aperture ?? 0.00003;
  uniforms.maxblur!.value = opts.maxblur ?? 0.01;
}

/**
 * Builds the real `EffectComposer`/pass chain for the `cinematic` tier,
 * per `planCinematicPasses(opts)`'s ordering. `RenderPath.render()` reuses
 * the `scene`/`camera` already baked into the constructed passes rather
 * than the ones passed per-call — a `Viewport` never swaps `scene`, and a
 * `setCamera()` call flows through this path's own `setCamera()` (below),
 * which is what keeps every pass holding a camera reference in sync.
 */
/**
 * The composer's effective pixel ratio. GTAO's depth/normal passes are the
 * single most expensive thing in the stack, so with AO on the composer is
 * clamped to 1x regardless of the display's device ratio; everything else
 * renders at the renderer's own ratio. Written out in four places before
 * this — `createCinematicPath`'s construction, FXAA's resolution uniform,
 * `setSize()` and `setOptions()` — which is four chances for them to
 * disagree about what the composer is actually rendering at.
 */
function composerPixelRatio(opts: CinematicOptions, pixelRatio: number): number {
  return opts.ao ? Math.min(pixelRatio, 1) : pixelRatio;
}

export function createCinematicPath(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  opts: CinematicOptions,
): CinematicPath {
  let plan = planCinematicPasses(opts);
  let current = opts;

  const size = renderer.getSize(new THREE.Vector2());
  const pixelRatio = renderer.getPixelRatio();

  // CSS pixels, not device pixels — EffectComposer's constructor reads
  // `_width`/`_height` straight off whatever target is passed in (real
  // source, confirmed by reading it: `this._width = renderTarget.width`),
  // and every later `setPixelRatio()` call rescales FROM that baseline
  // (`setSize(this._width, this._height)` internally). Passing a target
  // already sized in device pixels here would double that scaling — the
  // very next line's AO cost clamp (`setPixelRatio(1)`, meant to render at
  // CSS resolution) would land back on device resolution instead, and the
  // non-AO case would end up 'pixelRatio²' oversized. This self-corrected
  // on the first real `Viewport.resize()` (`setSize()` below passes CSS
  // dimensions too) — it's specifically the *initial* frame(s) after
  // construction, before any resize, that rendered at the wrong scale.
  const useMsaaTarget = plan.some((p) => p.kind === 'msaa-target');
  const renderTarget = useMsaaTarget
    ? new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
        samples: 4,
      })
    : undefined;

  const composer = new EffectComposer(renderer, renderTarget);
  composer.setPixelRatio(composerPixelRatio(current, pixelRatio));

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  let gtaoPass: GTAOPass | null = null;
  if (current.ao) {
    gtaoPass = new GTAOPass(scene, camera, size.x, size.y);
    applyAOOptions(gtaoPass, current.ao);
    composer.addPass(gtaoPass);
  }

  let bokehPass: BokehPass | null = null;
  if (current.dof) {
    bokehPass = new BokehPass(scene, camera, {});
    applyDOFOptions(bokehPass, current.dof);
    composer.addPass(bokehPass);
  }

  let bloomPass: UnrealBloomPass | null = null;
  if (current.bloom) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 1, 1, 1);
    applyBloomOptions(bloomPass, current.bloom);
    composer.addPass(bloomPass);
  }

  applyToneMapping(renderer, current.toneMapping ?? false);
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  let fxaaPass: FXAAPass | null = null;
  if ((current.antialias ?? 'msaa') === 'fxaa') {
    fxaaPass = new FXAAPass();
    // The composer's OWN effective pixel ratio (the same expression used
    // for composer.setPixelRatio() above), not the raw renderer one — with
    // AO on, the composer actually renders at the clamped ratio, and
    // FXAA's shader needs its resolution uniform to match the real
    // per-pixel size it's sampling, not the display's.
    const effectivePixelRatio = composerPixelRatio(current, pixelRatio);
    fxaaPass.setSize(size.x * effectivePixelRatio, size.y * effectivePixelRatio);
    composer.addPass(fxaaPass);
  }

  const path: CinematicPath = {
    render(_scene, _camera, delta) {
      composer.render(delta);
    },
    setSize(w, h, pr) {
      composer.setPixelRatio(composerPixelRatio(current, pr));
      composer.setSize(w, h);
    },
    setCamera(next) {
      renderPass.camera = next;
      if (gtaoPass) gtaoPass.camera = next;
      if (bokehPass) bokehPass.camera = next;
    },
    setOptions(next) {
      const nextPlan = planCinematicPasses(next);
      if (!cinematicPlansEqual(plan, nextPlan)) {
        throw new Error(
          'CinematicPath.setOptions: pass composition changed — install a freshly-constructed path via Viewport.setRenderPath() instead of calling setOptions() across a shape change.',
        );
      }
      current = next;
      plan = nextPlan;
      if (gtaoPass && next.ao) applyAOOptions(gtaoPass, next.ao);
      if (bokehPass && next.dof) applyDOFOptions(bokehPass, next.dof);
      if (bloomPass && next.bloom) applyBloomOptions(bloomPass, next.bloom);
      applyToneMapping(renderer, next.toneMapping ?? false);
      composer.setPixelRatio(composerPixelRatio(next, renderer.getPixelRatio()));
    },
    dispose() {
      gtaoPass?.dispose();
      bokehPass?.dispose();
      bloomPass?.dispose();
      fxaaPass?.dispose();
      outputPass.dispose();
      composer.dispose();
      // Deliberately does NOT reset renderer.toneMapping here. Viewport.setRenderPath()
      // disposes the OUTGOING path only after the incoming one has already been
      // constructed (and, if it's another CinematicPath, has already called
      // applyToneMapping() with its own desired state) — resetting it here would run
      // last and silently wipe out whatever the new path just set. Restoring
      // NoToneMapping is the caller's responsibility when there's no replacement
      // cinematic path to set it instead (see session.ts's setCinematic(false)).
    },
  };

  return path;
}
