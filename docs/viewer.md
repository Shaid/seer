# Viewer Tooling Guide

How the scaffold's offline asset viewer (`tools/viewer/` — generated from
`packages/create-seer/templates/tools/viewer/*.eta` by `npx create-seer
--viewer`) works: the data-driven game/platform selectors, asset-type filter
tabs, animation autoplay, and the generic indexed-texture + palette WebGL2
shader with its live palette editor and colour-cycling control.

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

Four template files, rendered once per scaffolded project:

- `tools/viewer/index.html.eta` → `index.html` — DOM structure.
- `tools/viewer/viewer.ts.eta` → `viewer.ts` — all browser-side logic, no
  framework, no build step beyond Vite's default TS transform.
- `tools/viewer/viewer.css.eta` → `viewer.css` — styling.
- `tools/viewer/shared.ts.eta` → `shared.ts` — the manifest/atlas/palette
  types shared between the build pipeline (which writes JSON matching these
  shapes) and the viewer (which reads it back).

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
  platforms: [{ id, displayName }] }[]` and writes it via `@seer/pipeline`'s
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
`<name>.png`, an optional `<name>.indexed.png` via `@seer/pipeline`'s
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
from `@seer/core` (`packages/core/src/palette.ts`), not written inline in the
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
