# Framework weaknesses and gaps

Found while planning a generic first-person dungeon walker for the
`sorcery` project (Wizardry 6), cross-referenced against `crawl`
(Black Crypt) and `middilgard` (War in Middle Earth). This is not a
survey of the whole framework — it's what surfaced while trying to
build one specific non-trivial feature on top of it, and it turned out
to be a useful stress test. Full context: `docs/walker.md` §3.3,
§4, §6.5, §8.2.

Each item below cites the exact file/line it was verified against —
these are read findings, not impressions.

> **Status update (2026-08-03).** Two items below are now resolved: §6
> (conflicting `AtlasMeta` definitions) — fixed by moving a single canonical
> `AtlasMeta`/`AtlasFrame` into `@seer/core`, both scaffold templates now
> import it instead of redeclaring (commit `7b931e0`). §7 (`writeIndexedPNG`
> hardcoding index 0 as transparent) — fixed with the exact
> `opts.transparentIndex` parameter recommended below, defaulting to `0` for
> backward compatibility (commit `efb3cca`). §5 is **partially** resolved:
> the atlas-shape half of "no atlas, palette, manifest... types anywhere in
> any `@seer/*` package" is fixed by the same §6 work, and a `cyclePalette()`
> utility was also added to `@seer/core`, but there's still no canonical
> `PaletteData` type there (still locally declared per-project) and no
> `fetchBinary`/`.bin` path on `loadAssets` — both still open. Also note
> `@seer/engine` was renamed to `@seer/engine-2d` after this review was
> written (ahead of a future `@seer/engine-3d`) — mentions of `@seer/engine`
> below refer to what is now `@seer/engine-2d`; file paths citing
> `packages/engine/` have been updated to `packages/engine-2d/` in place
> since those are just pointers, not findings. The rest of this document is
> left as-written, not re-verified against current state.

## 1. `docs/architecture-overview.md` §8 describes components that don't exist

The doc's ASCII diagram (`docs/architecture-overview.md:291-299`) lists
`Game / Camera / InputManager / AssetLoader / SceneRenderer /
EntityManager / AudioManager` as the browser runtime engine's structure.
**`SceneRenderer`, `EntityManager`, and `AudioManager` do not exist
anywhere in `@seer/engine` or any other package.** `packages/engine-2d/src/index.ts`
is 19 lines — 13 values and 8 types, the entire package surface — and
none of those three names appear.

This isn't just stale docs; it actively misled a downstream project.
Sorcery's own copy of the doc (`sorcery/docs/architecture-overview.md:291-299`)
inherited the same aspirational text verbatim, and a consumer reading it
would reasonably assume there's a viewport-culled scene renderer and an
entity-rendering system ready to build on. There isn't.

**Recommendation:** either implement stubs for the three missing pieces,
or mark §8 explicitly as a target architecture / wish list rather than a
description of current state, so downstream `docs/architecture-overview.md`
copies (every `create-seer`-scaffolded project gets one) don't repeat
the same false claim.

## 2. `Camera` is unusable for anything that isn't a 2D pan/zoom map

`packages/engine-2d/src/Camera.ts:16-189`. `CameraState = {x, y, zoom}` —
no orientation field of any kind, so it cannot represent a facing.

More importantly, `_clamp()` (`Camera.ts:173-188`) is called
unconditionally from every mutating method (`setViewSize`,
`setWorldBounds`, `pan`, `moveTo`, `zoomAt`, `setZoom`) with **no
opt-out**:

```ts
const minZoomToFill = Math.max(viewWidth/worldWidth, viewHeight/worldHeight);
if (this._zoom < minZoomToFill) this._zoom = minZoomToFill;   // world must fill viewport
this._x = Math.max(halfW, Math.min(this._worldWidth  - halfW, this._x));
this._y = Math.max(halfH, Math.min(this._worldHeight - halfH, this._y));
```

