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
report how long the frame actually took, feeding the adaptive threshold.

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
| `session.fit()` | Re-frames the camera on everything currently in the viewport. |
| `session.stats()` | Vertex/triangle counts for the current view. |
| `session.dispose()` | Disposes every model ever added, the animation controller, and the viewport. Idempotent. |

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
