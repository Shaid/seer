# @seer-project/engine-3d

Format-agnostic three.js viewport, glTF loading, and a `{verts,edges,faces}`
polygon-model adapter shared by @seer-project's 3D mesh viewers.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

This package settles the question an earlier design proposal
([`docs/engine-3d-proposal.md`](https://github.com/Shaid/seer/blob/main/docs/engine-3d-proposal.md)) left open — "which model
shape does a generic 3D engine assume?" — by not picking one. Two paths are
first-class:

- **glTF-native** (`gltf.ts`) — a real glTF 2.0 document loaded via
  `THREE.GLTFLoader` and used as-is: real PBR materials, real textures, real
  baked `AnimationClip`s. This is Drakengard 3's shape (flower), and the
  reason this package exists at all rather than assuming every 3D asset is a
  hand-rolled vert/face intermediate.
- **polygon adapter** (`polygon.ts`) — hunter/Carrier Command's raw
  `{verts, edges, faces}` JSON, normalized and built into merged
  `BufferGeometry`s (one for faces, one for lines, one for points — not one
  mesh per face, unlike the viewer this was extracted from).

Both converge on one shape: `Model3D.object: THREE.Object3D` — the one thing
a host ever needs to add to a scene, regardless of which path produced it.
Everything else in the package (`viewport.ts`, `animation.ts`,
`session.ts`, `stats.ts`, `dispose.ts`) operates on that shape alone and
never branches on where a given model came from; only `render-modes.ts`
(and, for color, `polygon.ts`'s `recolorPolygonModel`) ever look at
`model.source`.

What this package deliberately does **not** do: no per-game palette or
color-decode logic (hunter's own `PALETTE`/`fillToColor` stay in hunter's
project, injected via `color-modes.ts`'s `createPaletteResolver`), no
lossy re-coloring of a glTF model's real materials (Carrier Command's
attribute-byte fill data and Epic's real glTF material colors both render
as themselves — see `docs/*` in each consuming project for why that used
to not be true), and no scaffold-template/manifest wiring — a host still
owns loading its own manifest and calling into this package per selected
asset.

## Installation

```bash
npm install @seer-project/engine-3d three
```

Requires `three ^0.185.1` as a peer dependency (pin your own `three` to the
same range — two different `three` module instances in one page fail
`instanceof` checks against each other's classes).

## Usage

```ts
import { createMeshSession, loadGltfModel, buildPolygonModel, normalizePolygonSet } from '@seer-project/engine-3d';

const session = createMeshSession(document.getElementById('viewport')!, {
  cameraPosition: [3, 2, 4],
  grid: 'auto',
});

// glTF path
const model = await loadGltfModel(`${ASSET_BASE}/meshes/${asset.name}.gltf`);
session.setModel(model);

// polygon path
const raw = await fetch(`${ASSET_BASE}/objects-geometry.json`).then((r) => r.json());
const [polygonModel] = normalizePolygonSet(raw);
session.setModel(buildPolygonModel(polygonModel));

// later, on switching assets / leaving the viewer
session.dispose();
```

`session.disposed` is `true` after `dispose()` — the same in-flight-load
guard shape both consuming projects already use (`if (session.disposed)
return;` after an `await`, same as the `MeshViewerState`/`selectedObject`
identity checks each viewer had before this package existed).

## Modules

### `types.ts`

The shared vocabulary: `PolygonModel`/`PolygonFace` (the normalized
`{verts,edges,faces}` shape), `Model3D` (the one thing every other module
produces or consumes), and `ModelRepresentations` (the internal
faces/lines/points/originalMaterials bookkeeping a `Model3D.repr` carries).

### `frame-limiter.ts`

Adaptive frame-rate limiter — caps rendering at a target fps (60 by
default), with a hysteresis-banded fallback (30 by default) under load.

| Function | Description |
| --- | --- |
| `createFrameLimiter(opts?)` | Builds a `FrameLimiter`. `opts.now` injects a clock — real code omits it (`performance.now()`), tests supply a fake one. |

`FrameLimiter.shouldRender()` — call once per host tick; `.recordWork(ms)` —
report how long the frame actually took, feeding the adaptive threshold;
`.resetClock()` — marks "now" as the last-render time without asserting a
render happened, for a caller (`Viewport.requestEveryFrame()`) that bypassed
`shouldRender()`'s gate for a stretch and doesn't want the next real call to
see a stale gap and fire an unwanted immediate catch-up render.

### `render-path.ts`

The seam that makes `Viewport`'s draw call swappable across render tiers
(`flat` / `cinematic` / `photo` — see
[`render-quality-proposal.md`](https://seer.shaid.net/guides/render-quality/))
without touching the `onFrame`/frame-limiter contract.

| Type | Description |
| --- | --- |
| `RenderPath` | `render(scene, camera, deltaSeconds)` plus optional `setSize`/`setCamera`/`invalidateSceneContents`/`dispose`. `null` installed on `Viewport` means today's plain `renderer.render(scene, camera)` — every existing consumer sees zero change until a host opts into a tier via `Viewport.setRenderPath()`. |

### `shadows.ts`

Pure functions for shadow-map setup — no `RenderPath` of its own, since
shadow-casting is a renderer/light/material concern orthogonal to the
render-tier seam (shadows apply under both `flat` and `cinematic`).

| Function | Description |
| --- | --- |
| `applyShadowSettings(renderer, enabled)` | Toggles `renderer.shadowMap.enabled`; sets `PCFSoftShadowMap` when enabling. |
| `applyLightShadowSettings(light, opts?)` | Shadow-map resolution/bias/normalBias/radius on one light. |
| `enableModelShadows(object, opts?)` | Sets `castShadow`/`receiveShadow` on every mesh under `object` — call whenever a model loads while shadows are on. |
| `fitShadowCamera(light, box, opts?)` | Fits the light's orthographic shadow-camera frustum to `box`, replacing three.js's default `[-5,5,5,-5,0.5,500]` (which silently clips any model bigger than ~10 units) — also repoints `light.target` at the box center. |
| `createShadowCatcher(box, opts?)` / `updateShadowCatcher(catcher, box, opts?)` | A `ShadowMaterial` plane (invisible except where a shadow falls) sized/positioned to sit just under `box`, offset below `box.min.y` to avoid z-fighting the `'auto'` grid, which sits exactly at `box.min.y`. |

`Viewport.setShadows()` is the actual integration point — it wires all of
the above together (renderer flag, key-light shadow settings, frustum
fitting, catcher lifecycle, ambient-light dimming) against whatever the
key light and last-reported scene bounds are.

### `postprocessing.ts`

The `cinematic` tier — a `RenderPath` implementation wrapping a real
`EffectComposer`/pass chain (bloom, ambient occlusion, depth of field,
ACES tone mapping).

| Function | Description |
| --- | --- |
| `planCinematicPasses(opts)` | Pure — the pass composition/ordering a given `CinematicOptions` produces, as data (`render → gtao → bokeh → bloom → output → fxaa`; DOF before bloom, FXAA strictly after `OutputPass` per its own doc comment). No `EffectComposer` involved — fully unit-testable. |
| `cinematicPlansEqual(a, b)` | Pure — `true` when two plans have the same pass shape (numeric option values never appear in a plan, so they're correctly invisible here); `false` on any composition/order change. Drives the reuse-existing-chain-vs-rebuild decision `CinematicPath.setOptions()` needs. |
| `createCinematicPath(renderer, scene, camera, opts)` | Builds the real chain per `planCinematicPasses(opts)`. `antialias` (default `'msaa'`) picks how the composer's own antialiasing loss is fixed — `EffectComposer`'s offscreen targets don't inherit the renderer's own AA — via a real multisampled `WebGLRenderTarget` (`samples: 4`, sharp edges, the default) or an `FXAAPass` (softer, smears pixel-art-derived geometry, an explicit opt-in fallback). AO's pixel-ratio cost clamp is applied via `EffectComposer.setPixelRatio()`, not the renderer's — clamping the renderer's own pixel ratio would also halve screenshot resolution. |
| `applyToneMapping(renderer, opts)` | ACES filmic + exposure, or restores `NoToneMapping`. A renderer-level property `OutputPass` reads — opt-in like every other cinematic effect here, not implied by the tier alone. |

`MeshSession.setCinematic()` is the actual integration point (see
`session.ts` below) — `createCinematicPath` and `cinematicPlansEqual` are
exported mainly for testing and for a host that wants to manage a
`CinematicPath` itself outside a `MeshSession`.

### `photo-mode.ts` + `pathtracer-shim.ts`

The `photo` tier — a progressive path-traced render via
[`three-gpu-pathtracer`](https://www.npmjs.com/package/three-gpu-pathtracer),
an **optional peer dependency** (with `three-mesh-bvh`/`xatlas-web`, its own
peers) declared in `peerDependenciesMeta` as optional — a host that never
calls `setPhotoMode`/`createPhotoMode` never needs to install it.

| Function | Description |
| --- | --- |
| `isPhotoModeAvailable()` | Whether `three-gpu-pathtracer` is installed and importable — a host uses this to hide the photo-mode UI row rather than surfacing a raw import failure. |
| `createPhotoMode(viewport, opts?)` | **Async**, unlike every other render-tier constructor here — the package is lazy-loaded and building its BVH over the current scene both take real time. Swaps in a `PhysicalCamera` (for true depth-of-field/aperture; `extends PerspectiveCamera`, so `Viewport.setCamera()` accepts it) matching the outgoing camera's framing, restored on `dispose()`. |

**Needs no state machine.** `WebGLPathTracer`'s own `rasterizeScene`/
`renderDelay`/`minSamples`/`fadeDuration` already implement "shows the
rasterized image while the camera moves, crossfades into the traced one
once it settles" — `PhotoModeController.render()` is just one call to
`renderSample()` (`WebGLPathTracer.renderToCanvas`, on by default,
composites its own output directly). Wiring `viewport.controls`' `change`
event to the library's own `updateCamera()` (which internally calls its own
`reset()`) is the entire "instantly reverts to real-time the moment the
camera moves" requirement. `PhotoModeController.phase` (`'tracing'` /
`'converged'`) is derived live from `pathTracer.samples` vs.
`PhotoModeOptions.targetSamples` — a UI-facing threshold distinct from the
library's own `minSamples` (the minimum before the traced image starts
fading in at all).

`pathtracer-shim.ts` is the only file mentioning `three-gpu-pathtracer` by
name — hand-declared `PathTracerLike`/`PhysicalCameraLike` types, never
`import type`-ed from the real package (cheap hygiene, not a measured-risk
mitigation — Phase 0's probe found zero real damage from that package's
ambient `MeshStandardMaterial` augmentation in this codebase), and a
**literal** `await import('three-gpu-pathtracer')` — a computed specifier
doesn't survive Vite's import analysis at runtime, only a literal one gets
code-split.

`MeshSession.setPhotoMode()` is the actual integration point (see
`session.ts` below), and the one place the async-ness and the
mutual-exclusivity-with-`cinematic` race it introduces are actually
handled — this module's own async factory has no opinion about what else
might claim the render-tier slot while it's building.

### `viewport.ts`

Generic scene/camera/renderer/controls/resize/render-loop bootstrap.

| Function | Description |
| --- | --- |
| `createViewport(container, opts?)` | Builds a `Viewport` scoped entirely to `container` — no module-level globals, so multiple viewports on one page never interfere. |

Every consuming project's divergent settings (background color, near/far,
starting camera position, grid, lighting, damping) are `ViewportOptions`
fields rather than hardcoded — that parameterization is what lets one
implementation cover both flower's and hunter's original viewports.
`Viewport.dispose()` cancels its own *currently pending* frame (not just the
first one ever scheduled — a real bug in the original code this replaces).

`Viewport.camera` is a getter, not a plain field — `setCamera()` can swap
the active camera (for a future photo-mode `PhysicalCamera`), repointing
`controls.object` and notifying the installed `RenderPath` in the same
call. `setRenderPath(path | null)` installs/removes a render tier, disposing
whatever different path was previously installed (installing the same
instance again is a no-op). `addFrameHook(fn)` adds an additional per-frame
callback alongside the single `setOnFrame` slot the animation mixer already
claims — hooks run after `onFrame`, in subscription order.
`requestEveryFrame()` returns a refcounted lease-release function: while any
lease is outstanding, every render-loop tick renders regardless of the
frame limiter's gate, and none of those frames feed the limiter's adaptive
sampling (a lease-covered frame's cost — e.g. one path-tracer sample — says
nothing about steady-state real-time cost and would otherwise corrupt the
fallback-fps heuristic). `renderNow()` draws one frame synchronously,
outside the render loop's own cadence, for a caller that needs the canvas
freshly drawn before reading its pixels (a screenshot; a frame-stepped video
capture) — deliberately calls neither `onFrame`/the frame hooks nor
`controls.update()`, and doesn't feed the frame limiter.
`invalidateSceneContents()` tells the installed `RenderPath` that scene
contents changed underneath it (geometry rebuilt, materials swapped, model
replaced) so it can rebuild whatever state it derived from the scene (a
BVH, an accumulated path-traced image). `setSceneBounds(box)` replaces
`setGridBounds` (kept as a deprecated forwarding alias) — same
`'auto'`-grid-fitting behavior, renamed since it now also feeds
shadow-frustum fitting.

`setShadows(opts)` turns shadow-casting on/off — see `shadows.ts` above for
the pure pieces it composes. Beyond "a shadow appears," enabling it also
**dims ambient light to 40% of whatever the host configured** (the default
rig's `AmbientLight(0x606060, 1.2)` against a `1.6`-intensity key would
otherwise wash a shadow out almost to invisibility), a real, visible scene
change restored exactly on disable. Only the key light casts — `false` on
`lights.key` makes this a no-op. The shadow-camera frustum and
shadow-catcher plane track whatever `setSceneBounds()` was last called
with, so a host needs to keep calling it as models change (`MeshSession`
does this automatically — see `session.ts` below).

### `camera-fit.ts`

| Function | Description |
| --- | --- |
| `computeCameraFit(box, fovDeg, opts?)` | Pure bounding-sphere fit math. Returns `null` for an empty box. |
| `fitCameraToObject(camera, controls, object, opts?)` | Applies the fit to a real `PerspectiveCamera`/`OrbitControls` pair, framing `object`'s current bounds. |

### `dispose.ts`

| Function | Description |
| --- | --- |
| `disposeObject3D(obj)` | Disposes geometry + every material + every texture referenced by any material property (not a fixed key list) under `obj`, duck-typed to `Mesh`/`SkinnedMesh`/`Points`/`LineSegments` rather than a hard `instanceof THREE.Mesh`. |

### `polygon.ts`

The `{verts,edges,faces}` → `Object3D` adapter.

| Function | Description |
| --- | --- |
| `normalizePolygonModel(raw, index)` | Normalizes one raw object: aliases `vertices`/`verts`, `effectId`/`type_hi`/`flags`; accepts faces as `{verts,fill}` or bare `number[]`. |
| `normalizePolygonSet(raw)` | Normalizes a whole document — a bare array or a `{objects:[...]}` wrapper. |
| `buildPolygonModel(model, opts?)` | Builds a `Model3D`: one merged `BufferGeometry` each for faces/lines/points, toggled by `.visible` — no rebuild on a render-mode switch. |
| `recolorPolygonModel(model, mode, resolver?)` | Rewrites the faces geometry's `color` attribute in place for a new `ColorMode`. No-op for a glTF-sourced model (see "Render & color mode applicability" below). |
| `triangulateFan(vertexCount)` | Pure fan-triangulation helper (`[0,1,2, 0,2,3, ...]`), exported for direct testing. |
| `computeModelEdges(model)` | Pure edge-dedup helper: prefers declared `edges[]`, else derives from face rings, deduping `(a,b)` against `(b,a)`. |

`normalizePolygonModel`/`normalizePolygonSet` are the fix for Carrier
Command's data bug: its current `models.json` stores bare `[v0,v1,v2]` face
arrays under a `vertices` (not `verts`) key — both normalize cleanly to the
same `PolygonModel` shape hunter's own `{fill,verts}` objects do, with a
bare face's `fill` defaulting to `0` rather than throwing.

### `color-modes.ts`

The per-game palette injection point.

| Function | Description |
| --- | --- |
| `createPaletteResolver(palette, decodeIndex)` | Builds a `ColorResolver` for `'palette'` mode from a caller-owned flat palette + a fill-word decode function. Nothing Amiga-specific lives in this package — hunter calls `createPaletteResolver(PALETTE, f => (f>>8)&0xf)` from its own project. |
| `resolveColor(mode, ctx, resolver?)` | Resolves one face/vertex's color for any of the four `ColorMode`s. `'height'` mode's range comes from `ctx.heightRange` (derived from the model's own bounding box), not a hardcoded constant. |

### `render-modes.ts`

Where the glTF/polygon structural gap is absorbed — see the applicability
table below.

| Function | Description |
| --- | --- |
| `supportedRenderModes(model)` | Which of `'textured'\|'faces'\|'wireframe'\|'points'` `model` can actually display. |
| `defaultRenderMode(model)` | The mode to start on — `'textured'` for glTF, the richest supported mode for polygon. |
| `applyRenderMode(model, mode)` | Switches the visible representation, building/caching glTF's flat materials and points representation lazily. Falls back to `defaultRenderMode(model)` for an unsupported `mode` rather than rendering nothing. |

### `mesh-shading.ts`

A shading override layered on top of `render-modes.ts`'s render mode — one
generated material per mesh for `'unlit'\|'normals'\|'depth'\|'toon'`,
or just a `flatShading` toggle on the mesh's own real material for `'lit'`.
No-op for a polygon model, and for `renderMode === 'wireframe'\|'points'`
(already flat/unlit by construction).

| Function | Description |
| --- | --- |
| `applyMeshShading(model, cache, opts)` | Applies `opts.shading`/`opts.smooth` (deferring to `opts.renderMode`), rebuilding `cache` from scratch each call. |
| `clearGeneratedShadingMaterials(cache)` | Disposes everything in `cache` and empties it. |

### `mesh-polish.ts`

Browser-side geometry subdivision + smooth-normal averaging, rebuilt from a
captured original on every change so repeated subdivision levels never
compound. glTF-only (a polygon model has no per-mesh geometry to rebuild).

| Function | Description |
| --- | --- |
| `captureOriginalGeometry(model)` / `disposeOriginalGeometry(cache)` | Clone-and-remember (and later dispose) each mesh's baseline geometry — call once per `setModel`. |
| `applyMeshPolish(model, originalGeometry, opts)` | Rebuilds each mesh's geometry from `originalGeometry` at `opts.subdivision` intensity, smooth- or flat-normaled per `opts.smooth`. |
| `subdivideGeometry(source, multiplier)` / `applySmoothNormals(geometry)` | The two underlying geometry transforms, exposed standalone for a host that wants just one of them. |

### `texture-filter.ts`

| Function | Description |
| --- | --- |
| `applyTextureFilter(model, options, maxAnisotropy?)` | Sets mag/min filter + mipmap generation + anisotropy on every texture referenced by `model`'s *original* materials (not just whichever material a render mode/shading override currently has assigned), so a filter choice survives switching render modes. `options.mode` is `'nearest'\|'linear'\|'trilinear'`; `options.anisotropy` is clamped to `maxAnisotropy` (read `session.getMaxAnisotropy()`, or `renderer.capabilities.getMaxAnisotropy()` directly). No-op for a polygon model. |

### `animation.ts`

| Function | Description |
| --- | --- |
| `createAnimationController(root, clips)` | Builds an `AnimationController` (mixer + named-clip playback with crossfade) over `root`'s clips. Returns `null` for an empty `clips` array. |

Wire `controller.update` into `ViewportOptions.onFrame` (or let
`createMeshSession` do it automatically via `session.setModel`).

### `placed-scene.ts`

| Function | Description |
| --- | --- |
| `loadPlacedScene(root, placements, resolveUrl, opts?)` | Loads and assembles a placed scene: dedupes by mesh name, loads every distinct mesh in parallel, tolerates individual mesh failures, `.clone()`s (sharing GPU buffers) + transforms one instance per placement. `resolveUrl` replaces a hardcoded `${ASSET_BASE}/meshes/${name}.gltf` convention with a callback the host still owns. |

### `gltf.ts`

| Function | Description |
| --- | --- |
| `loadGltfModel(url, loader?)` | Loads a glTF document and converts it to a `Model3D`. |
| `toModel3D(gltf)` | Converts an already-loaded glTF document (`{scene, animations}`) to a `Model3D`, capturing each mesh's original material and whether any mesh carries a real texture map. |

### `stats.ts`

| Function | Description |
| --- | --- |
| `meshStats(object)` | Vertex/triangle counts under `object`, skipping any non-visible representation (a polygon model has three sibling representations; only one is ever visible). |

### `session.ts`

The orchestrator — one viewport, the active model (if any), and its
animation controller (if any).

| Method | Description |
| --- | --- |
| `createMeshSession(container, opts?)` | Builds a `MeshSession`. |
| `session.setModel(model, opts?)` | Replaces the session's contents, disposing whatever was shown before. `opts.fit` (default `true`) frames the camera; `opts.renderMode` overrides `defaultRenderMode(model)`. |
| `session.addModel(model)` | Adds `model` alongside whatever's already shown, without disturbing it — for a host assembling several independently-built `Model3D`s into one scene. |
| `session.setRenderMode(mode)` / `session.setColorMode(mode, resolver?)` | Switch modes on the active model. |
| `session.setShading(mode)` / `session.setSmooth(bool)` | Switch shading override / smooth-vs-flat normals — see `mesh-shading.ts`. Both reset to `'lit'`/`false` on every `setModel`. |
| `session.setSubdivision(multiplier)` | Rebuild geometry at a subdivision intensity — see `mesh-polish.ts`. Resets to `0` on every `setModel`. |
| `session.setTextureFilter(options)` / `session.getMaxAnisotropy()` | Set filter/anisotropy on the active model's textures — see `texture-filter.ts`. Unlike shading/smooth/subdivision, this **persists across `setModel`** (a viewer-wide preference, not a per-model one). `getMaxAnisotropy()` reads `renderer.capabilities.getMaxAnisotropy()`. |
| `session.setShadows(opts)` | Thin delegation to `viewport.setShadows()` — also **persists across `setModel`/`addModel`** like `textureFilter`, applying `enableModelShadows()` to whichever model is current and to every future one automatically. |
| `session.setCinematic(opts)` | Switches the `cinematic` render tier on/off, or updates it in place — thin delegation to `viewport.setRenderPath()`. **Persists across `setModel`** like `shadows`/`textureFilter` (viewport-scoped, not per-model). A same-shape update (only numeric option values changed) reuses the existing `EffectComposer` chain via `CinematicPath.setOptions()`; a shape change (an effect toggled, the antialias strategy changed) disposes it and builds a fresh one — see `postprocessing.ts` above. Installing `cinematic` implicitly replaces whichever other render tier was active; `Viewport`'s single `renderPath` slot is what enforces that, not `session.ts`. |
| `session.setPhotoMode(opts)` | Switches the `photo` render tier on/off — **the only async setter here** (returns `Promise<void>`; `three-gpu-pathtracer` is lazy-loaded, see `photo-mode.ts` above). `session.photoMode` reports `'loading'` for the duration. Safe to call again — including with `false` — before a previous call resolves; the superseded call's result is discarded rather than clobbering whatever's active by the time it finishes, and the same applies if `setCinematic()` claims the slot while a `setPhotoMode()` call is still in flight (both directions keep `session.cinematic`/`session.photoMode` from reporting stale "still active" state for a controller that was actually disposed out from under them). |
| `session.fit()` | Re-frames the camera on everything currently in the viewport. |
| `session.stats()` | Vertex/triangle counts for the current view. |
| `session.dispose()` | Disposes every model ever added, the animation controller, and the viewport. Idempotent. |

`setModel` reports the new model's bounds to the viewport (via
`viewport.setSceneBounds()`) unconditionally, even when `opts.fit: false`
— the hook that keeps the shadow-camera frustum and shadow-catcher plane
fit to whatever's loaded regardless of whether the camera itself re-frames.

## Render & color mode applicability

Derived from `render-modes.ts` and `polygon.ts`'s actual behavior (not the
game-vocabulary strings — no game-specific mode exists):

| render mode | polygon | glTF |
| --- | --- | --- |
| `textured` | ✗ (no texture data) | ✓ restores original materials |
| `faces` | ✓ `repr.faces` (merged, per-vertex-colored) | ✓ flat `MeshLambertMaterial`, tinted from the original material's `.color` |
| `wireframe` | ✓ `repr.lines` (declared or derived edges) | ✓ flat wireframe `MeshBasicMaterial`, same tint |
| `points` | ✓ `repr.points` (built eagerly) | ✓ lazily built, cached merged `THREE.Points` |

| color mode | polygon (`recolorPolygonModel`) | glTF |
| --- | --- | --- |
| `palette` | ✓ (needs an injected `ColorResolver` — flat grey otherwise) | ✗ |
| `face` | ✓ | ✗ |
| `object` | ✓ | ✗ |
| `height` | ✓ (range from the model's own bounding box) | ✗ |

Color-mode application is polygon-only in this implementation:
`resolveColor` itself is pure and works given any context, but the only
function that actually paints a color onto real geometry
(`recolorPolygonModel`) only ever touches `model.repr.faces`'s per-vertex
`color` attribute — which only a polygon-sourced model has. A glTF mesh's
materials already carry real, meaningful color/texture information (PBR
base color, real textures); overwriting that with an id- or height-derived
tint would be a strict downgrade, not a feature, so this package doesn't
offer a way to do it. A host that wants a uniform glTF tint effect can
still do so directly against `model.object`'s materials — `render-modes.ts`
exposes the mesh-level materials it builds for `'faces'`/`'wireframe'` mode
via ordinary three.js objects, nothing is hidden behind a private API.

## Testing

```bash
npm test
npm run lint
```

Everything except `viewport.ts` runs under plain Node — three's math and
geometry classes (`Box3`, `Vector3`, `AnimationClip`, `AnimationMixer`,
`Object3D`, `BufferGeometry`, ...) are pure JS with no DOM/WebGL
dependency. `viewport.test.ts` is the one file that opts into jsdom (via a
per-file `// @vitest-environment jsdom` pragma, not a global config) and
partially mocks `THREE.WebGLRenderer` — jsdom implements the DOM shape
`createViewport()` needs but not a real WebGL context.
`dispose.test.ts`/`render-modes.test.ts` exercise hand-built fake
`Object3D`/material/texture trees rather than mocking three itself, the
same technique `@seer-project/audio-ui` uses for its own DOM-touching
surface.

## Licensing & Commercial Use

Seer exists to reverse-engineer other people's work, and that is only possible
because the preservation and romhacking communities published what they found
instead of keeping it. The licence is chosen so that keeps happening: build on
Seer and your work stays open too, so the next person gets the same head start.

- **[AGPL-3.0-or-later](https://github.com/Shaid/seer/blob/main/LICENSE)** —
  free for personal, educational and open-source use. Note that the AGPL extends
  copyleft to **network use**: run a public web app or hosted service on this
  and you must publish your application's source under the AGPL.
- **Commercial licence** — waives that requirement so a proprietary or
  closed-source product can keep its codebase private. Flat-fee and subscription
  terms are available, and custom terms are negotiable.

If the copyleft doesn't fit what you're building, we would much rather have the
conversation than have you walk away — email
[dr.shaid@gmail.com](mailto:dr.shaid@gmail.com) with the subject
`[Commercial License Request - Project Name]`.

Full details: <https://seer.shaid.net/start-here/licensing/>.