This forces the viewport to always be fully inside world bounds at a
zoom that fills the screen — the correct behavior for a strategy-game
map camera, and actively wrong for any camera that needs to sit *at* a
point inside a world and look in a direction (a first-person or
over-the-shoulder view, a minimap inset, a camera that intentionally
shows empty space at a world edge). There's no way to disable `_clamp()`
short of not using `Camera` at all.

**Recommendation:** make the fill-and-clamp behavior optional (a
constructor flag or a `clampMode: 'fill' | 'free' | 'none'`), and add an
`orientation`/`facing` field, even if unused by the existing 2D
consumers. As shipped, `Camera` is really `MapCamera` — consider naming
it that if the clamp behavior stays mandatory, so its scope is honest.

## 3. `InputManager` has no held-key state, and hardwires movement to camera pan

`packages/engine-2d/src/InputManager.ts:28-197`. WASD/arrows are wired
directly to `camera.pan(dx,dy)` (`:93-96`), RTS edge-scrolling to the
same (`:99-107`), wheel to `camera.zoomAt` (`:159-166`), drag to pan
(`:146-157`). `onKey` (`:83`) fires once per keydown — fine for menu
navigation, wrong for anything that needs to know "is this key currently
held" (continuous movement, strafing, running).

There's no `isDown(code)` accessor, no pointer lock, no relative mouse
delta. Any consumer that needs held-key semantics (which is most
real-time input, not just first-person walkers) has to bypass
`InputManager` and attach its own `keydown`/`keyup` listeners, at which
point `InputManager` isn't providing much.

**Recommendation:** split key-state tracking (`isDown`, `justPressed`,
`justReleased`) out as a standalone primitive that doesn't assume a
`Camera` exists, and build the current pan/zoom/drag behavior on top of
it as one consumer among others.

## 4. `pixi-helpers`' atlas slicers can't express what real extractors emit

`sliceAtlas`/`sliceAtlasKeyed` only handle uniform grids
(`cellWidth × cellHeight × columns × rows`). Every real Seer extractor
in both `sorcery` and `crawl` emits a packed atlas —
`{frames:[{name,x,y,w,h}], width, height}` — because that's what a
shelf-packer or the games' own native tile-sheet layouts actually
produce (rarely a uniform grid; see `tools/wizardry6/decode-maze.ts`'s
own atlas builder). There's no helper in the framework for the format
the framework's own consumers actually need.

**Recommendation:** add a `sliceAtlasFromMeta(texture, atlasJson)`
helper that takes the packed-frames shape directly, since that's the de
facto standard already (see item 6 below on the template inconsistency
this connects to).

## 5. `@seer/core` has no binary fetch path, despite documenting one

`packages/core/src/assets.ts:2-3`'s header comment describes binary
asset support, but `loadAssets<T>(basePath, schema)`
(`assets.ts:39-73`) is a `Promise.all` over `fetch` that unconditionally
`.json()`s anything ending in `.json` and `.text()`s everything else.
There is no path that returns an `ArrayBuffer`/`Uint8Array`, which
matters for anything that needs to fetch a raw indexed-pixel buffer,
audio data, or other non-text asset at runtime rather than at
pipeline-build time.

Related: **there are no atlas, palette, manifest, grid, or tilemap types
anywhere in any `@seer/*` package.** Every project (viewer tooling,
runtime loaders) currently redefines its own `AtlasMeta`/`PaletteData`
shape locally, which is how item 6 happened.

**Recommendation:** add a `fetchBinary`/`.bin` case to `loadAssets`, and
consider hoisting the packed-atlas and palette shapes into `@seer/core`
as canonical types once a second or third project needs them — they're
already effectively a de facto standard, just not a declared one.

## 6. `create-seer` templates ship two conflicting `AtlasMeta` definitions

`packages/create-seer/templates/src/data/GameData.ts.eta:5-15` defines a
uniform-grid `AtlasMeta` (cellWidth/cellHeight/columns/rows). `packages/create-seer/templates/tools/viewer/shared.ts.eta:1-17`
defines a *different*, packed-frames `AtlasMeta` in the same scaffold.
Every project generated from these templates inherits both, silently
disagreeing with each other.

