# Cinematic rendering, photo mode, and export — proposal

**Status: proposed — not yet implemented. Revision 2, post-review.** This
is the plan for adding shadow-casting, real-time postprocessing, a
progressive path-traced photo mode, and asset-agnostic screenshot/clip
export to `@seer-project/engine-3d` + a new `@seer-project/canvas-export`
package + `@seer-project/mesh-viewer-ui`, then rolling it out to siren,
flower, and chimera the same way the settings-panel work was. Companion:
[`docs/2d-export-proposal.md`](2d-export-proposal.md) covers the 2D
sprite-viewer equivalent (export reuse, grading, retro display shaders) —
see [`docs/viewer.md`](viewer.md) and each package's own README for what
already exists.

> **Revision 2** incorporates a design review that verified every checkable
> claim in revision 1 against the installed `three@0.185.1`, the
> `@seer-project` sources, siren's viewer, and the published `.d.ts` of
> `three-gpu-pathtracer@0.0.24` / `three-mesh-bvh@0.9.14`. Ten claims were
> wrong, three of them load-bearing mechanisms rather than details. See
> [Corrections from review](#corrections-from-review) for the full list —
> it is kept in the document deliberately, because several of the errors
> are the kind that would otherwise be re-derived.

## Context

The mesh viewer currently renders flat-lit with no shadows, no
postprocessing, and no way to export what's on screen. This proposal adds:

- **Shadow-casting** (real-time shadow maps)
- **Real-time "cinematic" postprocessing**: bloom, ambient occlusion, depth
  of field, tone mapping
- **A progressive path-traced "photo mode"** that refines the image while
  the camera sits idle and instantly reverts to real-time rendering the
  moment the camera moves
- **Screenshot export** with a watermark (`modelname — game (platform) —
  project — a seer project`, host-built text)
- **Clip export** of either an existing animation clip or a new scripted
  turntable orbit, watermarked in v1
- **Export is asset-agnostic** — the capture/watermark/video-recording
  mechanism must not be welded to the 3D mesh viewer, so the 2D plan (see
  companion doc) can reuse it

Explicitly **deferred** (separate future plans, not touched here): skeletal
animation editing (pose/keyframe authoring — playback/scrub stays as-is),
custom export backgrounds (existing white/black/transparent/checkered stays
the only option), and the **raycasting tier** (see §1.10 — retained as a
documented future tier, with the two problems that got it cut written down).

Verified against the installed three.js 0.185.1: `EffectComposer`,
`UnrealBloomPass`, `GTAOPass`, `BokehPass`, `OutputPass` and `FXAAPass` all
exist in `examples/jsm/postprocessing/` and are typed in
`@types/three@0.185.4`; native shadow-map support is present; no ray or
path tracing exists in three.js itself. Photo mode needs
`three-gpu-pathtracer` (`WebGLPathTracer`, peer `three >=0.180.0`).

## Architecture decisions

**Viewport- vs. model-scoped state.** Shadows/postprocessing/photo-mode are
**viewport-scoped** (renderer, camera, scene, render loop), not
model-scoped — unlike `textureFilter`/`renderMode`/`shading` which live on
`MeshSession` because they mutate `Model3D` contents. They go on
`Viewport`, with thin pass-through methods on `MeshSession` (same pattern
`getMaxAnisotropy()` already establishes) so `mesh-viewer-ui` still only
ever talks to one object.

**Render-quality tiers are mutually exclusive.** Only one `RenderPath` can
be installed at a time, so the UI models render quality as a single
selector, not independent checkboxes:

| Tier | What it is | Shadows toggle | Bloom/AO/DOF toggles |
|---|---|---|---|
| `flat` | Plain `renderer.render()`, today's behavior | Applies (shadow maps) | N/A |
| `cinematic` | `EffectComposer` chain | Applies (shadow maps) | Applies |
| `photo` | Progressive path tracing | N/A — computes everything natively | N/A |

Shadows stay an independent toggle (a renderer-level feature, meaningful
under `flat`/`cinematic`) but the panel greys it out under `photo`, where
it's meaningless — **and also under shading modes and model sources where
it would silently do nothing**; see §1.3.

**Export is a separate, asset-agnostic package** —
`@seer-project/canvas-export` (new) — not bundled into `mesh-viewer-ui`.
Screenshot/watermark/video-recording have nothing to do with meshes; they
operate on whatever's currently drawn into a canvas. Splitting this out is
what lets the 2D sprite viewer (or any other canvas-based seer viewer) get
export for free — a real second consumer on day one, which is what
justifies the package rather than it being speculative generality.

**`canvas-export` is built first, not last.** It has no dependency on any
of the rendering work, it de-risks the `CaptureSource` seam before three
tiers depend on it, and it unblocks the 2D plan — which in revision 1
described itself as independent of the 3D work while being gated behind the
3D plan's second-most-speculative phase.

## Part 1 — `@seer-project/canvas-export` (new package, Phase 1)

Asset-agnostic; zero dependency on `engine-3d`/three.js. Structure mirrors
`audio-ui`/`mesh-viewer-ui` exactly: `package.json`, `tsconfig*.json`,
`README.md`, `src/index.ts` barrel, `src/__tests__/`.

### 1.1 `popover.ts`

`createPopover(toggleBtn, panel) → () => void` — toggle/outside-click/
Escape logic, generic. Used by this package's own export controls and by
`mesh-settings-panel.ts` / the new `render-settings-panel.ts`.

This is an **extraction, not a move**: `mesh-viewer-ui/src/` contains only
`index.ts` and `mesh-settings-panel.ts`, and the popover behaviour lives as
private methods (`isOpen`/`openPanel`/`closePanel`) plus document-level
`pointerdown`/`keydown` handlers registered inside `bindStaticControls()`
(`mesh-settings-panel.ts:86-116`). Three things must survive the
extraction:

- **It must return an unsubscribe.** Every listener currently routes
  through `this.on(...)` so it lands in the `teardown` array consumed by
  `dispose()` (lines 81-84, 220-224). A `createPopover` returning `void`
  would silently regress that contract.
- The `e.stopPropagation()` on toggle click (line 100).
- The `.hidden`-class-as-source-of-truth convention that `isOpen()` reads.

`mesh-settings-panel.test.ts` passing unchanged is a **necessary but not
sufficient** guard here, because the extraction restructures exactly the
internals those tests don't reach. Add a direct `popover.test.ts` covering
the teardown path.

### 1.2 `capture-source.ts` — the seam that makes capture asset-agnostic

```ts
export interface CaptureSource {
  /**
   * The canvas to capture.
   * MUST be implemented as a getter, not a captured reference — siren's 2D
   * viewer replaces the <canvas> element on every draw, so a CaptureSource
   * built once would otherwise hold a detached node.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * Ensures `canvas`'s pixels are current before a synchronous read.
   * Required for any WebGL source without `preserveDrawingBuffer` (see
   * engine-3d's `Viewport.renderNow()`). Omit only for a source whose
   * buffer is always already current.
   *
   * CONTRACT: callers MUST read the canvas synchronously after calling
   * this — no intervening `await`, or the buffer is gone.
   */
  renderNow?(): void;
}
```

Both of those constraints are interface-level contract documentation, not
parentheticals — they are the two things each consumer gets wrong by
default.

### 1.3 `screenshot.ts`

`drawWatermark(ctx, width, height, opts: WatermarkOptions)`,
`composeCaptureCanvas(source, opts?)` (identity fast-path when no
watermark/scale), `captureBlob(source, opts?) → Promise<Blob>`,
`downloadScreenshot(source, filename, opts?) → Promise<void>`. Watermark
text is entirely host-supplied (`WatermarkOptions.text: string`) — the
package never builds the branding string itself.

### 1.4 `video-export.ts`

`pickVideoMimeType(isSupported, preferred?)` (pure),
`createCaptureSurface(source, {watermark?}) → {canvas, dispose()}`,
`recordClip(source, opts) → Promise<{blob, mimeType, durationSeconds}>`.

```ts
interface RecordClipOptions {
  /**
   * Host-supplied playback control. A mesh viewer passes something that
   * starts/stops an animation clip or a Turntable AND holds a
   * `Viewport.requestEveryFrame()` lease for the duration; a 2D sprite
   * viewer passes something that starts/stops its own frame-cycling timer.
   * This package never needs to know what "animation" means for an asset.
   */
  driver: { start(): void; stop(): void };
  fps?: number;
  durationSeconds: number;
  bitsPerSecond?: number;
  mimeType?: string;
  onProgress?(fraction: number): void;
  signal?: AbortSignal;
}
```

The `driver` seam is the key generalisation and replaces the 3D-specific
`VideoSource` union an earlier draft had. Two refinements:

- **Recording is deterministic, not wall-clock.** A scripted turntable is
  deterministic and the export should be too. Drive a fixed-timestep loop
  (render frame N → capture → feed the recorder) rather than a real-time
  `captureStream`, so a slow machine doesn't produce a stuttery clip whose
  duration doesn't match `durationSeconds`. The whole point of the feature
  is producing shareable artefacts; determinism beats the marginal
  simplicity of the real-time path.
- **Video is watermarked in v1.** Shipping watermarked stills alongside
  unwatermarked video is incoherent — the video is the more shareable
  artefact and the more likely to escape attribution. The per-frame loop
  above is already paid for, so this is one offscreen canvas plus a
  `drawImage` + `drawWatermark` per frame.

`pickVideoMimeType` probes vp9 → vp8 → av01 → generic webm → mp4. Note that
Safari's `MediaRecorder` emits MP4, so tests must assert on the
**negotiated mime type**, never on WebM EBML magic bytes.

**Phase 1 ships a working feature**: a `📷 Screenshot` button added to
siren's existing `#mesh-settings` panel, watermarked, against today's flat
renderer. It migrates to the render panel in Phase 7.

## Part 2 — `@seer-project/engine-3d`

### 2.1 `render-path.ts` (new) — the seam

```ts
export interface RenderPath {
  render(scene: THREE.Scene, camera: THREE.Camera, deltaSeconds: number): void;
  setSize?(width: number, height: number, pixelRatio: number): void;
  setCamera?(camera: THREE.PerspectiveCamera): void;
  /** Scene geometry or materials changed underneath this path — rebuild
   *  any derived state (BVH, path-traced scene). See §2.7. */
  invalidateSceneContents?(): void;
  dispose(): void;
}
```

`null` = today's `renderer.render(scene, camera)`.

### 2.2 `viewport.ts` (modified)

- `LightConfig` gains `castShadow?: boolean` + `shadow?: {mapSize?, bias?,
  normalBias?, radius?}`.
- `ViewportOptions` gains `shadows?: boolean | ShadowOptions` (default off)
  and `preserveDrawingBuffer?: boolean` (see below).
- `Viewport` gains: `keyLight` (readonly — `addLights()` at
  `viewport.ts:78-89` currently drops the light refs, needed for
  shadow-frustum fitting), `renderPath` + `setRenderPath(path | null)`
  (disposes the outgoing path), `setCamera(camera)` (repoints
  `controls.object` too), `addFrameHook(fn) → unsubscribe` (additive,
  alongside the existing single-slot `setOnFrame` the animation mixer
  already claims), `requestEveryFrame() → release`, `renderNow()`,
  `setShadows(opts)`, `invalidateSceneContents()`, `setSceneBounds(box)`
  (`setGridBounds` becomes a deprecated alias forwarding to it).
- `animate()`'s draw call is extracted into a `draw(delta)` closure
  dispatching to `renderPath?.render(...) ?? renderer.render(scene,
  camera)` — used by both the loop and `renderNow()`.
- `resize()`/`dispose()` forward to `renderPath`.

**The frame-limiter contract is touched, contrary to what revision 1
claimed.** Three specifics must be handled explicitly:

- `animate()` calls `limiter.recordWork()` unconditionally
  (`viewport.ts:170`). A 30ms cinematic frame or a path-traced sample
  exceeds `targetIntervalMs * 0.9` and pins the limiter at
  `fallbackIntervalMs` (`frame-limiter.ts:98-99`) **permanently**, including
  after switching back to `flat` — recovery needs `avgWorkMs <
  fallbackIntervalMs * 0.5` (line 100). `requestEveryFrame()` bypasses
  `shouldRender()` but not `recordWork`, which is the half that corrupts
  state. **Suspend `recordWork` for the duration of a lease.**
- `shouldRender()` mutates `lastFrameTime` as a side effect (lines 85-87;
  its own doc comment on line 49 warns callers not to call it
  speculatively). Bypassing it leaves the value stale for the whole lease,
  so the first frame after release always fires immediately — reset it on
  release.
- `renderNow()` must call **neither** `onFrame` (a screenshot should not
  advance the animation mixer) **nor** `recordWork` (a synchronous
  full-quality draw should not poison the average). Decide and document
  whether it calls `controls.update()`; if not, damping state and the
  rendered frame diverge.

**Evaluate `preserveDrawingBuffer` before building the `renderNow()`
apparatus.** Revision 1 added `renderNow()` to `Viewport`, an optional
method to `CaptureSource`, and a spike question — all to avoid a renderer
flag whose cost is a modest, well-understood copy on composite. Benchmark
the flag in Phase 0; if the cost is acceptable, much of this machinery is
unnecessary. (`renderNow()` stays useful regardless for deterministic
recording, so this is a simplification of the capture path, not a deletion
of the method.)

### 2.3 `shadows.ts` (new) — pure, zero GL surface

`applyShadowSettings(renderer, opts)`, `applyLightShadowSettings(light,
opts)`, `enableModelShadows(object, {cast?, receive?})`,
`fitShadowCamera(light, box, {padding?})`, `createShadowCatcher(box,
{opacity?, sizeFactor?})` / `updateShadowCatcher(...)`.

`fitShadowCamera` fixes the confirmed `[-5, 5, 5, -5, 0.5, 500]` default
frustum (`three/src/lights/DirectionalLightShadow.js:16`), which clips any
model larger than that.

**Shadows are a no-op on a large fraction of what these viewers actually
render, and the panel must say so.** `polygon.ts:228` builds
polygon-sourced models with `MeshBasicMaterial`; `mesh-shading.ts:51-54`
produces `MeshBasicMaterial` for `shading: 'unlit'` and
`MeshNormalMaterial` for `'normals'`. None of those receive shadows. Only
`textured` (restored glTF `MeshStandardMaterial`) and `faces`
(`MeshLambertMaterial`, `render-modes.ts:102`) show a shadow at all. So:

- Grey the shadows toggle on `shading ∈ {unlit, normals}` and on
  polygon-sourced models, the same way photo mode is greyed on
  `wireframe`/`points`.
- The Playwright luminance check must **pin a glTF asset in `textured`
  mode**, or it passes and fails by accident depending on selection.
- The default rig is `AmbientLight(0x606060, 1.2)` against a key of
  intensity 1.6 (`viewport.ts:76`) — that much ambient washes shadows out
  badly, possibly below an assertable delta. Dim ambient when shadows are
  enabled. **This is a behaviour change to existing consumers**, which the
  "default off — zero behavior change" framing does not cover; call it out
  in the phase-3 checkpoint.

**Offset the shadow-catcher plane off `box.min.y`.** `setGridBounds` puts
the `GridHelper` there too (`viewport.ts:202`), so an un-offset catcher is
coplanar with the grid and will z-fight.

### 2.4 `postprocessing.ts` (new) — the `cinematic` tier

Split **plan** (pure, fully unit-testable) from **construction**:

- `planCinematicPasses(opts: CinematicOptions) → CinematicPassPlan[]` —
  encodes pass ordering and the MSAA gotcha as data.
- `cinematicPlansEqual(a, b)` — true when only numeric params differ
  (mutate live uniforms), false on a shape change (rebuild the chain).
- `createCinematicPath(renderer, scene, camera, opts) → CinematicPath`
  (implements `RenderPath`).
- `applyToneMapping(renderer, opts)` — ACES + exposure, or restores
  `NoToneMapping`.

**Pass order is `render → gtao → bokeh → bloom → output → fxaa`.** Two
corrections from revision 1's `render → gtao → bloom → bokeh → fxaa →
output`:

- **FXAA goes after `OutputPass`, not before.** `OutputPass.js:20-22` says
  so explicitly: *"If a pass requires sRGB input (e.g. like FXAA), the pass
  must follow `OutputPass` in the pass chain."* FXAA's luma heuristic is
  calibrated on gamma-encoded values; on the linear HalfFloat buffer it
  detects edges wrongly.
- **DOF before bloom.** Blooming an already-defocused image is the
  conventional cinematic chain; revision 1's order blurred the bloom.

The MSAA gotcha is real — `EffectComposer.js:66` creates its targets as
`{ type: HalfFloatType }` with no `samples`, and `RenderTarget.js:63`
defaults `samples: 0`, so composer output loses the renderer's own
antialiasing. But **FXAA is not the only fix and arguably not the best
one**: `WebGLRenderTarget` supports `samples` (`RenderTarget.js:63, 194`),
so passing `new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 })`
into the `EffectComposer` constructor gives real MSAA on WebGL2 and keeps
sharp edges. FXAA smears pixel-art-derived geometry, which is most of what
these viewers show. Make the antialiasing strategy an option
(`'msaa' | 'fxaa' | 'none'`, default `'msaa'`) rather than a hard-coded
planner rule.

Tone mapping composes correctly with `OutputPass` and does not
double-apply: `WebGLRenderer.js:2351-2357` forces `NoToneMapping` whenever
`_currentRenderTarget !== null`.

**The AO cost clamp goes on the composer, not the renderer.**
`GTAOPass` is expensive at pixel ratio 2, but revision 1's
`renderer.setPixelRatio(1)` halves the canvas backing store and therefore
halves screenshot resolution — directly against a headline feature. Use
`EffectComposer.setPixelRatio()` (`EffectComposer.js:342`), which clamps
only the offscreen targets.

### 2.5 `photo-mode.ts` + `pathtracer-shim.ts` (new) — the `photo` tier

**This is much thinner than revision 1 proposed, because the library
already implements the requirement.** `WebGLPathTracer`'s declared surface
includes `rasterizeScene`, `renderDelay`, `minSamples`, `fadeDuration`,
`dynamicLowRes`, `lowResScale`, `pausePathTracing`, and `reset()`
(`three-gpu-pathtracer/src/index.d.ts:119-136`). Together those *are* the
interact/settle/converge behaviour: `rasterizeScene: true` falls back to
the raster image while moving, `updateCamera()` resets accumulation,
`renderDelay` is the settle window, `fadeDuration` crossfades raster →
traced. The headline requirement — "instantly reverts to real-time
rendering the moment the camera moves" — is one property assignment plus an
`updateCamera()` on the `controls` `change` event.

Revision 1's five-state `photoModeReducer` with a fake-clock test suite is
**deleted**. It solved a problem the dependency already solved, and worse,
its settle timer would have run concurrently with the library's
`renderDelay`/`fadeDuration` with no coordination between them. What
remains is a small UI-facing projection:

```ts
export type PhotoModePhase = 'off' | 'loading' | 'tracing' | 'converged';
```

derived from `pathTracer.samples`, the target sample count, and `controls`
events — enough for the panel to show progress, with no independent state
to drift.

The camera swap to `PhysicalCamera` (for true bokeh) stays; `PhysicalCamera
extends PerspectiveCamera`, so `setCamera(camera: THREE.PerspectiveCamera)`
types fine.

`pathtracer-shim.ts` remains the **only** file mentioning
`three-gpu-pathtracer`, and still hand-declares `PathTracerLike` /
`PhysicalCameraLike` rather than `import type`-ing them — that part was
sound. But it uses a **literal** `await import('three-gpu-pathtracer')`;
see the correction below. `three-gpu-pathtracer` and its `xatlas-web` peer
are **optional peer dependencies**, and `isPhotoModeAvailable()` lets a
host hide the row when absent.

### 2.6 `turntable.ts` (new)

`createTurntable(viewport, {durationSeconds?, loops?, direction?,
elevation?, easing?}) → Turntable` (`start`/`stop`/`dispose`).

**Driven via `OrbitControls.autoRotate`, not by writing `camera.position`.**
Revision 1 proposed a frame hook writing a computed position; frame hooks
fire before `controls.update()` (`viewport.ts:167-169`), and
`OrbitControls.update()` unconditionally recomputes the camera from its own
spherical state — `position.copy( this.target ).add( _v )`
(`OrbitControls.js:786`). Anything a hook writes is discarded microseconds
later, every frame, and the turntable would render a completely static
image.

`OrbitControls` already ships the feature: `autoRotate` /
`autoRotateSpeed` (`OrbitControls.js:318, 329`), gated on `state ===
_STATE.NONE` (line 700) so a user drag naturally overrides it. The pure,
testable core is therefore an **azimuth over time** —
`turntableAzimuth(elapsed, durationSeconds, loops, direction, easing) →
number` — not a position.

### 2.7 `session.ts` (modified)

- `shadows`/`cinematic`/`photoMode` state + `setShadows()`/
  `setCinematic()`/`setPhotoMode()` — thin delegation to the `Viewport`
  methods above, following the pattern `setTextureFilter`/
  `getMaxAnisotropy` already establish. Each installs a `RenderPath` via
  `viewport.setRenderPath`, so activating one implicitly replaces the
  other — mutual exclusivity is enforced by `Viewport`'s single slot, not
  re-implemented per method.
- `setModel`/`addModel` call `enableModelShadows()` on the new model when
  shadows are on.
- `setModel` and `fit()` both call `viewport.setSceneBounds(box)` (today
  only `fit()` calls `setGridBounds`, and only when `{fit: true}`) — this
  is the entire hook keeping the shadow-camera frustum and shadow catcher
  fit to whatever model is loaded.
- **Scene-content invalidation is one explicit concept, not ad-hoc hooks.**
  Revision 1 enumerated invalidation points and missed three:
  `setSmooth` and `setSubdivision` both route through `refreshPolish()` →
  `applyMeshPolish()` (`session.ts:133-137`), which **rebuilds the
  `BufferGeometry` in place** — invalidating any BVH or path-traced scene
  built over the old geometry — and `setColorMode` → `recolorPolygonModel`
  mutates vertex colours, which a path tracer needs told about. Call
  `viewport.invalidateSceneContents()` from **all five**: `refreshPolish`,
  `refreshAppearance`, `setColorMode`, `setModel`, `addModel`.
- `dispose()` disposes an active photo-mode controller before the viewport.

### 2.8 Docs (deliverable, not optional)

`packages/engine-3d/README.md`'s "Modules" section documents every file
one-by-one, and five are being added. [`docs/viewer.md`](viewer.md) is the
canonical integration guide and its §6 is "3D assets". Revision 1
remembered this for `mesh-viewer-ui` and forgot it for `engine-3d`.

### 2.9 Testability

Pure/no-mock (plain Node, same style as `render-modes.ts`): all of
`shadows.ts`, `postprocessing.ts`'s planner functions, `turntable.ts`'s
azimuth core, `pickVideoMimeType`, `drawWatermark`'s geometry.

`FakeWebGLRenderer` (in `viewport.test.ts`/`session.test.ts`) needs
extending with `shadowMap`, `toneMapping`/`toneMappingExposure`,
`getPixelRatio`/`getSize`/`getContext`. A `FakeRenderPath` recording
`render`/`setSize`/`setCamera`/`invalidateSceneContents`/`dispose` is how
the seam itself gets tested — never by constructing a real
`EffectComposer` or `WebGLPathTracer` in a test.

### 2.10 `raycasting.ts` — cut from v1, retained as a documented future tier

Revision 1 specified a `raycast` tier between `cinematic` and `photo`:
single-pass hybrid rasterization plus BVH-accelerated secondary rays
(shadows, AO, optional reflections) via `three-mesh-bvh`, deterministic and
recomputed every frame. **It is cut from v1.** The `RenderPath` seam means
adding it later costs nothing already paid for. Two problems have to be
solved first, and neither was budgeted:

- **It hides a G-buffer.** A screen-space pass cannot cast a shadow ray
  without a world-space origin and normal per pixel, which means a
  depth+normal prepass that revision 1 never mentioned, budgeted, or put in
  the module signature. (`GTAOPass` has exactly this machinery internally,
  which is why it is the expensive pass.)
- **The alternative wiring is incompatible with this codebase.** The other
  reading — `onBeforeCompile` injection into the scene's own materials,
  which is how `three-mesh-bvh`'s own shadow/AO demos are built — breaks
  because `applyRenderMode` and `applyMeshShading` swap `mesh.material`
  wholesale on every `setRenderMode`/`setShading`/`setSmooth` call. Every
  such swap silently drops the injection, and revision 1 only rebuilt on
  `setModel`/`addModel`.

Also, the cost model was asserted without evidence. One shadow ray per
pixel at 1080p is ~2M fragment-shader BVH traversals per frame; the
proposed default `ao: { samples: 8 }` is ~16M. The relevant question is not
whether that beats path tracing (it does, trivially) but whether it beats
shadow maps + GTAO — and per-pixel BVH traversal very likely does not. For
PSX-era game models, a shadow-mapped + GTAO render is not visibly
deficient, so the user-visible gap this tier would fill is thin on both
sides.

What *was* confirmed, for whenever this is picked up:
`three-mesh-bvh@0.9.14` does ship the GPU shader-integration surface
assumed — `MeshBVHUniformStruct`, `BVHShaderGLSL`, `shaderStructs`,
`shaderDistanceFunction`, `shaderIntersectFunction`
(`src/index.d.ts:402-419`). And **BVH sharing with the path tracer is not
possible**: `WebGLPathTracer` has no injection point (only the deprecated
`PathTracingSceneGenerator` ever exposed `.bvh`), and it wouldn't help
anyway — the path tracer's BVH is built over a merged, flattened
whole-scene geometry, while a raycast tier needs per-`BufferGeometry`
`MeshBVH` instances. Revision 1's "the two share one BVH build" argument is
withdrawn.

## Part 3 — `@seer-project/mesh-viewer-ui`

Scoped purely to **3D render-quality controls** — export lives in
`canvas-export`.

- **`render-settings-panel.ts`** (new) — `RenderSettingsPanel` class, same
  host-owns-DOM / `attach` / `refresh` / `detach` / `dispose` contract as
  `MeshSettingsPanel`. One popover (`🎬 Render`) holding: a
  **render-quality selector** (`flat` / `cinematic` / `photo` — a
  `<select>`, per the mutual-exclusivity table), a shadows toggle (greyed
  per tier **and** per §2.3's material gating), bloom/AO/DOF toggles +
  strength/focus controls (under `cinematic` only), photo-mode progress
  (under `photo` only), and two export buttons (`📷 Screenshot`, `⏺ Record
  turntable`) calling straight into `canvas-export` —
  `RenderSettingsPanel` builds the `CaptureSource` / watermark text /
  recording `driver` from the attached `MeshSession` and hands them over;
  it contains no capture or encoding logic of its own. Photo mode is
  disabled (with a tooltip) when `renderMode` is `'wireframe'`/`'points'`.
  Elements past the required toggle/panel fields are optional, so chimera
  can ship a reduced panel as it already does for the settings panel.
- `mesh-settings-panel.ts` imports `createPopover` from
  `@seer-project/canvas-export`, adding it as a dependency of
  `mesh-viewer-ui` — the correct direction, 3D-specific depending on
  generic.
- `index.ts`/`README.md` updated: new export, new dependency documented,
  integration example matching the existing style.

## Part 4 — Rollout (siren → flower → chimera)

Established fully in siren first, then repeated:

- **`package.json`**: add `"@seer-project/canvas-export":
  "file:../seer/packages/canvas-export"`. **This is not optional and
  revision 1 omitted it.** `@seer-project/*` is unpublished (`npm view
  @seer-project/engine-3d` 404s) and every consumer links each package
  individually with `file:`. `mesh-viewer-ui` declaring `canvas-export` at
  `^0.1.0` resolves today only for `engine-3d`, and only because the
  consumer *also* declares it as a top-level `file:` link that npm dedupes
  against. Without the equivalent line, `npm install` goes to the registry
  and 404s in all three projects.
- `index.html`: a second `.settings-anchor` block (`#render-settings` /
  `#render-settings-toggle` / `#render-settings-panel`) sibling to
  `#mesh-settings`.
- `viewer.css`: new toggle/panel selectors alongside the existing ones,
  **`right: 0` anchoring** — the overflow bug from the settings-panel work
  applies here too, and more so since this anchor sits further right
  (`viewer.css:168` is the existing precedent).
- `viewer.ts`: construct one `RenderSettingsPanel`, wire `attach()`/
  `detach()` beside the existing `meshSettingsPanel` calls, add a
  `watermarkText()` builder from data the viewer already has (asset name,
  game display name + platform, project name).

**flower-specific**: `attach()` only on the single-model path
(`drawMeshAsset`), never on `drawSceneAsset`/`loadPlacedScene` — same
constraint as the existing settings panel.
**chimera-specific**: extend its per-option disabled-tooltip layer to cover
the photo-mode row when unavailable; may ship the reduced panel.

## Testing

**`canvas-export`** (plain-Node/jsdom mix, same style as `audio-ui`):
`screenshot.test.ts` (watermark text/position/scaling, `renderNow()`-
before-capture ordering via a fake `CaptureSource`, canvas-as-getter
honoured, identity fast-path when no watermark), `video-export.test.ts`
(mime-type fallback chain — pure; `recordClip` calling `driver.start()`/
`stop()` at the right times against a fake driver + fake `MediaRecorder`),
`popover.test.ts` (new, incl. the teardown/unsubscribe path).

**`engine-3d`** — new pure-Node files: `shadows.test.ts`,
`postprocessing.test.ts` (planner only, incl. FXAA-after-output ordering
and the msaa/fxaa/none strategy), `turntable.test.ts` (azimuth core).
Extended jsdom tests in `viewport.test.ts` (render-path swap/dispose,
`addFrameHook` ordering vs. `setOnFrame`, a lease suspending `recordWork`
and resetting `lastFrameTime` on release, `renderNow` skipping `onFrame`
and `recordWork`, `setCamera` repointing controls, shadow config wiring,
`setSceneBounds`/`setGridBounds` alias) and `session.test.ts` (shadow
application on model load, tier mutual-exclusivity, invalidation firing
from all five call sites, photo-mode disposal ordering).

**`mesh-viewer-ui`** — `render-settings-panel.test.ts` (attach/detach incl.
forcing photo mode off, tier-selector→setter wiring, sub-option rows shown
per tier, shadows greyed per shading mode and model source, export buttons
delegating to `canvas-export` with a correctly-built `CaptureSource`/
driver, optional-elements-absent construction).
`mesh-settings-panel.test.ts` keeps passing after the popover extraction —
necessary but not sufficient; see §1.1.

**Playwright, per project (siren, then flower, then chimera)**: open `🎬
Render`; toggle shadows **on a pinned glTF asset in `textured` mode** and
assert a luminance drop in the lower third; switch to `cinematic`, toggle
bloom/AO/DOF individually and assert each changes the image; switch to
`photo` and assert a strictly-increasing sample counter across ≥3 distinct
values, that dragging the camera falls back to the raster image within
~200ms and it resumes accumulating after the settle window, and that
turning it off restores the prior tier; export a screenshot and assert the
watermark region differs from an un-watermarked capture; record a 2-second
turntable clip and assert a valid non-empty blob **of the negotiated mime
type**; repeat the clip export against a skeletal asset using the
animation-clip driver; regression-check that render mode/shading changes
still show through under every tier.

## Phases

Every phase carries a stated exit criterion — revision 1 gave real gates to
two phases and left five with none, including the two where the
shadow-material and pass-ordering problems surface.

0. **Probe** (throwaway code only) — (a) install `three-gpu-pathtracer` and
   `three-mesh-bvh` in siren and run `tsc --noEmit` to measure the actual
   type-augmentation damage; (b) benchmark `preserveDrawingBuffer` against
   `renderNow()` + `toBlob()`; (c) confirm `OrbitControls.object`
   reassignment works for the camera swap.
   *Exit: written findings; (a) decides whether §2.5's containment
   machinery survives at all.*
1. **`canvas-export` + siren screenshot export** — popover extraction,
   `CaptureSource`, screenshot, watermark, deterministic recorder.
   *Exit: a watermarked PNG downloads from siren against today's renderer;
   `mesh-settings-panel.test.ts` green; new `popover.test.ts` green.*
2. **Render-path seam** — `render-path.ts`, `viewport.ts`, frame-limiter
   fixes.
   *Exit: zero visible behaviour change; engine-3d suite green; all three
   consumers build.*
3. **Shadows** (incl. material gating and ambient dimming).
   *Exit: Playwright luminance drop on a pinned glTF asset; toggle greyed
   correctly on `unlit`/`normals`/polygon models; no grid z-fighting.*
4. **Cinematic postprocessing.**
   *Exit: each of bloom/AO/DOF individually changes the image; antialiasing
   strategy switchable; screenshot resolution unchanged with AO on.*
5. **Photo mode** (gated on Phase 0a).
   *Exit: sample counter advances; camera drag falls back to raster within
   ~200ms and resumes; exit restores the prior tier.*
6. **Turntable + video export wiring.**
   *Exit: a 2s clip records at the requested duration on both a fast and an
   artificially throttled frame budget, watermarked.*
7. **`mesh-viewer-ui` render panel** — screenshot button migrates here.
   *Exit: panel unit tests green; siren still exports.*
8. **siren integration** + full Playwright pass. 9. **flower** (placed-scene
   guard verified). 10. **chimera** (tooltip layer extended).

Phases 1–7 are checkpointable commits in `seer` alone; 8–10 are independent
commits, one per downstream repo, each separately verified before moving on
— same discipline as the settings-panel rollout.

## Corrections from review

Kept in the document because several of these are errors that would
otherwise be re-derived. All verified against installed sources.

1. **The non-literal dynamic import does not work.** Revision 1's
   containment strategy hinged on `import(someVariable)` so TypeScript
   couldn't resolve the `.d.ts`. The TypeScript half is true; the runtime
   half is not. A non-literal specifier is opaque to Vite's import analysis
   and to Rollup — Vite leaves it untransformed and the browser throws
   `Failed to resolve module specifier` on a bare specifier with no import
   map; `vite build` externalises it with the same result. All three
   consumers are Vite. `optimizeDeps.include` pre-bundles a dependency; it
   does not make an unanalysable specifier resolvable at runtime.
   **→ Use a literal `await import('three-gpu-pathtracer')`, which Vite
   code-splits natively, giving the lazy-load benefit for free.**
2. **The type-augmentation threat was overstated.** `three-mesh-bvh`
   augments `'three'` (a *module* augmentation, not a global ambient one)
   and every added member is **optional** — inert for existing code
   (`src/index.d.ts:326-343`). `three-gpu-pathtracer` adds two non-optional
   members to `MeshStandardMaterial` (`src/index.d.ts:29-47`), but they
   merge into a *class* declaration, so `new THREE.MeshStandardMaterial({…})`
   is unaffected; it only bites object-literal assignment to a
   `MeshStandardMaterial`-typed slot, which nothing in `engine-3d/src`
   does. Both `seer/tsconfig.json:7` and `siren/tsconfig.json:7` set
   `skipLibCheck: true`. **→ On the expected zero-damage Phase 0a result,
   delete the two sub-entrypoints, the `readonly bvh: unknown` opacity, and
   the "promote to a separately published package" contingency.** That was
   a large amount of architecture riding on an unmeasured premise.
3. **The turntable could not have moved the camera.** See §2.6.
4. **FXAA was on the wrong side of `OutputPass`**, and **DOF after bloom**.
   See §2.4.
5. **`mesh-viewer-ui/src/popover.ts` does not exist** — it is an
   extraction, not a move, and `createPopover` must return an unsubscribe.
   See §1.1.
6. **Rollout would have broken `npm install`** in all three consumers. See
   Part 4.
7. **Shadows are a no-op on most assets**, and the ambient rig washes out
   the rest. See §2.3.
8. **Invalidation missed `setSmooth`/`setSubdivision`/`setColorMode`.** See
   §2.7.
9. **Photo mode's state machine duplicated `WebGLPathTracer`'s own
   `rasterizeScene`/`renderDelay`/`fadeDuration`** and would have fought
   it. See §2.5.
10. **Two of Phase 0's three spike questions were already answerable from
    the published `.d.ts` files, and one answers *no*** (no BVH injection
    point). See §2.10. The broader lesson: deferring the raycast tier's
    *shader wiring* to a spike was legitimate; deferring an *API surface*
    that `curl | tar -xzO package/src/index.d.ts` settles in a minute was
    not.

Also noted, and adopted: `EffectComposer.setPixelRatio` instead of
`renderer.setPixelRatio` for the AO clamp; deterministic fixed-timestep
recording instead of wall-clock `captureStream`; asserting the negotiated
mime type instead of WebM magic bytes; evaluating `preserveDrawingBuffer`
before building the `renderNow()` capture path; the shadow-catcher/grid
z-fight; and `canvas-export` moving from Phase 7 to Phase 1.

## Noted implementation risks

- `Viewport.camera` becomes a getter (currently a plain field) — grep
  flower/chimera during rollout for any code that *assigns* it directly.
- Phase 0a could still find real type-augmentation damage. If so, the
  sub-entrypoint approach returns — but with a **literal** dynamic import
  inside it, per correction 1.
- Dimming ambient light when shadows are enabled is a visible change to
  existing consumers, not a purely additive feature.

## Deferred (separate future plans — not touched here)

- **The `raycast` tier** — see §2.10 for what has to be solved first.
- Skeletal animation editing (bone posing / keyframe authoring).
- Custom export backgrounds (2D/3D environments, potentially sourced from
  extracted game assets).
- 2D sprite-viewer equivalent of shadows/cinematic/photo — none of those
  concepts apply to flat sprite art; see
  [`docs/2d-export-proposal.md`](2d-export-proposal.md) for what *does*
  carry over.
