# Viewer Tooling Guide

How the scaffold's offline asset viewer (`tools/viewer/` — generated from
`packages/create-seer-viewer/templates/*.eta`, either directly via `npx
create-seer-viewer` or as part of `npx create-seer --viewer`) works: the
data-driven game/platform selectors, asset-type filter tabs, animation
autoplay, the generic indexed-texture + palette WebGL2 shader with its live
palette editor and colour-cycling control, category-sharded manifest
navigation for large corpora (§5), and 3D asset rendering via
`@seer-project/engine-3d` (§6).

This is a **framework doc** describing the scaffold template itself, not a
per-project copy — see "Why this doc isn't vendored" at the bottom for why it
isn't scaffolded into new projects the way `architecture-overview.md` and
`boilerplate-guide.md` are.

Companion docs: [`architecture-overview.md`](architecture-overview.md) §9
(the high-level "what the viewer is for" description this doc backs up with
real architecture), [`weaknesses.md`](weaknesses.md) §6 (the `ManifestEntry`/
`AtlasMeta` type-duplication issue this doc's manifest contract addresses),
[`viewer-tooling-review.md`](viewer-tooling-review.md) (the cross-repo survey
that this template revision was built to close the gap identified in),
[`common-tooling-candidates.md`](common-tooling-candidates.md) §15a (the
vendoring-vs-linking call this doc's own placement follows), and
[`audio-playback.md`](audio-playback.md) (the same "divergent hand-rolled
panels unified into shared chrome" story, told for the bottom-docked
music/audio transport bar — `@seer-project/core`'s `PlaybackEngine` contract
and `@seer-project/audio-ui`'s `AudioBarController`/`NativeAudioEngine`).

---

## Architecture

Five template files in `packages/create-seer-viewer/templates/`, rendered
once per scaffolded project into `tools/viewer/`:

- `index.html.eta` → `index.html` — DOM structure.
- `viewer.ts.eta` → `viewer.ts` — all browser-side logic, no
  framework, no build step beyond Vite's default TS transform.
- `viewer.css.eta` → `viewer.css` — styling.
- `shared.ts.eta` → `shared.ts` — the manifest/atlas/palette
  types shared between the build pipeline (which writes JSON matching these
  shapes) and the viewer (which reads it back).
- `data-view.ts.eta` → `data-view.ts` — the "Data" tab's read-only
  decoded-JSON table browser, a separate sidebar/list/view from the asset
  browser (`switchTab()`, `viewer.ts.eta:216-231`).

Two Node-side template files feed it:

- `tools/shared/game-config.ts.eta` → `tools/shared/game-config.ts` — owns
  `GAME_CONFIGS` and now also `writeGamesManifest()`, which derives
  `public/assets/games.json` from that same config.
- `tools/game/build-assets.ts.eta` → `tools/<game>/build-assets.ts` — the
  Stage 2 placeholder; writes a self-contained example asset (baked PNG,
  indexed PNG, atlas, palette, manifest) so a fresh scaffold's viewer has
  something real to show before any decoders are wired in, and calls
  `writeGamesManifest()`.

Data flow, end to end:

```
GAME_CONFIGS (game-config.ts)
        │
        ├─ writeGamesManifest() ──────────► public/assets/games.json
        │                                     (id, displayName, platforms[])
        │
        └─ per-platform build-assets.ts ──► public/assets/<game>/<platform>/
                                               manifest.json   (ManifestEntry[])
                                               <name>.json     (AtlasMeta — packed frames)
                                               <name>.png       (baked RGBA sheet)
                                               <name>.indexed.png  (optional — R=index)
                                               <name>.pal.json  (optional — PaletteData)
```

The viewer fetches `games.json` once at startup, then `manifest.json` +
per-asset `.json`/`.png`/`.pal.json` whenever the selected game/platform or
asset changes.

---

## 1. Data-driven game + platform selectors

**Problem this replaces:** before this revision, `ASSET_BASE` was a `const`
baked in at scaffold-generation time (`/assets/<game>/<platform>`), so a
project that grew to support more platforms had no in-template way to switch
— every real consuming project hand-rolled its own fix (see
`viewer-tooling-review.md` divergent §2–3 for how inconsistently that turned
out across six sibling projects).

**How it works now:**

- `tools/shared/game-config.ts.eta`'s `writeGamesManifest()`
  (`game-config.ts.eta:73-82`) maps `GAME_CONFIGS` to `{ id, displayName,
  platforms: [{ id, displayName }] }[]` and writes it via `@seer-project/pipeline`'s
  `writeJson`. `PlatformConfig` gained an optional `displayName?: string`
  field (`game-config.ts.eta:24-28`) for this; when omitted, the platform id
  itself is used as the label (`p.displayName ?? p.platform`).
- `tools/game/build-assets.ts.eta` calls `writeGamesManifest(resolve('public/assets/games.json'))`
  as its last step, so the manifest always reflects the current config.
- `viewer.ts.eta`'s `initSelectors()` (`viewer.ts.eta:109-125`) fetches
  `/assets/games.json` via `loadGamesManifest()` (`:77-84`) and populates the
  `#game-select`/`#platform-select` `<select>` elements
  (`populateSelect()`, `:87-96`), defaulting to the scaffolded
  game/platform. If the fetch fails or returns an empty array — the only
  case a truly fresh scaffold can hit before `build-assets` has ever run —
  it falls back to a synthetic single-entry list built from that same
  default, so the selectors always render something valid.
- Changing either `<select>` (`gameSelectEl`/`platformSelectEl` `change`
  listeners, `viewer.ts.eta:144-154`) recomputes `ASSET_BASE` and calls
  `switchAssetBase()` (`:128-137`), which resets selection state, stops any
  running autoplay/color-cycling, reloads `manifest.json`, and re-renders
  the type filters and list.

This is correct by construction even for the trivial single-game/single-
platform case a fresh scaffold starts with — `GAME_CONFIGS` has exactly one
entry, `writeGamesManifest()` still emits a valid one-element `games.json`,
and the selectors render one `<option>` each. Adding a second platform later
is purely a `GAME_CONFIGS` edit; no viewer template change is needed.

---

## 2. Asset-type grouping / filter tabs

`ManifestEntry` (now the single canonical definition, in `shared.ts.eta` —
see "Type reconciliation" below) gained a `type: string` field. `viewer.ts.eta`'s
`renderTypeFilters()` (`:156-181`) derives the filter buttons from
`[...new Set(manifest.map(m => m.type))]` — the distinct types actually
present in the loaded manifest — rather than a hardcoded asset-type union, so
it works unchanged whether a project has one asset type or ten. `renderList()`
(`:184-208`) applies both the active type filter and the search query.

The scaffold's own placeholder `build-assets.ts.eta` writes exactly one
manifest entry with `type: 'sprite'`, so a fresh, unmodified project shows a
single, sensible filter tab rather than an empty or confusing filter bar.

---

## 3. Animation autoplay

`viewer.ts.eta:634-660`. A `Play/Pause` button (`#play-toggle`, in
`index.html.eta`'s `#frame-strip`, next to the existing slider) toggles a
`setInterval` timer that advances `currentFrame` with wraparound and calls
`drawAsset()` — the same redraw path manual stepping already used. The
timer interval is a single named constant, `AUTOPLAY_INTERVAL_MS = 150`
(`viewer.ts.eta:634`), specifically so it's easy to find and tune.

Manually dragging the slider (`frameSlider`'s `input` listener) or pressing
the arrow keys both call `stopPlayback()` first — the existing arrow-key
stepping logic itself (wraparound left/right) is otherwise unchanged from
before this revision.

---

## 4. Indexed-texture + palette WebGL2 shader, palette editor, colour cycling

### Build side: emitting an indexed PNG variant

`tools/game/build-assets.ts.eta` writes, alongside the existing baked RGBA
`<name>.png`, an optional `<name>.indexed.png` via `@seer-project/pipeline`'s
`writeIndexedPNG` (palette index in the R channel). `ManifestEntry.indexedPng`
(`shared.ts.eta`) records its presence; the viewer only offers the shader
toggle for assets that have one (`selectAsset()`, `viewer.ts.eta:210-227`).
The scaffold's own placeholder asset ships a small 2-index checkerboard
specifically so the shader/editor/cycling views have something visibly
non-trivial to render before any real decoder exists.

### The shader: a deliberately generic "no-op" base case

`viewer.ts.eta:320-524`. This is the "basic shader to show how it could be
used" extension point, not a finished per-game recolour system. The fragment
shader (`SHADER_FRAGMENT_SRC`, `:331-345`) does exactly this, per pixel:

```glsl
vec2 atlasUV = uFrameRect.xy + vUV * uFrameRect.zw;   // window into the atlas
vec4 packed = texture(uIndexTex, atlasUV);            // sample the index (R channel)
float index = packed.r * 255.0;
vec4 color = texture(uPaletteTex, vec2((index + 0.5) / uPaletteSize, 0.5)); // 1D palette lookup
fragColor = vec4(color.rgb, packed.a);                // pass the index texture's own alpha through
```

`uFrameRect` is the only bit of plumbing beyond the bare index→palette
lookup — it lets one shader program serve both a single cropped sprite frame
and the "full atlas" view, exactly like the existing Canvas2D
`drawImage(img, frame.x, frame.y, ...)` crop already does. There is no
bitplane permutation, no per-entity mode table, nothing game-specific.

**This is intentionally where a project's own hardware-recolor mechanism
gets layered on, not reimplemented here.** For a fully worked example of what
that looks like at the far end of the complexity spectrum — a 48-entry mode
table driving a 5-bitplane permutation for one specific Amiga game's sprite
recolor trick — see
[`../../middilgard/docs/tooling/asset-viewer.md`](../../middilgard/docs/tooling/asset-viewer.md)
("SAS-based palette renderer" / "WebGL Shader Pipeline" sections). That
logic is specific to WIME's hardware and is *not* generalized into this
scaffold; the generic 80% underneath it — sample an index, look it up in a
palette texture, output the color — is what lives here instead. A project
that needs something like it would fork this shader, add its own uniforms
(e.g. a mode-table lookup or extra bitplane textures), and keep the rest of
the pipeline (`uFrameRect` windowing, palette texture upload, GL state setup)
unchanged.

GL state (`GLState`, `:347-355`) — context, compiled program, both textures,
uniform locations — is rebuilt from scratch on every `drawAssetShader()` call
(`initGL()`, `:372-417`), because the `<canvas>` element itself is recreated
each time (`canvasWrap.innerHTML = ''`), matching how the existing Canvas2D
path already worked. `uploadIndexTexture()` (`:419-429`) uploads the indexed
PNG once per draw; `uploadPaletteTexture()` (`:431-450`) is the one that gets
called repeatedly, on every palette edit and every colour-cycling tick,
without touching the index texture or re-fetching anything.

A checkbox (`#shader-toggle`, only shown when the selected asset has an
`indexedPng`) switches `drawAsset()` (`:231-247`) between this WebGL path and
the original Canvas2D baked-PNG path. Baked-PNG view is unaffected by palette
edits or cycling — that's an inherent limitation of pre-baked color, not a
bug; it's why the shader path exists.

### Palette editor

`renderPalette()` (`:558-587`) now reads from `workingPalette` — an in-memory
copy of the loaded `.pal.json`'s colors (`selectAsset()` populates it via
`.map(c => ({...c}))`, `:216`) — instead of the raw immutable palette data.
Clicking a swatch calls `editPaletteColor()` (`:536-555`), which creates a
native `<input type="color">` (simplest possible approach, no extra
dependency), seeds it from the swatch's current color, and on every `input`
event writes the new color into `workingPalette[index]`, re-renders the
swatches, and calls `redrawShaderIfActive()` (`:470-474`) — which re-uploads
just the palette texture and redraws, a no-op when the shader view isn't
active.

### Colour cycling

`#cycle-panel` (start index, end index, speed, direction, an
Animate/Stop button) drives `cycleTick()` (`:601-616`) on a
`requestAnimationFrame` loop, gated by a simple frame-counter modulo so
"speed" means "ticks per step" rather than raw animation-frame rate. Each
step calls `cyclePalette(workingPalette, start, end, direction)` — imported
from `@seer-project/core` (`packages/core/src/palette.ts`), not written inline in the
template. `cyclePalette()` is a small, pure, DOM/WebGL-free utility: it
rotates a sub-range of any array by one step, wrapping only within that
range, and is unit-tested with real (non-mocked) data in
`packages/core/src/__tests__/palette.test.ts` — forward/reverse rotation,
full-cycle round-trips, out-of-range no-ops, and non-numeric (RGB object)
array elements, since the viewer uses it on `{r,g,b}` triples rather than raw
indices. It was factored out specifically because it's reusable beyond this
one viewer — any future browser-side consumer of "rotate this palette range"
needs the exact same array-rotation logic, not a viewer-specific copy of it.

---

## 5. Manifest sharding & category navigation

**Problem this replaces:** a project with a genuinely large corpus (tens or
hundreds of thousands of entries) had exactly one option — fetch, parse, and
render the entire `manifest.json` on every page load — with no way to browse
one slice of the catalog without first downloading and holding all of it in
memory. Several in-code comments already point readers at "docs/viewer.md's
manifest-sharding section" (`viewer.ts.eta:59`, `viewer.css.eta:66`) for a
feature this file, until now, never actually documented.

**How it works now:**

- Build side: `@seer-project/pipeline`'s `writeShardedManifest()`
  (`packages/pipeline/src/manifest-sharding.ts:80-126`) takes an
  already-built flat entry array and splits it into
  `public/assets/<game>/<platform>/manifest/<category>.json` shards — one
  per distinct `ManifestEntry.category` value, entries with no `category`
  falling into an `"uncategorized"` shard rather than being dropped — plus a
  `categories.json` top-level index (`CategoryIndexEntry[]`,
  `manifest-sharding.ts:38-56`), sorted largest-first. A category whose
  shard exceeds `GROUP_SHARD_THRESHOLD` (3000 entries,
  `manifest-sharding.ts:70`) is additionally split by `ManifestEntry.group`
  into `manifest/<category>/<group>.json` sub-shards
  (`manifest-sharding.ts:101-118`), recorded as that category's `groups[]`
  breakdown (`GroupIndexEntry`, `:31-36`). This is purely additive — it
  never reads or replaces `manifest.json` itself
  (`manifest-sharding.ts:14-19`), so a project that never calls it keeps the
  original single-fetch contract unchanged. Categorization itself (deciding
  what `category`/`group` each entry gets) is always a per-project concern
  and stays in that project's own `tools/`.
- Viewer side: `loadCategoryIndex()` (`viewer.ts.eta:117-125`) fetches
  `categories.json` on startup and on every game/platform switch. An empty
  result — 404, or a project that never sharded — is the deliberate signal
  for "flat manifest mode": `switchAssetBase()` (`:188-213`) falls back to
  the original single `loadManifest()` fetch unchanged. When
  `categoryIndex` is non-empty, the flat manifest is never fetched at all;
  `renderCategoryNav()` (`:292-356`) renders a grid of category buttons
  (each showing a live count) instead of the asset list. `selectCategory()`
  (`:245-264`) fetches a category's flat shard immediately when it has no
  `groups` (`loadCategoryShard()`, `:127-135`, cached per-session in
  `shardCache`, `:69`) — but for a group-sharded category, fetches nothing
  until `selectGroup()` (`:267-280`) pulls one
  `manifest/<category>/<group>.json` sub-shard at a time
  (`loadGroupShard()`, `:137-145`). There is deliberately no "load the whole
  category at once" escape hatch for a group-sharded category
  (`renderCategoryNav`'s own doc comment, `:282-291`) — that would
  reintroduce the unvirtualized-DOM cost sharding exists to avoid.

A fresh scaffold's placeholder `build-assets.ts.eta` never calls
`writeShardedManifest`, so `categories.json` doesn't exist and the viewer
runs in flat-manifest mode until a project's own pipeline opts in.

---

## 6. 3D assets

**Problem this replaces:** two sibling seer-framework projects (`flower`,
`hunter`) each grew their own three.js viewport independently — duplicated
scene/camera/render-loop boilerplate, two incompatible in-memory model
shapes (a hand-rolled `{verts,edges,faces}` polygon shape vs. real glTF
documents), a manual 2D/3D UI toggle button in one of them instead of
asset-driven dispatch, and — until now — zero manifest representation for a
3D asset at all: 3D content had to bypass `manifest.json` entirely (e.g.
hardcoded per-game path tables) because `ManifestEntry` had no fields for it
and its `sprites`/`hasPalette`/`png` fields were required, meaningless ones
for a mesh.

**How it works now:**

- **Asset-driven dispatch, no toggle.** A manifest entry's `type` field (the
  same field that already drives the 2D filter tabs, §2 above) decides
  whether an asset renders as 2D or 3D — there is no separate "3D mode"
  button for the user to find or forget to leave. This scaffold's own
  templates don't implement that dispatch themselves (see the callout at
  the end of this section); it's each consuming project's `tools/viewer/
  viewer.ts` that branches on `type` and calls into
  `@seer-project/engine-3d` for a `mesh`/`scene` entry.
- **Five new optional `ManifestEntry` fields** (`shared.ts.eta`, next to the
  existing `category`/`group` sharding fields): `model?: string` (path
  relative to `ASSET_BASE`), `modelFormat?: 'gltf' | 'polygon-json'`
  (absent ⇒ inferred from `model`'s extension), `modelIndex?: number` (index
  into a multi-model polygon JSON array — e.g. one shared
  `objects-geometry.json` holding hundreds of objects, so many manifest
  entries can share one fetch instead of one file per object), `scene?:
  string` (a `type: "scene"` entry's placement data), and `skeletal?:
  boolean` (whether the model carries `AnimationMixer`-driven skeletal
  animation vs. a static mesh). Making `sprites`/`hasPalette`/`png`
  optional at the same time was the one non-additive part of this change —
  they're meaningless for a mesh/scene entry, and every existing unguarded
  read of them in the scaffold template (`viewer.ts.eta`'s sidebar-item
  renderer) was audited and fixed to tolerate their absence rather than
  interpolating `undefined` into the DOM.
- **glTF-native + a polygon adapter, not one hand-rolled shape.**
  `@seer-project/engine-3d` settles the question `docs/engine-3d-proposal.md`
  originally left open by not picking a single JSON shape. `gltf.ts`'s
  `loadGltfModel()`/`toModel3D()` (`packages/engine-3d/src/gltf.ts:60`,
  `:24`) load a real glTF 2.0 document via `THREE.GLTFLoader` and use it
  as-is — real PBR materials, real textures, real baked `AnimationClip`s.
  `polygon.ts`'s `normalizePolygonModel()`/`normalizePolygonSet()`
  (`packages/engine-3d/src/polygon.ts:43`, `:64`) instead normalize a raw
  `{verts,edges,faces}` JSON document — aliasing `vertices`/`verts`,
  tolerating a bare `number[]` face as well as `{verts,fill}` — and
  `buildPolygonModel()` (`:250`) builds one merged `BufferGeometry` each for
  faces/lines/points. Both paths converge on the same unifying shape,
  `Model3D.object: THREE.Object3D` (`packages/engine-3d/src/types.ts:71`) —
  the one thing a host ever adds to `session`/`viewport.root`, regardless of
  which path produced it; only `render-modes.ts` and, for color,
  `polygon.ts`'s `recolorPolygonModel()` (`:309`) ever branch on
  `model.source` (`types.ts:38`).
- **Render/color-mode applicability** — reproduced from
  `packages/engine-3d/README.md`'s own applicability tables (not
  re-derived by hand here, so it can't silently drift from the package's
  actual behavior in `render-modes.ts`'s `supportedRenderModes()`/
  `defaultRenderMode()`/`applyRenderMode()`,
  `packages/engine-3d/src/render-modes.ts:34`, `:44`, `:175`):

  | render mode | polygon | glTF |
  | --- | --- | --- |
  | `textured` | unsupported (no texture data) | restores the mesh's original materials |
  | `faces` | merged, per-vertex-colored geometry | flat `MeshLambertMaterial`, tinted from the original material's `.color` |
  | `wireframe` | declared or derived edge set | flat wireframe `MeshBasicMaterial`, same tint |
  | `points` | built eagerly | lazily built, cached merged `THREE.Points` |

  | color mode | polygon | glTF |
  | --- | --- | --- |
  | `palette` | needs an injected `ColorResolver` (flat grey otherwise) | not offered |
  | `face` / `object` / `height` | supported | not offered |

  Color-mode application is polygon-only by design: a glTF mesh's materials
  already carry real, meaningful color/texture information, so overwriting
  them with an id- or height-derived tint would be a downgrade, not a
  feature — a host that wants a uniform glTF tint can still do so directly
  against `model.object`'s materials, nothing is hidden behind a private
  API.
- **`createMeshSession()`** (`packages/engine-3d/src/session.ts:64`) is the
  orchestrator a host actually calls — one viewport, the active model, its
  animation controller — with `session.setModel()`/`.addModel()`/
  `.setRenderMode()`/`.setColorMode()`/`.fit()`/`.stats()`/`.dispose()`
  (`session.ts:43-61`) as its surface. `session.disposed` after `dispose()`
  is the same in-flight-load guard shape (`if (session.disposed) return;`
  after an `await`) both `flower` and `hunter` already used before this
  package existed.

**Scaffold-template support is intentionally not implemented yet.** Only the
manifest *shape* (the five fields above) lives in
`packages/create-seer-viewer/templates/shared.ts.eta` — there is no `.eta`
template code anywhere in `create-seer-viewer` or `create-seer` that
branches on `type: "mesh"`/`"scene"`, imports `@seer-project/engine-3d`, or
renders a 3D canvas. Each consuming project is expected to hand-wire this
package into its own `tools/viewer/viewer.ts` — `flower` and `hunter` are
the two projects with existing hand-rolled three.js viewers slated to
migrate onto this package first, each as its own commit, independent of the
scaffold. Template support is deferred until more than one real migration
has settled what the integration shape should look like — abstracting a
scaffold template from a single example risks locking in the wrong shape.

---

## Type reconciliation: one `ManifestEntry`, not two

`docs/weaknesses.md` §6 flags that the scaffold shipped two different,
never-reconciled `AtlasMeta` shapes (`src/data/GameData.ts.eta`'s
uniform-grid shape vs. `tools/viewer/shared.ts.eta`'s packed-frame shape) —
and, relatedly, `tools/viewer/viewer.ts.eta` declared its own local
`ManifestEntry` interface rather than importing one from `shared.ts.eta`,
which also carried a near-duplicate, unused `AssetEntry` type.

This revision reconciles the `ManifestEntry`/`AssetEntry` half of that: 
`ManifestEntry` (with the new `type` and `indexedPng` fields) now lives once,
canonically, in `shared.ts.eta`, and `viewer.ts.eta` imports it instead of
redeclaring it. The dead `AssetEntry` type and the dead, uncalled
`rgbaFromPalette()` helper (also flagged as scaffold-inherited dead code —
`viewer-tooling-review.md` "What's common" §8) were removed from
`shared.ts.eta` at the same time.

**Deliberately left alone:** the separate, larger `GameData.ts.eta` (uniform
grid) vs. `shared.ts.eta` (packed frames) `AtlasMeta` conflict weaknesses.md
§6 also describes. Those two types serve genuinely different consumers
(`src/data/AssetLoader.ts`'s generic `loadAssets()` schema vs. the viewer's
atlas format) and reconciling them would mean changing `GameData.ts.eta`
and its runtime consumer, which is out of scope for a viewer-tooling change
and risks breaking the unrelated runtime-asset-loading example. Tracked as a
follow-up, not fixed here.

---

## Why this doc isn't vendored into scaffolded projects

`architecture-overview.md` and `boilerplate-guide.md` are copied verbatim
into every scaffolded project (`docs/architecture-overview.md.eta`,
`docs/boilerplate-guide.md.eta` — plain copies, no template variables) and
linked locally from the scaffolded `README.md`. `common-tooling-candidates.md`
§15a calls this out as a real problem: three of the six real sibling
projects carry byte-identical stale copies of these docs, one carries a
57-line-stale fork, and none of those copies will ever receive a framework
update after the point they were scaffolded. §15a's own recommendation is
"the scaffold should link, not copy."

Rather than perpetuate that pattern for a **fourth** doc, this guide is
**linked, not vendored**: the scaffolded `README.md.eta` points at
`https://github.com/Shaid/seer/blob/main/docs/viewer.md` (the same
link-not-copy approach `crawl/README.md` already uses for the other two
framework docs, independently of the scaffold), and
`docs/architecture-overview.md.eta`'s own §9 does the same. This means a
scaffolded project's `docs/` folder does **not** contain a local
`viewer.md` — that's intentional, not an oversight.