Concretely: `sorcery/src/data/GameData.ts:5-11` still has the stale
uniform-grid shape from the template, untouched, while every real
extractor in that project (`tools/wizardry6/decode-*.ts`) and its own
`tools/viewer/shared.ts:9-13` use the packed-frames shape — because the
packed-frames shape is what shelf-packed real game art actually needs.
The uniform-grid one in `GameData.ts` is dead placeholder code nobody
updated, and a new project scaffolded today gets the same latent
inconsistency.

**Recommendation:** delete the uniform-grid `AtlasMeta` from the
`GameData.ts.eta` template and replace it with the packed-frames shape
(or import it from `@seer/core` once item 5's recommendation lands), so
new projects don't start from a template that's already wrong on day
one.

## 7. `writeIndexedPNG` hardcodes index 0 as transparent, contradicting its own docblock

`packages/pipeline/src/io.ts:30-46`. The docblock says `A=255`
(fully opaque output); the actual code writes
`A = (v === 0 ? 0 : 255)` — palette index 0 is unconditionally
transparent, regardless of whether index 0 is a real, opaque color in
the source game's palette (it very often is — e.g. black is
conventionally index 0 in most of these engines, and black is
frequently a real, opaque, intentional pixel).

This is a live, silent-corruption bug: any consumer that trusts the
docblock and calls `writeIndexedPNG` on a buffer where index 0 is
meaningful opaque content gets holes punched in their image with no
error or warning. It was found because `sorcery`'s maze-art decoder was
about to switch to indexed output specifically to *avoid* a
transparency bug in its RGBA path (see `docs/walker.md` §6.5,
§8.2) and would have walked straight into a second one at the pipeline
layer.

**Recommendation:** add an options parameter —
`writeIndexedPNG(path, indices, w, h, opts?: {transparentIndex?: number | null})`
— defaulting to `0` for backward compatibility, with `null` meaning
"fully opaque, no transparent index." This is small, additive, and
non-breaking. Also fix the docblock either way, since right now it
describes different behavior than the code has.

## 8. `runPipeline` only runs two of the three documented stages

`packages/pipeline/src/pipeline.ts:97-202` runs `exportGameData` and
`buildAssets`. The architecture doc's "Stage 3: Build Music Assets" has
no corresponding code anywhere in the pipeline — it's pure
documentation with nothing behind it, same pattern as item 1.

**Recommendation:** either implement a minimal Stage 3 hook (even a
no-op default consumers can override) or remove the claim from the
architecture doc until there's code to back it.

## 9. General pattern: the architecture doc describes a target, not the framework

Every item above involving a doc/code mismatch (1, 8, and to a lesser
extent 6) traces back to the same root cause: `docs/architecture-overview.md`
reads as a description of a finished framework, and it's actually a
roadmap with a partially-built implementation underneath. That's a
reasonable thing for a roadmap to be — the problem is nothing marks it
as one, so every downstream project's copy of the doc (scaffolded
verbatim by `create-seer`) makes the same promise to its own future
readers.

**Recommendation:** add a status marker per major component in §8 (e.g.
"✅ implemented", "🚧 planned, not started") so the doc stays honest as
the framework grows, rather than needing another audit like this one to
notice the gap.

---

None of this is a case against the framework's actual design — `Game`/
`Camera`/`InputManager` do what they say for their actual use case (a
2D pan/zoom strategy map), the monorepo mechanics are clean (no build
step, workspace packages resolve live via `file:../seer/packages/*`,
adding a package is mechanical), and `@seer/pipeline`'s IO helpers
(`readBinary`, `writePNG`, `hexDump`, etc.) are solid. The gaps are
specifically where a second, structurally different consumer (a
first-person dungeon walker) hit assumptions baked in for the first one
(a 2D map viewer), plus a few honest doc/code drifts that a second real
consumer was bound to surface eventually.
