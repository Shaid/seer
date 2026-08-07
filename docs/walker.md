# Generic first-person dungeon walker — architecture & implementation plan

> **Note (2026-08-03):** `@seer-project/engine` was renamed to `@seer-project/engine-2d`
> after this plan was written (ahead of a future `@seer-project/engine-3d`) — every
> `@seer-project/engine` reference below refers to what is now `@seer-project/engine-2d`,
> and `packages/engine/` paths are now `packages/engine-2d/`. Not renamed in
> place throughout to avoid touching a large, precise planning document
> line-by-line without re-verifying every citation; the substance of every
> claim below is unaffected by the rename.

**Status:** plan only, nothing implemented. Written 2026-08-02. Lives in
this repo (`seer/docs/walker.md`) rather than the consumer project's
repo because it targets a new framework package (`@seer-project/dungeon`, §4);
`sorcery` (Wizardry 6) is its primary driving consumer, and `crawl`
(Black Crypt) is the second consumer used to pressure-test the design.
**Scope:** a reusable, game-agnostic first-person grid dungeon renderer +
movement model for Seer-framework projects, driven first by Wizardry 6's
disassembly-confirmed data (`sorcery`, `/home/ctemplet/Development/sorcery`), and designed against a second
real consumer (Black Crypt, `/home/ctemplet/Development/crawl`).

This document is written to be executed against. Every structural claim
about an existing codebase cites a real file and line/section. Claims
about the original game engines cite the confirmed reverse-engineering
docs, and are labelled with the confidence level those docs assign.

---

## 0. Executive summary

- **Both target games use the same rendering family**, and it is *not*
  raycasting. Both composite **pre-drawn art pieces at authored screen
  positions**, selected by a `(depth, lateral, piece-kind)` slot address,
  drawn back-to-front. Wizardry 6: `DrawMazePiece` at `CODE+0x3d72`
  (`sorcery/docs/wizardry6/amiga/data-structure.md` §4.4). Black Crypt:
  `DrawViewport` at `S_1+0x02D46`
  (`/home/ctemplet/Development/crawl/docs/blackcrypt/amiga/data-structure.md:4964-5516`).
  A slot-addressed piece compositor is therefore the correct core
  abstraction, and **raycasting is actively wrong** — the art has baked-in
  perspective and no wall textures exist to project.
- **Recommendation: new browser-safe framework package `@seer-project/dungeon`**
  at `/home/ctemplet/Development/seer/packages/dungeon/`, with a
  `./schema` subpath export carrying zero-dependency types that the
  Node-side `tools/` can import. Rationale and tradeoffs in §4.
- **Do not build on `@seer-project/engine`'s `Camera` or `InputManager`.** Both
  are verified hostile to a first-person view (§3.3). `@seer-project/engine`'s
  `Game` lifecycle shape is worth copying, not importing.
- **Recommended renderer: an indexed-framebuffer software compositor**
  that writes palette indices into a `Uint8Array` at the game's native
  resolution, presented through a single PixiJS `Sprite`. This is the
  only approach that reproduces Wizardry 6's `mode=1` bitwise-OR blit
  exactly, makes the CGA/EGA/t16 palette variants free, is unit-testable
  against golden byte arrays, and — critically — lets the **same
  compositor** back both the PixiJS game and the plain-canvas asset
  viewer. Full justification and the alternative in §6.
- **Prior art warning: middilgard has no dungeon walker.** Despite the
  name, it is War in Middle Earth — a top-down strategy game. Its
  scene compositor is genuinely instructive prior art, but there is no
  first-person code to reuse. Details in §3.1.
- **The real blocker is not `maze-plane-semantics`.** It is that the
  mapping from a cell's wall code to a compose-list **base index** is
  undocumented for Wizardry 6. §10.1 explains why, and how M1/M2 are
  sequenced around it.

---

## 1. Scope and goals

### 1.1 What "dungeon walker" means for v1

A library that, given (a) a decoded level grid, (b) an art atlas, and
(c) a slot/placement table, renders a first-person view of a grid
dungeon and lets a player step through it.

**In scope for v1:**

| Capability | Detail |
|---|---|
| Level ingestion | Load a walker-schema level JSON produced by a project's Stage-2 pipeline |
| View construction | Given a pose `(level, x, y, facing)`, produce an ordered draw list of art pieces |
| Rendering | Composite that draw list to a raster surface, presented via PixiJS |
| Movement | Grid-quantised step forward/back, strafe, turn left/right, 4-way facing |
| Collision | Block movement against the level's wall data via a per-game semantics table |
| Features | Render per-cell features (doors, archways, stairs, wall decorations) via a configurable feature-code binding |
| Debug tooling | Top-down minimap with view-cone overlay; slot-address inspector; pose teleport |

**Explicitly out of scope for v1** (with the hook where each would attach
later, so v1 doesn't design them out):

| Out of scope | Future hook |
|---|---|
| Combat | The walker emits `onEnterCell(pose)`; a combat system subscribes and takes over the display surface |
| Monster / NPC AI | The draw-list builder already has a `decorations` pass keyed by depth+lateral — that is exactly where W6's confirmed monster-token overlay (`CODE+0xaffa`-`0xb1cc`, §4.6) and Black Crypt's object records slot in |
| Spells, inventory, party state | None — the walker takes a pose and a level, and owns no game state beyond the pose |
| Automap persistence / fog of war | `CellQuery` is already the single read path; a `VisitedSet` decorator wraps it |
| Runtime mutation of level geometry (secret doors opening) | The `CellQuery` interface is read-only by design but `MutableCellQuery` is a trivial extension; W6 confirms the original engine mutates maze state via `SetBitField` (A4 entry 47, `CODE+0x2984`, §4.7.3) |
| Audio | Nothing — `@seer-project/smus`/`@seer-project/tracker` are already separate packages |
| Smooth (non-quantised) motion | See §7.3 — deliberately deferred, and it is a bigger change than it looks |

### 1.2 Non-goals

- **Not a general 3D engine.** No free-look, no arbitrary yaw, no pitch.
  The whole value of this design is that it exploits the fact that both
  target engines quantise the view to a small fixed set of slots.
- **Not a level editor.** Levels come from the extraction pipeline.
- **Not a fidelity emulator of one game.** It must reproduce Wizardry 6
  faithfully enough to be a verification oracle for the RE work, but the
  interfaces are chosen for generality, not for W6's convenience.

---

## 2. Ground truth: what Wizardry 6 actually does

Everything in this section is from
`sorcery/docs/wizardry6/amiga/data-structure.md` §4 and
`sorcery/docs/wizardry6/amiga/investigations/mazedata.md`, plus direct
measurements I made against the committed extracted assets and the
`Bane` binary. Confidence labels are the docs' own.

### 2.1 The art bank — `mazedata.ega` (confirmed)

- 4-byte header (`dirCount=153`, `subCount=366`), a 153×6-byte
  directory, a 366×5-byte compose-list, then 153 back-to-back graphics
  blocks (§4.1). Partition invariant holds with zero deviation across
  all 153 records (§4.2).
- Each block is 4-bitplane, plane-major, MSB-left, tightly packed;
  `widthPx = widthUnits*8`, `heightPx = heightRows` (§4.3).
- Content: perspective-scaled brick walls at 3-4 sizes, doors,
  pillar/archway edges, floor/ceiling perspective strips, wall chains,
  a chest, a skeleton, and 20 16×16 UI icons
  (`investigations/mazedata.md:153-182`).
- Already extracted:
  `public/assets/wizardry6/amiga/maps/mazedata.png` (1014×621, 153
  frames) + `mazedata.json` (`{frames:[{name,x,y,w,h}], width, height}`)
  + `mazedata-composelist.json`, by
  `tools/wizardry6/decode-maze.ts`.

### 2.2 The compose list — the placement table (confirmed)

Five bytes per record (`data-structure.md` §4.4, and the same table
restated in `tools/wizardry6/decode-maze.ts:21-35`):

| Field | Meaning |
|---|---|
| `dirIndex` | which of the 153 graphics |
| `destXByte` | destination byte column, **signed** |
| `destY` | destination row |
| `srcClip` | bytes clipped off the source's left edge, **and added to destX** |
| `widthBytes` | bytes copied per row; `0` = draw nothing (49/366 records) |

Destination = `screenBase + destY*40 + destXByte + srcClip`. Source =
`directory[dirIndex].offset + srcClip`. This is a **byte-column**
addressing scheme on a 320px/40-byte-per-row screen, so all X
coordinates and widths are multiples of 8 pixels.

`DrawMazePiece(srcIdx, mode, dstIdx)`:
- `mode=1` → **bitwise OR** into the screen planes (`or.b d0,(a1)+`).
- `mode=0` → **replace** (`move.b (a3)+,(a1)+`).
- `dstIdx == 0xFFFF` → direct: `composeList[srcIdx]` supplies both art
  and placement.
- `dstIdx != 0xFFFF` → **mirrored**: art from
  `composeList[srcIdx].dirIndex`, placement from `composeList[dstIdx]`,
  and the blit walks the source backwards through a 256-byte
  bit-reversal LUT at `CODE+0x157c` (confirmed byte-exact, 0/256
  mismatches). *This is how one wall texture serves both sides of the
  corridor.*

Five renderer-implied invariants hold with zero deviation over all 317
drawn records, asserted on every extractor run by
`verifyComposeListInvariants` in `tools/wizardry6/decode-maze.ts:181-210`.

### 2.3 Slot addressing (confirmed, partially)

- Depth is **positional, not a field**: the per-cell dispatcher at
  `CODE+0x9b58` computes compose indices as `baseIndex + depth`, with
  `depth` bounded by 3 (`cmpi.w #3,8(a5); bge`).
- **3 lateral columns per depth**: the "already drawn" flag grid is
  indexed `depth*3 + lateralColumn` (`muls.w #3` at `CODE+0x9b60`).
- The **outer** renderer (`CODE+0xa72c`-`0xb25e`) runs a **4-step**
  depth loop (bound initialised to 4 at `CODE+0xa984`).
- So: **4 depth steps for some piece kinds, 3 for others.** I checked
  this empirically against the extracted compose list: run boundaries
  are **not** on a uniform 3-record grid. Grouping records into
  `[3k,3k+2]` triples and testing for a monotonically non-increasing
  source width (the signature of a perspective cascade) passes for only
  60 of 122 triples. Records 15-18 are a clean 4-step cascade
  (dirIndex 3,4,5,6 → 32×112, 24×87, 16×51, 8×27), which is what breaks
  the 3-grid alignment. **Treat run length as per-piece-kind data, not a
  constant.**

### 2.4 Per-cell evaluation (confirmed structure, rendered semantics)

`EvalCellFace` at `CODE+0x9202` (siblings `0x969a`, `0x9876`), §4.7.2:

```
EvalCellFace(x, y, locX, locY, region, lateral):
  if lateral != 0: step laterally; if off-map -> return 2 (solid)
  cellIndex = region*64 + locY*8 + locX
  if TestBit(levelBuf + 0x43a, cellIndex): 14-way dispatch on level
  if TestBit(levelBuf + 0x49a, cellIndex): 14-way dispatch on level
  switch (facing):
     0: wall = GetBitField(levelBuf + 0x060, cellIndex, 2)   ; this cell, plane A
     1: wall = GetBitField(levelBuf + 0x120, cellIndex, 2)   ; this cell, plane B
     2: wall = <neighbour cell's plane A>
     3: wall = <neighbour cell's plane B>
  feature = GetBitField(levelBuf + 0x1f8, cellIndex, 4)
  orient  = GetBitField(levelBuf + 0x378, cellIndex, 2)
  ...16-way dispatch on feature...
  return wall-or-feature-derived code
```

The outer renderer calls this **five times per depth step** — three
sibling functions at lateral 0 (three faces of the centre cell) plus
`0x9202` at lateral −1 and +1 — and pushes the five results as
`CODE+0x9b58`'s base-index arguments (§4.7.1's call-site table).

**This is a shared-edge wall model.** Each cell stores only 2 of its 4
walls; the other two come from the neighbouring cell's planes. That is a
first-class thing the generic data model must express (§5.3).

### 2.5 On-disk level geometry (confirmed structure, rendered value meanings)

`scenario.dbs` section 2: 14 × 1346-byte level records, each covering a
256×256 maze coordinate space via **12 fixed 8×8-cell regions placed by
an explicit origin table** (§4.7.3). 13 fields partition the record
exactly, zero slack. `cellIndex = region*64 + localY*8 + localX`.
Bit-fields are LSB-first.

Already extracted to
`public/assets/wizardry6/amiga/maps/maze-levels.json` by
`tools/wizardry6/decode-scenario-maze.ts`. Verified shape:

```json
{ "note": "...", "levelCount": 14, "regionCount": 12, "regionSize": 8,
  "levels": [ { "level": 0,
    "originX": [12 bytes], "originY": [12 bytes],
    "wallA":  [768], "wallB": [768],
    "feature":[768], "orient":[768],
    "flagP":  [768], "flagQ": [768] } ] }
```

Verification is unusually strong: 0 overlapping cells across 10,752
placements; byte-exact match against the DOS/EGA release (0/17,464
geometry bytes differ) and against `newgame.dbs` (0/43,204); all 14
levels render as recognisable dungeon architecture.

**What is still a guess** (`sorcery/docs/wizardry6/TODO.md`,
`maze-plane-semantics`): wall value → meaning (`0/1/2/3 =
open/door/wall/secret` is a *rendered* guess), the 16 feature codes,
and **which plane (A/B) is which absolute compass direction**. §5.4
explains how the data model absorbs this being wrong.

### 2.6 The viewport geometry (measured this session)

Measured directly from `mazedata-composelist.json` × `mazedata.json`,
excluding the UI-icon records (`dirIndex >= 133`):

- **Corridor viewport: X 72..248, Y 32..144** — a **176×112 window** on
  the 320×200 screen, horizontally centred on x=160.
- The UI icon strip sits at Y=7, X 16..304.
- Mirrored pairs are geometrically symmetric about byte column 20
  (=160px): compose record 16 lands at px 104 width 24; its mirror
  partner 20 lands at px 192 width 24, and `192 = 320 - 104 - 24`.

### 2.7 A known-good static corridor recipe (decoded this session)

`data-structure.md` §4.4 mentions "the densest block,
`CODE+0x632c`-`0x6552`, is a straight-line 16-call sequence composing
the static corridor frame". I decoded it directly out of
`data/wizardry6/amiga/Bane` (CODE hunk base = file offset `0x28`; the
`4e55 0000 4267 2f2c b7ba 4eac 8158` prologue is at file `0x6354`).
All `4EBA` displacements resolve to `CODE+0x3d72` = `DrawMazePiece`,
confirming the decode.

**The full sequence, `(srcIdx, mode, dstIdx)`, in actual program order**
(**correction, 2026-08-03**: an earlier pass of this doc had the two
wall-triple groups reversed; the real order at `CODE+0x6372`-`0x63dc`
is right-then-left, verified against the disassembly. Harmless for a
byte-exact render since both triples are `mode=1` — bitwise OR is
commutative — and the two groups don't overlap on screen (dest px
104/128/144 vs 192/176/168), but a golden-file author should encode
the real order, not this table's prior wrong one. Push order at the
call site is `dstIdx, mode, srcIdx`, srcIdx last, at `8(A5)`.
**Trap:** `srcIdx == dstIdx` (the ceiling/floor triples below) is
*still* the mirrored path — `DrawMazePiece` dispatches on
`dstIdx == 0xFFFF`, not on `srcIdx == dstIdx`, so these are drawn
horizontally mirrored onto their own placement, not copied as-is.):**

```
(123, 1, 123)  (124, 1, 124)  (125, 1, 125)      ; ceiling strips, mirrored in place
( 20, 1,  16)  ( 21, 1,  17)  ( 22, 1,  18)      ; left wall drawn from right art
( 16, 1,  20)  ( 17, 1,  21)  ( 18, 1,  22)      ; right wall drawn from left art
(151, 1, 151)  (152, 1, 152)  (153, 1, 153)      ; floor strips, mirrored in place
( 25, 0, 0xFFFF)  ( 28, 0, 0xFFFF)               ; far-wall / doorway, replace mode
( 31, 0, 0xFFFF)  ( 34, 0, 0xFFFF)
```

followed at `CODE+0x64fc` by the six-icon status bar, exactly as §4.6
predicted ("immediate compose-list indices `0x15a`-`0x169`"):

```
(346, 0, 0xFFFF) (349, 0, 0xFFFF) (352, 0, 0xFFFF)
(361, 0, 0xFFFF) (355, 0, 0xFFFF) (358, 0, 0xFFFF)
```

Resolved to real placements (compose record → source size → screen px):

| compose | dir | src px | dest px x | dest w | dest y |
|---|---|---|---|---|---|
| 123 | 45 | 112×12 | 104 | 112 | 39 |
| 124 | 46 | 64×8 | 128 | 64 | 51 |
| 125 | 47 | 32×3 | 144 | 32 | 59 |
| 16 | 4 | 24×87 | 104 | 24 | 40 |
| 17 | 5 | 16×51 | 128 | 16 | 52 |
| 18 | 6 | 8×27 | 144 | 8 | 60 |
| 20 | 8 | 24×87 | 192 | 24 | 40 |
| 21 | 9 | 16×51 | 176 | 16 | 52 |
| 22 | 10 | 8×27 | 168 | 8 | 60 |
| 151 | 57 | 112×24 | 104 | 112 | 104 |
| 152 | 58 | 64×16 | 128 | 64 | 88 |
| 153 | 59 | 32×5 | 144 | 32 | 83 |
| 25 | 13 | 32×5 | 144 | 32 | 59 |
| 28 | 16 | 32×2 | 144 | 32 | 86 |
| 31 | 19 | 8×22 | 144 | 8 | 64 |
| 34 | 22 | 8×22 | 168 | 8 | 64 |

**This table is milestone M1's acceptance oracle.** It is a complete,
self-contained, disassembly-sourced corridor frame that needs no level
data, no wall semantics, and no unresolved TODOs to render. Build the
renderer against it first.

---

## 3. Prior art findings

### 3.1 middilgard — War in Middle Earth (**no walker exists**)

`/home/ctemplet/Development/middilgard/README.md:4-6` — WIME = **War in
Middle Earth** (Melbourne House / Virgin, 1988-89). The project covers
five titles (`PLAN.md:24-31`): WIME, Spirit of Excalibur, Vengeance of
Excalibur, Conan the Cimmerian, Warriors of Legend.

**Finding: there is no first-person dungeon walker anywhere in the
project.** An exhaustive grep for `dungeon|maze|first.person|raycast|
walker|3d` across `src/`, `tools/`, `docs/` yields two hits, both
non-code: an aspirational table row at
`middilgard/docs/architecture-overview.md:201`, and a resource-file
catalogue entry at `middilgard/docs/conan/amiga/engine.md:34`
(`DUNG32.RES`, 43 dungeon images — never decoded into a level model,
never rendered, and Conan's palette is confirmed-blocked).

Ironically the *best* walker source material in that corpus is
completely undecoded: Warriors of Legend's `walls.res` (80 wall
textures), `floor.res` (19), `furn.res` (161), `inter.res` (50),
`scenes.res` (316 NECS room definitions) —
`middilgard/docs/legend/dosvga/engine.md:55-74`. NECS is confirmed *not*
the same format as SCEN (`:147`) and PAMM map dimensions are unsolved.

What *does* exist, and is worth studying:

**A 320×200 sprite compositor** —
`middilgard/src/data/scene-compositor.ts:131-282` (`compositeScene()`)
plus `middilgard/src/assets/formats/bscene.ts:1054-1168`
(`generateSceneObjects()`). Side-on 2D, depth faked by Y position,
painter's-algorithm sort (`scene-compositor.ts:259`), verified
pixel-exact against emulator captures (24/24 placements,
`middilgard/docs/wime/amiga/bscene-format.md:588-607`). Rendered with
**raw Canvas 2D**, not PixiJS.

**A PixiJS v8 top-down tilemap** — `middilgard/src/engine/Game.ts:438-471`
(update loop), `middilgard/src/map/TileMap.ts:45-77` (viewport-culled
tile blit with a reused sprite pool, `:117-126`).

#### Adopt from middilgard

1. **Offline pipeline / runtime consumer split** — the runtime never
   parses original binaries. Non-negotiable; already the Seer norm.
2. **Keep the compositor renderer-agnostic.** Middilgard's scene
   compositor targets a raw 320×200 canvas, entirely independent of the
   PixiJS tilemap path. That separation is exactly right and is the
   direct ancestor of this plan's §6 recommendation.
3. **Position-seeded deterministic PRNG for procedural dressing** —
   `bscene.ts:734-783`: `seed = ((posY>>4)<<16) | (posX>>4)`, a pure
   function of the tile, so revisits reproduce byte-identically with
   zero storage. If a walker ever needs procedural decoration, this is
   the pattern.
4. **"Ship the read-set, not the artefact"** — `bscene.ts:1383-1434`
   captures the 668 bytes across 72 ranges that a reimplemented routine
   can ever read, rather than shipping the whole 20 KB hunk. Verified
   byte-exact across 16,160 tiles.
5. **Sprite pooling and viewport culling** — `TileMap.ts:56-76,117-126`.
   No per-frame allocation.
6. **Honest degradation in tooling** —
   `middilgard/tools/viewer/components/tile-scene-source.ts:103-106`
   makes the viewer *warn* when it is omitting objects rather than
   silently under-rendering. Adopt for the walker's debug overlay.
7. **In-place correction banners in docs** and a
   `docs/reference/eliminated/` directory of recorded dead ends. Already
   sorcery's practice; keep it for the walker.

#### Generalise past middilgard

1. **No collision system at all.** `MovementSystem.ts:21-86` — speed-0
   terrain just means "don't move this frame"; nothing blocks. There is
   no precedent to reuse; the walker builds this from zero.
2. **No cell/wall/door type.** The level model is
   `{width, height, tileSize, tiles: number[]}`
   (`middilgard/src/data/GameData.ts:16-21`). Doors exist only as
   screen-space pixel hotspots (`scen.ts:85-100`, `SCEN_DOOR_RECTS` at
   `:119-129`). Generalise to a real cell/edge model (§5).
3. **Facing is decoded and then ignored.** `buildSceneContext`
   (`bscene.ts:900-952`) computes a facing-derived `neighbourTerrain`,
   and `generateSceneObjects()` never reads it — turning changes
   nothing. For a walker, facing selecting geometry *is the entire
   product*. Make facing a first-class input to the view builder and
   test it explicitly.
4. **Two divergent render paths in one function.**
   `scene-compositor.ts:208-221` (engine-accurate, early-returns) vs
   `:224-263` (legacy, known-wrong). Ship exactly one renderer; keep
   alternates behind a backend interface, never behind an `if` inside
   the draw function.
5. **Magic numbers duplicated in three places.** `tileSize` exists in
   `map.json` yet `16` is hardcoded at `Game.ts:247`,
   `MovementSystem.ts:4`, `build-map.ts:23`. Every geometric constant in
   the walker comes from the level/slot schema, never a literal.
6. **Two incompatible `map.json` schemas** — WIME writes
   `{width,height,tileSize,tiles}`, shared `buildGameMap` writes
   `{cols,rows,tileSize,grid}` (`tools/shared/build-map.ts:136-139`).
   Pick one schema and version it (§5.1 does).
7. **Grid dimensions inferred from a size factorisation** — this
   produced a transposed, diagonally-sheared map
   (`build-map.ts:34-43`). Dimensions must always be declared fields.
8. **Rendering explicitly untested** (`middilgard/AGENTS.md:189`:
   "Skip tests for PixiJS rendering code"). Reasonable for sprite
   blitting; unacceptable for a walker, where the slot/projection layer
   *is* pure arithmetic and *is* testable. §6.4 keeps that layer pure.

### 3.2 crawl — Black Crypt (**same rendering family, different map**)

`/home/ctemplet/Development/crawl/README.md:1-3` — Black Crypt
(Raven Software / EA, 1992, Amiga OCS/ECS, 320×200 EHB 64-colour), with
a DOS/VGA port used only as a cross-platform oracle, and Eye of the
Beholder present as research-only specs. `crawl/src/` is a 4-file stub —
`main.ts` is still the unmodified `createGame({worldWidth:1024,...})`
template. **crawl has a complete spec and extracted art but zero
renderer code; the generic walker would be its first runtime.**

**Its first-person renderer is the same family as Wizardry 6's**
(`crawl/docs/blackcrypt/amiga/data-structure.md:4964-5516`):

- Viewport **208×140 at screen (38,20)** (`:254`, `:3010`, `:5491`).
- `DrawViewport` (`S_1+0x02D46`) is a two-phase **build-then-drain**
  painter's-algorithm renderer (`:5147-5170`).
- Phase 1 walks **exactly 12 squares: 4 depths × 3 laterals** (`:5171-5181`):
  `MOVEQ #$B,D5` (priority 11→0), `MOVEQ #0,D2` (depth 0→3),
  `MOVEQ #2,D6` (lateral 2→0, i.e. D3 = 0, +1, −1).
- Three wall bits per square are enqueued as render kinds (`:5211-5215`):
  kind 5 = front-wall row (**gated `depth < 3`**), kinds 6/7 = left/right
  side wall (**gated `lateral == 0`**).
- `AddRenderItem` (`S_1+0x27D7A`) insertion-sorts 12-byte records by
  `(priority, depthKey)`; drain order is back-to-front (`:5223-5256`).
- `DrawWallPieceDispatch` indexes **fixed descriptor tables** (`:5037-5060`):
  front wall `index = depth*3 + (lateral+1)` → a 9-record × 20-byte table;
  side wall `index = depth*2 + side` → an 8-record × 28-byte table. A
  per-frame mirror flag (`A5+$48F`) picks direct vs. mirrored tables.
- **Two compositing primitives** (`:5012-5023`): opaque pieces via a CPU
  `MOVE.W (a2)+,(a3)+` copy loop per bitplane; masked pieces (side
  walls, doors, pillars, buttons) via the **hardware blitter, minterm
  `$0FCA`** (mask + colour).
- Saturation proof (`:5435-5456`): 9/9 front-wall and 8/8 side-wall
  slots reachable, 0 out of range, 0 unreached.

Slot geometry — each wall row is **left return + front face + right
return**, tiling the viewport exactly (`crawl/AGENTS.md:483-485`):
`16+176+16 = 208` (d0), `48+112+48` (d1), `64+80+64` (d2), with
"3/3 rows tile the 208-px viewport exactly, zero gap and zero overlap"
(`:5450-5453`). Side walls satisfy `x_right = 208 − w − x_left` for
4/4 pairs (`:5455-5456`).

**Its map format is structurally different from Wizardry 6's:**

| | Wizardry 6 | Black Crypt |
|---|---|---|
| Container | 14 levels of **8×8 regions placed by an origin table** | **13 maps, each a flat 64×64 grid**; a 4-bit `level` nibble per square subdivides a map |
| Storage | dense bit planes | **sparse**: per-map row bounds + per-row **signed** `[col_start, col_end]` |
| Walls | **2-bit wall value**, 2 planes/cell, other 2 faces from the neighbour | **4-bit N/E/S/W presence flags**, all 4 in the cell |
| Wall appearance | encoded in the cell's wall value | from the **per-level tileset file**, not the cell |
| Features | 4-bit feature code + 2-bit orientation in the cell | **12-bit `unique` handle** → 20-byte object record (chained sub-records: containers, monster stat blocks, 8-byte action scripts) |
| Doors | a feature code | an object record; open state is bit 0 of record `+0x0F`, read directly by the renderer (`:5369`) |
| Cell width | packed bit fields | **4 bytes**, byte-aligned nibbles |

Black Crypt square layout (`:6338-6355`):
`byte0 [type:4][0xF]`, `byte1 [0xF][level:4]`,
`byte2 [wall_flags:4][uniq_hi:4]`, `byte3 [uniq_lo:8]`, with
`wall_flags` = `+1 N, +2 E, +4 S, +8 W` and `type` =
`+1 wall, +2 darkness, +4 spell-failed, +8 water`.

Art: three tilesets (`bcdfx`, `bcdfy`, `bcdfz`) selected by hardcoded
level range (`crawl/AGENTS.md:219-240`), 83/46/83 sub-images. The atlas
is already extracted with semantic frame names —
`crawl/public/assets/blackcrypt/amiga/textures/dungeon-bcdfx.json` has
`wall0-left/face/right`, `sidewall-depth0-near`, `ceiling`, `floor`,
`door-type{0,1}-{1,2,3}`, `alcove-{a..e}`, `pillar-{a,b,c}`,
`stairs-flight-{a,b}-depth{0,1,2}`, etc.

**Two crawl-side gaps that block M5:**
1. **No level geometry has ever been exported.** `bcdfs.py`
   (`crawl/scripts/bclib/bcdfs.py`) is a verified loader used only to
   pull item names; there is no `levels.json` under `public/assets/`.
2. **The atlas carries no destination coordinates.** `{name,x,y,w,h}`
   only; the descriptor tables' dest X/Y live in prose in the docs.
   Extracting them into a machine-readable slot table is prerequisite
   work — and is precisely what §5.5 standardises.

Also worth noting for a *third* consumer: EOB/Lands of Lore
(`crawl/docs/eotb/amiga/eotb-vmp-spec.md:69-191`) is the same family
one indirection deeper — the view cone is assembled from **8×8 blocks**
via a VMP index table (22×15 backdrop indices, 431 indices per wall
type, 25 wall positions, 17 map cells read), with tile indices carrying
`z_mask:1 | mirror_x:1 | tile_index:14` flags. §5.5 keeps "a piece" open
enough to be either an atlas frame or a block-index rectangle.

### 3.3 The Seer framework — verified, not assumed

`/home/ctemplet/Development/seer/docs/architecture-overview.md` §8
describes `Game / Camera / InputManager / AssetLoader / SceneRenderer /
EntityManager / AudioManager`. **Three of those seven do not exist.**
`SceneRenderer`, `EntityManager` and `AudioManager` appear only in that
ASCII diagram (`seer/docs/architecture-overview.md:291-299`). This
project's own copy of that doc (`docs/architecture-overview.md:291-299`)
inherits the same aspirational text. Treat §8 as a wish list.

**What actually exists** (`seer/packages/engine/src/index.ts`, 19 lines —
13 values + 8 types, the whole package):

| Symbol | Reality |
|---|---|
| `Game` / `createGame` | `Game.ts:34-89`, `:116`. Correct PixiJS **v8** lifecycle: `new Application()` → `await app.init({resizeTo, backgroundColor, antialias:false})` → `container.appendChild(app.canvas)` → `app.ticker.add(...)`. **`onUpdate` receives no delta time** (`Game.ts:80-83`). `Game` never applies the camera to the stage — that wiring is a consumer TODO. |
| `Camera` | `Camera.ts:16-189`. `CameraState = {x, y, zoom}` — **no orientation field of any kind**. |
| `InputManager` | `InputManager.ts:28-197`. WASD/arrows are hardwired into `camera.pan(dx,dy)` at `:93-96`; RTS edge-scrolling at `:99-107`; wheel → `camera.zoomAt` at `:159-166`; drag-to-pan at `:146-157`. |
| `DisplayMode` | `DisplayMode.ts:22-36`. A single-member union `'modern'` and a frozen `{minZoom:0.25, maxZoom:6, scaleMode:'nearest'}`. `scaleMode` is read by nothing. |
| `pixi-helpers` | `sliceAtlas`/`sliceAtlasKeyed` handle **uniform grids only** (`cellWidth × cellHeight × columns × rows`) — they cannot express a packed atlas with per-frame rects, which is what every real Seer extractor emits. |

**`Camera` is structurally unusable for a first-person view.** I verified
`_clamp()` at `seer/packages/engine/src/Camera.ts:173-188`:

```ts
const minZoomToFill = Math.max(viewWidth/worldWidth, viewHeight/worldHeight);
if (this._zoom < minZoomToFill) this._zoom = minZoomToFill;   // world must fill viewport
this._x = Math.max(halfW, Math.min(this._worldWidth  - halfW, this._x));
this._y = Math.max(halfH, Math.min(this._worldHeight - halfH, this._y));
```

It is called unconditionally from `setViewSize`, `setWorldBounds`, `pan`,
`moveTo`, `zoomAt`, `setZoom`, with no opt-out. A first-person viewpoint
must sit *inside* the world and carry a facing; neither is expressible.

**`InputManager` is equally unusable**: no key-state accessor
(`isDown(code)`), no pointer lock, no relative mouse motion. `onKey`
(`:83`) is one-shot-per-keydown, fine for menus, wrong for held movement.

**`@seer-project/core`** (`packages/core/src/index.ts`): six functions, one
class, three types. `BinaryReader`, `r8/r16/r24/r32`, `dataViewOf`,
`loadAssets`, `createAssetLoader`, `AssetSchema`, `InferredAssets`.
`loadAssets<T>(basePath, schema)` is a `Promise.all` over `fetch` that
`.json()`s anything ending `.json` and `.text()`s everything else
(`packages/core/src/assets.ts:39-73`) — **there is no binary fetch path**
despite the file header claiming otherwise at `assets.ts:2-3`.
**There are no atlas, palette, manifest, grid or tilemap types anywhere
in any `@seer-project/*` package.**

**`@seer-project/pipeline`** exports `PlatformConfig`, `GameConfig`,
`defineGameConfig`, `runPipeline`, `readBinary`, `writePNG`,
`writeIndexedPNG`, `writeJson`, `resolveDataDir`, `findFileCI`,
`hexDump`, and more. It **defines zero asset-output schemas** — it has
no opinion on atlas or palette shape. `runPipeline`
(`packages/pipeline/src/pipeline.ts:97-202`) runs exactly **two** stages
(`exportGameData`, `buildAssets`); the architecture doc's "Stage 3:
Build Music Assets" has no code behind it.

Note a live bug to work around: `writeIndexedPNG`
(`packages/pipeline/src/io.ts:30-46`) documents "A=255" but actually
writes `A = (v === 0 ? 0 : 255)` — it hardcodes index 0 as transparent.
See §8.2.

**`create-seer` templates** define the framework-standard project shape
(`packages/create-seer/templates/`): `src/{game-id,main}.ts`,
`src/data/{GameData,AssetLoader}.ts`, `tools/shared/game-config.ts`,
`tools/<game>/{export-game-data,build-assets}.ts`, optional
`tools/viewer/`. The scaffolded `main.ts` is 20 lines and both hooks are
empty — **there is no working render path anywhere in the framework**,
so the walker is not diverging from a working baseline; there isn't one.

Two conflicting `AtlasMeta` definitions ship in the same template set:
a uniform-grid one at `templates/src/data/GameData.ts.eta:5-15` (what
sorcery's `src/data/GameData.ts:5-11` still contains) and a
packed-frames one at `templates/tools/viewer/shared.ts.eta:1-17` (what
sorcery's `tools/viewer/shared.ts:9-13` and every real extractor
actually use). **The packed-frames shape is the de facto standard**;
`src/data/GameData.ts` is stale placeholder text.

Monorepo mechanics: npm workspaces (`packages/*`), **no build step** —
every package sets `main`/`types`/`exports` to `./src/index.ts` and
ships raw TypeScript; root `tsconfig.json:14` is `noEmit: true`. Adding
a package is: create `packages/<name>/{package.json,tsconfig.json,src/index.ts}`,
extend the root tsconfig, done. Tests are Vitest, colocated in
`src/__tests__/`, auto-discovered by root `vite.config.ts:58-64`.

---

## 4. Framework placement

### 4.1 Recommendation

**Create a new browser-safe package
`@seer-project/dungeon` at `/home/ctemplet/Development/seer/packages/dungeon/`**,
with two export subpaths:

```jsonc
// packages/dungeon/package.json
{
  "name": "@seer-project/dungeon",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".":        "./src/index.ts",        // runtime: needs pixi.js
    "./schema": "./src/schema/index.ts"  // pure types + validators, ZERO deps
  },
  "peerDependencies": { "pixi.js": "^8.9.0" },
  "dependencies": { "@seer-project/core": "*" },
  "scripts": { "test": "vitest run", "lint": "eslint src/" }
}
```

This mirrors `@seer-project/engine`'s existing dual-export precedent
(`"."` and `"./pixi-helpers"`) and its `peerDependencies: {pixi.js}`
convention, so it needs no new framework machinery.

The `./schema` split matters: a project's Node-side `tools/` scripts must
import the level/slot/atlas types to *emit* conforming JSON, and they
must not drag PixiJS into a `tsx` script. The subpath makes that a
module-resolution guarantee rather than a convention, in the spirit of
`seer/docs/framework-plan.md` §8.

Do **not** add it to `@seer-project/engine`. `@seer-project/engine` is a 2D pan/zoom
map-viewer scaffold whose two most prominent exports are actively
incompatible with a first-person view (§3.3), and mixing them would
force every existing consumer to carry dungeon code they will never use.

### 4.2 Proposed package layout

```
packages/dungeon/
  package.json
  tsconfig.json                      # { "extends": "../../tsconfig.json", "include": ["src"] }
  README.md
  src/
    index.ts                         # runtime barrel (re-exports ./schema too)
    schema/
      index.ts                       # zero-dependency barrel
      level.ts                       # DungeonLevelFile, CellSpace, WallStorage, ...
      slots.ts                       # SlotTableFile, PieceRef, Placement, BlendMode
      semantics.ts                   # WallSemantics, FeatureSemantics, FacingMap
      validate.ts                    # runtime validators used by tools/ AND the loader
      version.ts                     # SCHEMA_VERSION + migration notes
    model/
      CellQuery.ts                   # the read interface + adapters
      RegionGridLevel.ts             # Wizardry-6-shaped: regions placed by origin table
      FlatGridLevel.ts               # Black-Crypt-shaped: dense/sparse flat grid
      Pose.ts                        # {level, x, y, facing} + step/turn maths
      Direction.ts                   # Dir4, deltas, rotation, compass binding
    view/
      ViewSpec.ts                    # depth/lateral extents, slot address maths
      buildViewList.ts               # PURE: (level, pose, spec, bindings) -> DrawItem[]
      DrawItem.ts
      sort.ts                        # painter's-algorithm ordering
    raster/
      IndexedSurface.ts              # Uint8Array index framebuffer + blit primitives
      PieceBank.ts                   # decoded art pieces as index buffers
      composite.ts                   # DrawItem[] -> IndexedSurface
      palette.ts                     # index buffer + palette -> RGBA
    render/
      PixiPresenter.ts               # IndexedSurface -> one Pixi Sprite (v8)
      CanvasPresenter.ts             # IndexedSurface -> ImageData (viewer/tests/node)
      SpriteGraphRenderer.ts         # ALTERNATE backend: DrawItem[] -> Pixi scene graph
    input/
      KeyState.ts                    # held-key tracker (what @seer-project/engine lacks)
      WalkerController.ts            # key bindings -> pose transitions, step throttling
    debug/
      Minimap.ts                     # top-down grid + view cone
      SlotInspector.ts               # which slot address produced which draw item
    __tests__/
      *.test.ts
```

### 4.3 Tradeoffs considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **New `@seer-project/dungeon` package** (recommended) | Reusable across sorcery/crawl/future titles, which is the stated requirement. Clean browser/Node boundary via the `./schema` subpath. Testable in isolation with Vitest, no game data needed. Adding a package is mechanical (§3.3). | A second repo to keep in sync during rapid iteration (mitigated: consumers link it via `file:../seer/packages/*` already, so edits are live). Risk of premature generalisation from n=1. | **Do this**, but see the sequencing guard below. |
| Project-local `sorcery/src/dungeon/` | Fastest to start; free to churn interfaces. | Guarantees a painful extraction later, and the extraction is exactly where generic design gets skipped. crawl would copy-paste. Contradicts the explicit "other games of a similar nature" goal. | No. |
| Extend `@seer-project/engine` | One fewer package. | `Camera`/`InputManager` are incompatible (§3.3), `pixi-helpers` assumes a 2D affine camera, and every existing consumer pays for it. | No. |
| Two packages (`@seer-project/dungeon-core` schema-only + `@seer-project/dungeon-pixi`) | Maximum boundary rigour. | The `./schema` subpath already achieves it; a second package is ceremony the framework has no precedent for. | No. |

**Sequencing guard against premature generalisation.** Build M1-M4
(Wizardry 6) *inside the package from day one*, but do not treat any
interface as stable until M5 has driven Black Crypt through it. Mark the
package `"version": "0.0.x"` and put a "pre-1.0: interfaces change
without notice" banner in its README. §3.2's table is the concrete
list of pressures M5 will apply.

---

## 5. Generic data model

Design principle throughout: **the walker knows about structure; the game
config supplies meaning.** Every place where Wizardry 6 has a magic value
whose meaning is a *rendered guess* becomes a lookup in a per-game table,
never a branch in walker code.

### 5.1 Files a game must produce

Three Stage-2 outputs, all versioned:

```
public/assets/<game>/<platform>/
  dungeon/levels.json        # geometry            (DungeonLevelFile)
  dungeon/slots.json         # art placement       (SlotTableFile)
  dungeon/semantics.json     # value -> meaning    (SemanticsFile)
  maps/<artbank>.png|.json   # existing packed atlas (unchanged)
  palettes/<name>.json       # existing {colors:[{r,g,b}]} (unchanged)
```

Every file carries `"schemaVersion": 1`. The loader hard-fails on an
unknown major version rather than mis-parsing — `maze-plane-semantics`
being unresolved means these files *will* be regenerated with changed
meanings, and a silent stale-asset load would be a very expensive
debugging session.

### 5.2 Level geometry

```ts
// schema/level.ts
export type Dir4 = 0 | 1 | 2 | 3;   // walker-canonical: 0=N, 1=E, 2=S, 3=W

export interface DungeonLevelFile {
  schemaVersion: 1;
  game: string;
  platform: string;
  /** How cells are addressed. Determines which adapter loads this file. */
  cellSpace: CellSpace;
  /** How wall values are stored per cell. See §5.3. */
  wallStorage: WallStorage;
  levels: DungeonLevelData[];
  /** Free-form provenance: extractor name, doc section, confidence notes. */
  provenance?: Record<string, string>;
}

export type CellSpace =
  /** Wizardry 6: N fixed regions of RxR cells, each placed at an origin. */
  | { kind: 'regions'; regionCount: number; regionSize: number;
      worldWidth: number; worldHeight: number }
  /** Black Crypt / most others: one dense WxH grid. */
  | { kind: 'flat'; width: number; height: number };

export interface DungeonLevelData {
  id: number;
  name?: string;
  /** Present iff cellSpace.kind === 'regions'. Length = regionCount. */
  originX?: number[];
  originY?: number[];
  /**
   * Per-cell planes, flat arrays in the cell space's own index order.
   * Keys are game-defined; the walker only knows the names the
   * semantics file binds. Wizardry 6 supplies:
   *   wallA, wallB, feature, orient, flagP, flagQ
   * Black Crypt supplies:
   *   wallN, wallE, wallS, wallW, type, sublevel, objectHandle
   */
  planes: Record<string, number[]>;
  /** Optional per-level art/palette selection (Black Crypt: 3 tilesets). */
  tileset?: string;
  paletteVariant?: string;
  /** Optional opaque per-cell entity handles; walker passes them through. */
  entities?: unknown;
}
```

Note this is a **superset of what the existing Wizardry 6 extractor
already writes**. `maze-levels.json` currently has `originX`, `originY`,
`wallA`, `wallB`, `feature`, `orient`, `flagP`, `flagQ` at the level
level; converting it is a mechanical re-nesting into `planes`, plus a
header. That conversion is M0 work in `tools/wizardry6/decode-scenario-maze.ts`.

### 5.3 Walls: the shared-edge problem

This is the single most important generalisation, and it is forced by
the two games disagreeing:

- **Wizardry 6** stores **2 planes per cell** (`+0x060` = plane A,
  `+0x120` = plane B) and gets the other two faces from the
  **neighbouring cell** (`CODE+0x908c` / `CODE+0x90f6`, §4.7.2). A wall
  is an *edge* shared between two cells, stored once.
- **Black Crypt** stores **all 4 sides in the cell** as presence bits
  (`wall_flags` = `+1 N, +2 E, +4 S, +8 W`,
  `crawl/docs/blackcrypt/amiga/data-structure.md:6338-6355`), so an edge
  is stored twice and the two copies can in principle disagree.

The walker must not care. Model it as:

```ts
export type WallStorage =
  /**
   * Each cell stores its wall for two of the four directions; the other
   * two are read from the neighbour in that direction, using ITS plane
   * for the opposite face.
   */
  | { kind: 'shared-edge';
      /** planes[0] serves facing planeDirs[0]; planes[1] serves planeDirs[1]. */
      planes: [string, string];
      /**
       * Which absolute compass direction each plane represents.
       * UNRESOLVED for Wizardry 6 (see maze-plane-semantics). Ships as a
       * documented placeholder and can be changed WITHOUT a code change.
       */
      planeDirs: [Dir4, Dir4];
      /** Value returned when a step leaves the map. W6 returns 2 (solid). */
      offMapValue: number }
  /** Each cell stores all four of its own walls. */
  | { kind: 'per-cell-4'; planes: [string, string, string, string] }
  /** All four walls packed as bit flags in one plane. */
  | { kind: 'bitflags'; plane: string; bits: [number, number, number, number] };
```

`CellQuery.wallAt(level, x, y, dir)` resolves all three uniformly:

```ts
export interface CellQuery {
  inBounds(x: number, y: number): boolean;
  /** Raw, game-specific wall value for the edge on `dir` of cell (x,y). */
  wallAt(x: number, y: number, dir: Dir4): number;
  /** Raw plane value at a cell (feature, orient, objectHandle, ...). */
  planeAt(name: string, x: number, y: number): number;
}
```

Adapters: `RegionGridLevel` (does the `region*64 + localY*8 + localX`
lookup and the origin-table search) and `FlatGridLevel` (does `y*width + x`).
Both are ~60 lines and are the *only* code that knows about cell
addressing.

**Cross-check that this is right:** Black Crypt's `wall_flags` under
`kind: 'bitflags'` and Wizardry 6's planes under `kind: 'shared-edge'`
both reduce to the same `wallAt(x,y,dir) -> number` signature, and the
view builder (§6.2) is written against that signature alone. If a third
game stores walls as an explicit edge list, that is a fourth
`WallStorage` variant and zero changes elsewhere.

### 5.4 Semantics — how unresolved meanings stay soft

This is the direct answer to "`maze-plane-semantics` is a rendered guess,
don't hardcode it".

```ts
// schema/semantics.ts
export interface SemanticsFile {
  schemaVersion: 1;
  /** Confidence, verbatim from the RE docs. Surfaced in the debug overlay. */
  confidence: 'confirmed' | 'rendered' | 'hypothesis';
  /** Free-text pointer to the doc section this encodes. */
  source: string;
  walls: Record<string, WallMeaning>;      // key = stringified raw value
  features: Record<string, FeatureMeaning>;
  /** Optional: how this game's facing indices map to walker Dir4. */
  facingMap?: [Dir4, Dir4, Dir4, Dir4];
}

export interface WallMeaning {
  label: string;              // "open" | "door" | "wall" | "secret" | ...
  blocksMovement: boolean;    // collision
  blocksSight: boolean;       // stops the depth walk
  /** Which slot-table piece kind draws this wall, or null for nothing. */
  pieceKind: string | null;
  /** Optional: a different piece kind once discovered/opened. */
  discoveredPieceKind?: string | null;
}

export interface FeatureMeaning {
  label: string;
  /** Piece kind drawn in addition to the wall, or null. */
  pieceKind: string | null;
  /** Does the feature's 2-bit orientation gate whether it is drawn? */
  orientationGated?: boolean;
  blocksMovement?: boolean;
  /** Opaque tag the host game can react to (stairs, teleporter, trap). */
  tag?: string;
}
```

Wizardry 6's file ships as, and is *labelled as*, the current guess:

```jsonc
{ "schemaVersion": 1, "confidence": "rendered",
  "source": "sorcery/docs/wizardry6/amiga/data-structure.md §4.7.3; TODO maze-plane-semantics",
  "walls": {
    "0": {"label":"open",   "blocksMovement":false,"blocksSight":false,"pieceKind":null},
    "1": {"label":"door",   "blocksMovement":false,"blocksSight":true, "pieceKind":"door"},
    "2": {"label":"wall",   "blocksMovement":true, "blocksSight":true, "pieceKind":"wall"},
    "3": {"label":"secret", "blocksMovement":true, "blocksSight":true, "pieceKind":"wall",
          "discoveredPieceKind":"secret-door"}
  },
  "features": { "0": {"label":"none","pieceKind":null} /* 1..15 TBD */ } }
```

Consequences, all deliberate:

1. Changing the guess is a **JSON edit**, not a code change or a rebuild.
2. `planeDirs` (§5.3) makes the plane→compass question a **two-element
   array in a data file**. All four candidate assignments are reachable by
   editing two numbers.
3. The debug overlay renders `confidence` prominently, so nobody
   mistakes a rendered guess for ground truth while play-testing.
4. **The walker becomes the oracle that resolves the TODO.** Walking a
   known corridor with the wrong `planeDirs` produces a visually obvious
   failure (walls on the wrong side, or a corridor you can walk through).
   This is a strictly better test than static histogram analysis, and it
   is why §10.1 recommends *not* blocking on the TODO.

### 5.5 Slot table — the art placement contract

This is the piece **neither project currently emits**, and both need it.

```ts
// schema/slots.ts
export interface SlotTableFile {
  schemaVersion: 1;
  /** Native render surface, in pixels. W6: 320x200. Black Crypt: 320x200. */
  surface: { width: number; height: number };
  /** The sub-rect the dungeon view occupies. W6: {72,32,176,112} (§2.6).
   *  Black Crypt: {38,20,208,140}. */
  viewport: { x: number; y: number; width: number; height: number };
  /** Depth steps walked away from the party. W6: 4. Black Crypt: 4. */
  depthCount: number;
  /** Lateral columns per depth. Both games: 3, meaning -1, 0, +1. */
  lateralOffsets: number[];          // e.g. [-1, 0, 1]
  /** Named art source; resolved against the project's atlas JSON. */
  pieceBanks: PieceBankRef[];
  /** The actual slots. Key: `${pieceKind}:${lateral}:${depth}` */
  slots: Record<string, Slot | null>;
  /** Slots drawn every frame regardless of cell content (ceiling, floor). */
  staticSlots?: Slot[];
  /** Draw order. Lower draws first. Absent = array order. */
  ordering?: 'array' | 'painter-back-to-front';
}

export interface PieceBankRef {
  id: string;                    // "mazedata"
  atlas: string;                 // "maps/mazedata.json"
  image: string;                 // "maps/mazedata.png"
  /** If the image encodes palette indices rather than RGBA. See §8.2. */
  indexed?: boolean;
  palette?: string;              // "palettes/mazedata.json"
}

export interface Slot {
  /** One or more pieces composited in order for this slot. */
  draws: PieceDraw[];
}

export interface PieceDraw {
  bank: string;                  // PieceBankRef.id
  frame: string;                 // atlas frame name, e.g. "mazedata_dir004"
  /** Destination in SURFACE pixels (not viewport-relative). */
  destX: number;
  destY: number;
  /** Source sub-rect within the frame, for the clipped-blit case. */
  srcX?: number; srcY?: number; srcW?: number; srcH?: number;
  /** Horizontal mirror (W6's bit-reversal path; Black Crypt's mirror tables). */
  mirrorX?: boolean;
  /** How to combine with what is already there. See §6.3. */
  blend: BlendMode;
  /** Debug provenance: where this row came from. */
  origin?: string;               // "composeList[16] via CODE+0x632c"
}

export type BlendMode =
  | 'replace'      // W6 mode=0; Black Crypt opaque CPU copy
  | 'or'           // W6 mode=1 — bitwise OR of palette indices
  | 'mask';        // Black Crypt blitter minterm $0FCA; index 0 transparent
```

**Why `destX`/`destY` are in surface pixels, not byte columns:** W6's
byte-column addressing is an artefact of Amiga planar memory. Storing
pixels keeps the schema honest for Black Crypt (whose tables are in
pixels) and for any future game that isn't byte-aligned. The W6
extractor multiplies by 8 on the way out; the invariant
`destX % 8 === 0` becomes an assertion in the extractor, not a
constraint in the schema.

**Why `frame` is a string, not an index:** the atlas format both projects
already emit is `{frames:[{name,x,y,w,h}], width, height}`
(`tools/viewer/shared.ts:1-13`;
`crawl/public/assets/blackcrypt/amiga/textures/dungeon-bcdfx.json`).
Names survive re-packing; indices do not.

**Room for EOB-style games:** a future `PieceDraw` variant
`{kind:'blockGrid', indices:number[], cols, rows, blockSize}` covers
EOB/LoL's VMP model (`crawl/docs/eotb/amiga/eotb-vmp-spec.md:124-191`)
without disturbing anything above. Do not build it in v1; just don't
close the door.

### 5.6 Deriving Wizardry 6's slot table

`slots.json` for W6 is generated by extending
`tools/wizardry6/decode-maze.ts`. Each compose-list record becomes a
`PieceDraw`:

```
destX  = (destXByte + srcClip) * 8
destY  = destY
srcX   = srcClip * 8
srcW   = widthBytes * 8
srcY   = 0
srcH   = directory[dirIndex].heightRows
frame  = `mazedata_dir${dirIndex.pad(3)}`
skip if widthBytes === 0
```

**Correction, 2026-08-03:** the paragraph originally here said a
mirrored call takes "art fields from `composeList[src]`, placement
fields from `composeList[dst]`" — that's wrong in a way that would
corrupt pixels if implemented literally (it mis-windows every mirrored
piece, which is 12 of the 16 static-corridor calls in §2.7). Traced
directly from `DrawMazePiece`'s mirrored path at `CODE+0x3efe`
(`sorcery/docs/wizardry6/amiga/disasm/Bane.asm:5621+`): only `dirIndex`
comes from `composeList[src]`. `srcClip` and `widthBytes` — both
source-side fields — come from the **placement** record
(`composeList[dst]`), not the art record. The real derivation, with
`art = directory[composeList[src].dirIndex]` and `p = composeList[dst]`:

```
srcX    = (art.widthUnits - p.srcClip - p.widthBytes) * 8   ; window measured from the RIGHT edge
srcW    = p.widthBytes * 8
srcY    = 0
srcH    = art.heightRows            ; height & row-stride come from the ART record
destX   = (p.destXByte + p.srcClip) * 8
destY   = p.destY
mirrorX = true
```

(Register trace, for anyone re-verifying against the binary: `A2 = &directory[composeList[srcIdx].dirIndex]`;
`A3 = (A2) + A2[4]-1 - A0[3]` where `A0 = &composeList[dstIdx]`; loop
count `D3 = A0[4]-1`; row count `D4 = A2[5]`; row stride `A2[4]`.)

A direct call (`dst === 0xFFFF`) takes everything from
`composeList[src]`, unchanged from the original text above.

**M1 emits only the `staticSlots` array** — the 16 entries of §2.7 plus
the 6 icons — which requires no wall semantics at all. The keyed `slots`
map arrives at M2 and depends on the open question in §10.1.

---

## 6. Rendering approach

### 6.1 Technique choice, and why not raycasting

**Recommendation: slot-addressed sprite/piece compositing, closely
modelled on `DrawMazePiece`.** Reject raycasting and 3D.

| Approach | Verdict |
|---|---|
| **Slot compositing** (recommended) | Both confirmed target engines do exactly this (§2.2, §3.2). The compose list *is* the projection — perspective, clipping, and vanishing point are already baked into authored tables. Reproduces the originals pixel-for-pixel. |
| Raycasting (Wolfenstein-style) | **Wrong.** There are no wall *textures* to project — `mazedata.ega` contains pre-scaled wall *pieces* (112×87, 64×51, 32×27 for one texture, §2.7). Raycasting would require re-authoring art that does not exist, and would produce a look neither game ever had. |
| Textured 3D quads (Pixi mesh / three.js) | Same art problem, plus a much larger dependency and a camera model the source engines don't have. Would be the right call for a game that shipped real 3D; neither of these did. |
| Scaled-sprite billboards (scale one wall texture per depth) | Superficially attractive, but the games' own per-depth pieces are **not** uniform scalings of each other — they are separately drawn (e.g. W6 dir 3/4/5/6 = 32×112, 24×87, 16×51, 8×27, not a clean ratio). Scaling would look wrong and throw away real art. |

### 6.2 Layer 1 — the view builder (pure, testable)

```ts
// view/buildViewList.ts
export function buildViewList(
  level: CellQuery,
  pose: Pose,
  spec: ViewSpec,          // from slots.json: depthCount, lateralOffsets, viewport
  semantics: Semantics,    // from semantics.json
  slots: SlotTable,
): DrawItem[]
```

Algorithm (deliberately mirrors both source engines):

```
items = []
push staticSlots (ceiling, floor, backdrop)
for depth in 0 .. spec.depthCount-1:            # far to near, or near to far + sort
    cell = pose stepped `depth` forward
    if !inBounds(cell): break
    for lateral in spec.lateralOffsets:
        c = cell stepped `lateral` sideways
        # side walls: only from the centre column in both games
        if lateral == 0:
            emit(wallAt(c, left(pose.facing)),  'sideLeft',  depth, lateral)
            emit(wallAt(c, right(pose.facing)), 'sideRight', depth, lateral)
        # front wall
        if depth < spec.frontWallMaxDepth:
            emit(wallAt(c, pose.facing), 'front', depth, lateral)
        emit feature pieces for c at (depth, lateral)
    if any wall at this depth blocksSight: break  # sight-line termination
sort(items) by painter order
```

`emit(rawValue, kind, depth, lateral)` looks up
`semantics.walls[rawValue].pieceKind`, then
`slots[`${pieceKind}:${lateral}:${depth}`]`, and pushes its `PieceDraw`s
as `DrawItem`s. A `null` slot or a `null` `pieceKind` emits nothing.

**Cross-validation that this shape fits both games:**
- Black Crypt: 4 depths × 3 laterals = 12 squares, front wall gated
  `depth < 3`, side walls gated `lateral == 0`
  (`crawl/docs/blackcrypt/amiga/data-structure.md:5171-5215`, `:5474-5482`).
  Direct match, including `frontWallMaxDepth = 3`.
- Wizardry 6: 3 lateral columns per depth (`depth*3 + lateralColumn`,
  `CODE+0x9b60`), depth bounded by 3 in `9b58` and by 4 in the outer
  loop; five evaluator calls per depth = 3 faces of the centre cell +
  the two lateral neighbours (§4.7.1). Also a direct match.

This function is **pure** — no PixiJS, no canvas, no DOM. It is the
layer middilgard never had and never tested (§3.1, point 8). It gets
full unit-test coverage: fixture level → expected `DrawItem[]`.

### 6.3 Layer 2 — the compositor (recommended: indexed framebuffer)

```ts
// raster/IndexedSurface.ts
export class IndexedSurface {
  readonly width: number; readonly height: number;
  readonly data: Uint8Array;          // one palette index per pixel
  clear(index = 0): void;
  blit(src: PieceBuffer, sx, sy, sw, sh, dx, dy, mirrorX: boolean, blend: BlendMode): void;
}
```

`blend` is implemented literally:

```ts
switch (blend) {
  case 'replace': dst[d] = s; break;
  case 'or':      dst[d] |= s; break;                 // W6 mode=1
  case 'mask':    if (s !== 0) dst[d] = s; break;     // transparent-index-0
}
```

Then `palette.ts` expands the surface to RGBA, and a presenter uploads it.

**Why this and not a PixiJS scene graph as the default:**

1. **`or` is not expressible in alpha compositing.** Wizardry 6's
   `mode=1` is a bitwise OR of 4-bit palette indices. Where the
   destination is index 0 it degenerates to a copy, but where it is
   non-zero it produces a *third* index that is neither source nor
   destination. No Pixi blend mode reproduces that. 12 of the 16 calls
   in the confirmed static corridor (§2.7) use `mode=1`.
2. **Mirroring is exact.** W6's mirror walks the source backwards
   through a bit-reversal LUT — in chunky index space that is exactly
   "reverse the pixel order", with no filtering, no half-pixel offset,
   and no dependency on how Pixi rounds a `scale.x = -1` sprite.
3. **Palette variants are free.** The DOS release already ships EGA,
   CGA and t16 recolours of byte-identical art
   (`public/assets/wizardry6/dosega/maps/mazedata{,_cga,_t16}.png`).
   With an index surface, switching is swapping a 16-entry table, not
   re-decoding an atlas.
4. **It is unit-testable.** The compositor's output is a `Uint8Array`.
   Golden-file tests compare bytes, in Node, with no browser and no
   canvas. This is the specific thing middilgard flagged as untestable
   and skipped.
5. **One compositor, two presenters.** `PixiPresenter` for the game,
   `CanvasPresenter` (→ `ImageData` → `putImageData`) for the asset
   viewer, which is plain Canvas 2D today (`tools/viewer/viewer.ts:136`,
   `:166`, `:199`) and should stay that way. This is what makes §8.3's
   viewer integration cheap.
6. **It is cheap.** 320×200 = 64,000 bytes. A full recomposite is
   sub-millisecond, and the view only changes on a pose change anyway
   (§7.3) — typically a handful of times per second, not 60.

**PixiJS v8 presenter**, concretely:

```ts
// render/PixiPresenter.ts
import { Texture, Sprite, BufferImageSource, Container } from 'pixi.js';

const source = new BufferImageSource({
  resource: rgbaBuffer,          // Uint8Array, width*height*4
  width, height,
  scaleMode: 'nearest',
  alphaMode: 'premultiply-alpha-on-upload',
});
const sprite = new Sprite(new Texture({ source }));
// per pose change:
palette.expandInto(surface, rgbaBuffer);
source.update();                 // re-upload
```

Integer-scale the sprite to fit the container (`Math.floor` of the fit
ratio, minimum 1) to preserve pixel crispness; letterbox the remainder.
Put it in its own `Container` so a HUD layer can sit above it as
ordinary Pixi children — which is how the eventual combat/inventory UI
attaches without touching the walker.

### 6.4 The alternate backend, and when to use it

`SpriteGraphRenderer` consumes the same `DrawItem[]` and emits one Pixi
`Sprite` per item from a `sliceAtlas`-style texture cache, using
`scale.x = -1` for `mirrorX`. Keep it because:

- per-piece filters, tints and animation (a torch flicker, a door swing)
  are natural there and awkward in an index buffer;
- interaction picking (click a wall alcove) is free;
- it is a useful correctness cross-check — a scene-graph render and an
  index render of the same `DrawItem[]` should agree everywhere the
  blend mode is `replace` or `mask`.

**Default to `IndexedSurface`.** Select via
`createWalker({ backend: 'indexed' | 'spriteGraph' })`. Both consume
`DrawItem[]`, so the choice never leaks into the view builder — the
mistake middilgard made was putting two render paths inside one function
(`scene-compositor.ts:208-263`), not having two paths.

### 6.5 A caveat about the existing extracted art

`tools/wizardry6/decode-maze.ts:253` renders each `mazedata.ega` record
through `celIndicesToRGBA` (`tools/wizardry6/pic-format.ts:128-139`),
which sets `alpha = 0` for **colour index 15**. That is the confirmed
`.PIC` cel-drawer convention (§2.3: `t = src[0]&src[8]&src[16]&src[24]`,
index 15 = transparent key) — but **`DrawMazePiece` does not implement
it.** `DrawMazePiece` has only `replace` and `or`; index 15 in maze art
is either a literal cyan pixel or an OR mask, never a transparency key.

I measured the impact: **2,156 of 199,408 in-frame pixels (1.08%)** in
`mazedata.png` are currently marked fully transparent on this basis.
That is small but non-zero and will show as holes in walls.

**Action (M0):** emit the maze art as palette indices with no
transparency baked in, and let the blend mode decide (§8.2).

---

## 7. Movement, input, and state

### 7.1 Pose and stepping

```ts
// model/Pose.ts
export interface Pose { level: number; x: number; y: number; facing: Dir4 }

export const DELTA: Record<Dir4, {dx: number, dy: number}> = {
  0: {dx: 0, dy: -1},  // N
  1: {dx: 1, dy:  0},  // E
  2: {dx: 0, dy:  1},  // S
  3: {dx:-1, dy:  0},  // W
};
export const turnLeft  = (d: Dir4): Dir4 => ((d + 3) % 4) as Dir4;
export const turnRight = (d: Dir4): Dir4 => ((d + 1) % 4) as Dir4;
```

**The Y-axis sign is a per-game binding, not a constant.** Wizardry 6's
`+0x1ec` region-origin-Y and its `localY*8` indexing say nothing about
whether increasing Y is north or south, and the top-down renders in
`maze-level00.png` etc. are drawn with an arbitrary convention. Put
`yAxisDown: boolean` in `SemanticsFile` alongside `facingMap`, default
`true`, and let the M2 walk-test settle it.

### 7.2 Collision

```ts
export function canStep(level: CellQuery, sem: Semantics, pose: Pose, dir: Dir4): boolean {
  const w = level.wallAt(pose.x, pose.y, dir);
  if (sem.walls[w]?.blocksMovement !== false) return false;   // fail closed
  const {dx, dy} = DELTA[dir];
  return level.inBounds(pose.x + dx, pose.y + dy);
}
```

Two deliberate choices:

- **Fail closed.** An unmapped wall value blocks. With
  `maze-plane-semantics` unresolved, walking through geometry silently
  is a far worse failure mode than being stuck, because being stuck is
  immediately visible and diagnosable.
- **Check the edge, not the destination cell.** This is what makes the
  shared-edge model (§5.3) load-bearing, and it is what both source
  engines do.

Feature-based blocking (`FeatureMeaning.blocksMovement`) is checked on
the destination cell as a second test, for things like a closed
portcullis encoded as a feature rather than a wall.

### 7.3 Motion model: quantised, and why

**v1 is instantaneous grid stepping with no interpolation.** The pose
changes, the view list is rebuilt, the surface is recomposited. This is
what both original engines did, and it is not a shortcut:

The art *is* the projection. There is no piece for "half a step forward"
— depth 0.5 does not exist in the compose list. Smooth motion would
require either interpolating between two composited frames (a cross-fade,
which looks wrong and was never in these games) or synthesising
intermediate perspective (which needs art that doesn't exist). Turning
has the same problem: there is no 45° view.

If smooth motion is wanted later, the honest options are a short
cross-dissolve between the before/after surfaces, or a screen-space
slide/wipe. Both are presenter-level effects that do not touch the view
builder. Design note only; do not build in v1.

**Step throttling** is still needed so a held key doesn't advance 60
cells per second. `WalkerController` takes `{stepIntervalMs: 180,
turnIntervalMs: 150}` (tune against the originals) and consumes held-key
state on a timer.

### 7.4 Input

`@seer-project/engine`'s `InputManager` cannot be used (§3.3). Add to
`@seer-project/dungeon`:

```ts
// input/KeyState.ts — the primitive @seer-project/engine lacks
export class KeyState {
  constructor(target: HTMLElement | Window);
  isDown(code: string): boolean;
  consumePress(code: string): boolean;   // edge-triggered, one-shot
  destroy(): void;
}
```

```ts
// input/WalkerController.ts
export interface WalkerBindings {
  forward: string[]; back: string[];
  strafeLeft: string[]; strafeRight: string[];
  turnLeft: string[]; turnRight: string[];
  interact?: string[];
}
export const DEFAULT_BINDINGS: WalkerBindings = {
  forward:     ['KeyW', 'ArrowUp'],
  back:        ['KeyS', 'ArrowDown'],
  strafeLeft:  ['KeyQ'],
  strafeRight: ['KeyE'],
  turnLeft:    ['KeyA', 'ArrowLeft'],
  turnRight:   ['KeyD', 'ArrowRight'],
};
```

The controller is pure w.r.t. time: `update(dtMs, keyState) -> Pose | null`.
That makes step-throttling and binding logic unit-testable without a DOM.

**Note for `@seer-project/engine`:** `KeyState` is generically useful and its
absence is a real framework gap. Recommend landing it in
`@seer-project/dungeon` first (where it is needed and testable), and proposing
it for promotion to `@seer-project/engine` once it has settled — rather than
blocking the walker on an engine change.

### 7.5 Walker lifecycle

```ts
export interface WalkerOptions {
  container: HTMLElement;
  levels: DungeonLevelFile;
  slots: SlotTableFile;
  semantics: SemanticsFile;
  banks: Record<string, PieceBank>;
  palette: PaletteData;
  backend?: 'indexed' | 'spriteGraph';
  bindings?: Partial<WalkerBindings>;
  initialPose?: Pose;
  onEnterCell?(pose: Pose, cell: CellInfo): void;
  onBlocked?(pose: Pose, dir: Dir4, wallValue: number): void;
  onFeature?(pose: Pose, feature: FeatureMeaning): void;
}
export function createWalker(o: WalkerOptions): Promise<Walker>;
```

`Walker` exposes `pose` (get/set — set is the debug teleport),
`redraw()`, `surface` (the `IndexedSurface`, for tests and the viewer),
`destroy()`. It **does not** own the PixiJS `Application` — it takes a
`Container`. That keeps it composable with `@seer-project/engine`'s `Game` (a
host can `game.stage.addChild(walker.view)`) without depending on it.

---

## 8. Pipeline and tooling integration

### 8.1 Where this sits in the Stage 1/2/3 model

Per `docs/architecture-overview.md` §6, and the reality that
`runPipeline` has only two stages (§3.3):

- **Stage 1 (`exportGameData`)** — unchanged. Wizardry 6's maze geometry
  does not live in the executable; it lives in `scenario.dbs`.
- **Stage 2 (`buildAssets`)** — gains three new outputs
  (`dungeon/levels.json`, `dungeon/slots.json`, `dungeon/semantics.json`)
  from two existing extractors. No new stage, no `runPipeline` change.
- **Stage 3** — not involved.

Concretely for sorcery:

| Script | Change |
|---|---|
| `tools/wizardry6/decode-scenario-maze.ts` | Additionally emit `dungeon/levels.json` in the §5.2 schema (re-nest the existing per-level arrays under `planes`, add the header and `cellSpace`). Keep `maze-levels.json` as-is — it is the RE artefact and other things may read it. |
| `tools/wizardry6/decode-maze.ts` | Additionally emit `dungeon/slots.json` (§5.6) and switch the atlas PNG to indexed (§8.2). Keep `mazedata-composelist.json` — it is the RE artefact. |
| new `tools/wizardry6/dungeon-semantics.ts` | Emit `dungeon/semantics.json`. Small and mostly literal; it exists as a script rather than a checked-in JSON so the `confidence`/`source` fields stay next to a comment explaining them. |
| `tools/viewer/build-manifest.ts` | No change needed — `VIEWABLE_GROUPS = ['screens','sprites','maps']` (line 17) doesn't scan `dungeon/`, and shouldn't; those are data files, not viewable images. |

**A gap worth closing while here:** `tools/wizardry6/decode-dosega-maze.ts`
does not emit a compose list at all (grep for `composelist` returns
nothing), even though the DOS file's 366×5-byte sub-table is confirmed
byte-identical in size (`sorcery/docs/wizardry6/dosega/data-structure.md:1057-1058`).
Emitting it makes the DOS release a second, independent render target and
therefore a cross-platform oracle for the walker itself.

### 8.2 The indexed-art change

Per §6.5, RGBA art with baked transparency is the wrong intermediate.
Emit palette indices instead:

- **Problem:** `writeIndexedPNG`
  (`seer/packages/pipeline/src/io.ts:30-46`) hardcodes
  `A = (v === 0 ? 0 : 255)`, contradicting its own docblock ("A=255").
  For `replace`-blended maze pieces, index 0 is opaque black, so that
  alpha rule corrupts them.
- **Recommendation:** add an options parameter upstream —
  `writeIndexedPNG(path, indices, w, h, opts?: {transparentIndex?: number | null})`
  defaulting to `0` for backward compatibility, and pass `null` from the
  maze extractor. This is a small, additive, non-breaking framework
  change; propose it alongside the `@seer-project/dungeon` package.
- **Fallback if the framework change is unwelcome:** write the RGBA PNG
  from the dungeon extractor directly with a local helper. Do not work
  around it by post-processing alpha in the browser.
- The runtime reads the index out of the R channel. `PieceBank` decodes
  a bank's PNG once into a `Uint8Array` of indices plus per-frame rects
  from the atlas JSON, and never touches RGBA again until the palette
  expansion step.

### 8.3 Asset viewer: a "Walk this level" mode

**Recommendation: yes, and it is cheap — but as a separate page, not
inside `viewer.ts`.**

`tools/viewer/` is a single-purpose asset browser (287 lines, plain
Canvas 2D, `drawAsset`/`drawFullAtlas`/`drawSingleImage`). Bolting an
interactive walker into it would double its size and couple an
inspection tool to a runtime library.

Instead add `tools/walker/index.html` + `walker-harness.ts`, served by
the same Vite dev server (the viewer already works this way — README:38
says "visit `/tools/viewer/index.html` once `npm run dev` is running").
The harness:

- reads `platform` / `level` / `x` / `y` / `facing` from URL params, so a
  broken pose is a shareable link;
- loads `dungeon/*.json` + the atlas + palette via `loadAssets` from
  `@seer-project/core`;
- mounts `createWalker` with `backend: 'indexed'`;
- renders the debug minimap and slot inspector side by side with the
  view;
- shows `semantics.confidence` and `source` in a persistent banner.

Because the compositor produces an `IndexedSurface`, the harness can use
`CanvasPresenter` and skip PixiJS entirely — useful for isolating
"is the composite wrong?" from "is the Pixi upload wrong?".

**Additionally**, add a `--golden` mode to the Node side: a small script
that composites a given pose headlessly and writes a PNG. That gives the
test suite golden files and gives the RE work a way to A/B a proposed
`semantics.json` change against an emulator screenshot without opening a
browser.

---

## 9. Phased implementation plan

Each milestone has a single unambiguous done criterion. Milestones are
sized so that a failure is localised.

### M0 — Package skeleton and schema (no rendering)

- Create `packages/dungeon/` per §4.2 with `package.json`,
  `tsconfig.json`, `src/schema/*`, and a README carrying the pre-1.0
  banner.
- Write `schema/validate.ts` — runtime validators for all three files.
- Extend `decode-scenario-maze.ts` to emit `dungeon/levels.json`, and
  `decode-maze.ts` to emit `dungeon/slots.json` (`staticSlots` only) and
  indexed art (§8.2). Add `dungeon-semantics.ts`.
- Add `@seer-project/dungeon` to `sorcery/package.json` as
  `file:../seer/packages/dungeon`.

**Done when:** `npm run build-assets` produces all three `dungeon/*.json`
files, `validate.ts` accepts them, and `npm test` passes with validator
unit tests (including rejection cases for a bad `schemaVersion`).

### M1 — Static confirmed corridor, no movement, no level data

The single highest-value milestone, because it depends on **zero**
unresolved questions.

- Implement `IndexedSurface`, `PieceBank`, `composite`, `palette`,
  `CanvasPresenter`, `PixiPresenter`.
- Feed it exactly the 16 `PieceDraw`s + 6 icons of §2.7, via
  `slots.json`'s `staticSlots`.
- Build `tools/walker/index.html` to display it.

**Done when:** the browser shows the complete corridor frame described
in `data-structure.md` §4.4's verification block — "mortared stone side
walls (left drawn as the mirror of the right), stone ceiling, cobbled
floor receding to a vanishing point, and a dark doorway in the far
wall — plus the `CODE+0x64ee` sequence's six 16×16 status icons along
the top" — **and** a Node golden-file test asserts the composited
`Uint8Array` byte-for-byte against a checked-in reference. Both
presenters produce identical pixels.

*Risk note:* if M1's output is scrambled, the fault is in the blit,
mirror, or clip maths, and the search space is ~200 lines. Do not
proceed past M1 with a "close enough" render.

### M2 — Data-driven single frame from real level geometry

Requires resolving §10.1 (wall value → slot binding).

- Implement `CellQuery`, `RegionGridLevel`, `Pose`, `Direction`.
- Implement `buildViewList` and the keyed `slots` map.
- Render one frame for a configurable `(level, x, y, facing)`.

**Done when:** for a hand-picked pose in a level whose top-down render
(`maps/maze-level00.png`) shows an unambiguous corridor, the first-person
view shows a corridor consistent with it; **and** a sweep over all 14
levels × 50 sampled in-bounds poses × 4 facings (2,800 frames) completes
with zero exceptions, zero out-of-atlas frame references, and zero
out-of-surface writes (assert in `IndexedSurface.blit`).

### M3 — Movement, turning, collision

- `KeyState`, `WalkerController`, `canStep`, step throttling.
- Debug minimap with view cone; pose teleport; `semantics.confidence`
  banner.

**Done when:** a player can walk a full circuit of a corridor loop in
level 0 and return to the start pose; the minimap cone always matches
the rendered view; no pose ever leaves the map or passes through a cell
the top-down render shows as walled. **This milestone is also the
experiment that resolves `maze-plane-semantics`** — record the result in
`sorcery/docs/wizardry6/TODO.md` and update `semantics.json`.

### M4 — Features, doors, decorations

- Feature-code → piece binding, orientation gating, per-cell decorations.
- `onFeature` / `onEnterCell` callbacks.

**Done when:** doors and archways appear at cells whose `feature` plane
is non-zero, in positions consistent with the top-down renders; and the
16 feature codes each have either a bound piece or an explicit
`"unknown"` entry in `semantics.json` (no silent fallthrough).

### M5 — Generalise against Black Crypt

**This is the milestone that validates the whole design.** Expect
interface changes; that is the point.

Prerequisite work in `crawl` (neither exists today, §3.2):
1. A `bcdfs` geometry exporter emitting `dungeon/levels.json` with
   `cellSpace: {kind:'flat', width:64, height:64}` and
   `wallStorage: {kind:'bitflags', ...}`. `crawl/scripts/bclib/bcdfs.py`
   already walks the format with verified invariants; this is an output
   pass, not new RE.
2. A slot-table exporter transcribing the four descriptor tables
   (`crawl/docs/blackcrypt/amiga/data-structure.md:5037-5060`,
   `:4542-4553`) into `dungeon/slots.json`.

**Done when:** `@seer-project/dungeon` renders a walkable Black Crypt level with
**zero Wizardry-6-specific code paths** in the package (grep the package
for `wizardry`, `wallA`, `mazedata`, `region*64` — must be empty outside
`__tests__/` fixtures), and the W6 golden tests from M1/M2 still pass
unchanged.

### M6 — Polish and handoff

- `SpriteGraphRenderer` backend + the cross-check test (§6.4).
- Headless `--golden` compositor script (§8.3).
- Package README with a worked "plug in a new game" guide.
- Promote `KeyState` to `@seer-project/engine` if it has settled.

**Done when:** a developer can follow the README to wire a third game's
extracted assets to the walker without reading `@seer-project/dungeon`'s source.

### Sequencing summary

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M6
        │       ▲                    ▲
        │       └── blocked on §10.1 │
        └───────────────▶ M5 ────────┘   (M5 can start after M1 in parallel,
                                          given crawl-side exporter work)
```

M5's crawl-side prerequisites are independent of everything in M1-M4 and
can be scheduled in parallel by a second person.

---

## 10. Open questions

### 10.1 **BLOCKING for M2:** wall value → compose-list base index

`CODE+0x9b58` computes compose indices as `baseIndex + depth`, and
§4.7.1 confirms that `9b58`'s `baseIndex` arguments *are* the wall-type
codes returned by the evaluators (`0x9202`/`0x969a`/`0x9876`). But the
evaluators return "a wall-or-feature-derived code" after a 16-way
dispatch on `feature` and 14-way dispatches on the two overlay flags
(§4.7.2) — and **the mapping from a raw 2-bit wall value to a concrete
compose-list base index is not written down anywhere in the docs.**

Neither is the run-length question: §2.3's measurement shows runs are 3
*or* 4 records depending on piece kind, with no documented boundary
table.

**Recommended resolution, in order of preference:**

1. **Disassemble `CODE+0x9202`'s return paths and `CODE+0x9b58`'s
   argument use directly** (the binary is present at
   `data/wizardry6/amiga/Bane`, CODE base = file offset `0x28`). This is
   a bounded, well-scoped task of exactly the kind the `re-codebreaker`
   skill exists for, and the same `d16(PC)` displacement-scan technique
   that solved §4.4 applies. **This is the recommended path** and should
   be scheduled to land between M1 and M2.
2. **Derive it empirically.** With M1's compositor working, brute-force:
   for each candidate base index, render and compare against emulator
   screenshots of known poses. Slower, needs an emulator capture set, but
   requires no disassembly.
3. **Hand-author a plausible table** and iterate visually. Fastest to a
   moving picture, but produces a walker that looks right and is wrong,
   which is the worst outcome for a project whose purpose is
   verification.

**Do not** let this block M1 — M1 is deliberately designed to need none
of it.

### 10.2 `maze-plane-semantics` — **do not block**

Recommendation: **build with the documented placeholder and let M3
resolve it.** Justification:

- §5.4's design makes every affected value a data-file entry. Changing
  the answer is a JSON edit.
- The walker is a *better* oracle than static analysis: with the wrong
  `planeDirs`, walls appear on the wrong side of a corridor, which is
  immediately visible; with the wrong wall values, you either walk
  through walls or get stuck in open corridors, both trivially
  diagnosable against the existing top-down renders.
- Blocking would idle M0-M1, which need none of it.

Concretely: ship `planeDirs: [0, 3]` (plane A = north, plane B = west —
the most common convention for a 2-plane shared-edge encoding, and the
one that makes `wallAt` for facings 2/3 read the neighbour's plane in the
+Y/+X direction), flagged as a placeholder in `semantics.json`'s
`source` field, and record the M3 outcome in `sorcery/docs/wizardry6/TODO.md`.

### 10.3 `scenario-section3-fields` — out of scope, no dependency

Section 3's 144-entry per-level entity table is the natural source for
monster/NPC placement, and `DrawMazePiece`'s call graph already shows
where those tokens get drawn (`CODE+0xaffa`-`0xb1cc`, via the `.PIC` cel
compositor rather than `DrawMazePiece`, §4.6). But v1 renders no
entities, so this blocks nothing. `DungeonLevelData.entities?: unknown`
(§5.2) reserves the slot. Sequence it after M4, independently.

### 10.4 Undecided, with recommended defaults

| Question | Recommended default | Revisit at |
|---|---|---|
| Y-axis sign (does +Y mean north or south?) | `yAxisDown: true` in `semantics.json`; settle empirically | M3 |
| Does W6's outer 4-step depth loop mean 4 visible depths, or 3 + a backdrop? | Treat `depthCount: 4` with `frontWallMaxDepth: 3`, matching Black Crypt's confirmed gating exactly | M2 |
| Are the two `flagP`/`flagQ` overlay planes needed for rendering? | No — they drive per-level scripted 14-way dispatches (§4.7.2). Expose as planes; bind nothing | M4 |
| Should the walker own the PixiJS `Application`? | No — take a `Container` (§7.5) | — |
| Should `KeyState` live in `@seer-project/engine`? | Eventually yes; ship in `@seer-project/dungeon` first | M6 |
| One `slots.json` per platform, or one shared with per-platform art refs? | Per platform. W6's DOS directory format differs (5-byte records, no offset field, `dosega/data-structure.md:3.2`) even though the art is identical; keeping them separate avoids a conditional | — |
| How does the host game replace the view (combat, menus)? | Walker renders into a `Container`; host adds siblings above it and calls `walker.pause()` | M6 |

---

## 11. Risks and unknowns

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **§10.1 is harder than expected** — the wall-code→slot dispatch resists disassembly the way `DrawMazePiece`'s consumer did for three sessions | Medium | Blocks M2-M4 | M1 is explicitly independent of it. Fallback path 2 in §10.1 (empirical derivation against emulator captures) is slow but always terminates. Escalate to `re-codebreaker` early rather than grinding. |
| 2 | **Premature generalisation from n=1** — interfaces fit W6 and fight Black Crypt at M5 | Medium | Rework of `view/` and `schema/` | §4.3's sequencing guard: pre-1.0 banner, no stability promise until M5. §3.2's difference table is a pre-committed list of the pressures M5 will apply — check each design decision against it *before* M5, not during. |
| 3 | **crawl's prerequisite exporters don't get built**, so M5 never runs and the "generic" claim is never tested | Medium | The package is generic in name only | Schedule the crawl-side exporters as M5 prerequisites with their own owner. `bcdfs.py` already parses the format with verified invariants — this is an output pass, not RE. If it slips, at minimum write the Black Crypt `slots.json` **by hand** from the docs' descriptor tables (`:5037-5060`, `:4542-4553`) and render one static frame: that alone exercises the schema. |
| 4 | **A third target game breaks the model** — e.g. EOB's 8×8-block view cone, or a game with 6 lateral columns, or non-square cells | Low-Medium | Schema change | §5.5 keeps `PieceDraw` a discriminated shape and §5.2 keeps `CellSpace` a union. EOB is already scoped as a future `{kind:'blockGrid'}` variant. Do not build it in v1. |
| 5 | **Blend-mode fidelity is worse than expected** — `or` produces visibly wrong colours because the compositing order in the real engine differs from ours | Low | Visual mismatch | M1's golden test catches it immediately against a known-correct 16-call sequence. If it fails, the fault is ordering, and the fix is in `sort.ts`. |
| 6 | **PixiJS v8 `BufferImageSource` re-upload is slow or awkward** | Low | Presenter rewrite | The view changes only on pose change (§7.3), so even a slow path is fine. `CanvasPresenter` is an always-available fallback, and the compositor is presenter-agnostic by design. |
| 7 | **The existing extracted art has more baked-in errors than the index-15 alpha issue** (§6.5) | Low-Medium | Wrong pixels, hard to attribute | M1's golden test is a full-frame byte comparison against the disassembly-sourced recipe — it catches art-level errors, not just compositor errors. Fix at the extractor, never in the renderer. |
| 8 | **`semantics.json` guesses ossify** — the placeholder gets treated as fact | Medium | Wrong walker presented as verification | The `confidence` field is rendered in the debug banner and must be checked in every screenshot shared as evidence. Treat any doc claim sourced from a `confidence: 'rendered'` walker render as `rendered`, never `confirmed`. |
| 9 | **`@seer-project/*` framework churn** — no semver, no release process (`seer/docs/framework-plan.md` §10 is the one unimplemented item) | Low | Breakage across three linked repos | Consumers use `file:` links, so breakage is immediate and local rather than latent. Keep `@seer-project/dungeon`'s dependency on `@seer-project/core` to `BinaryReader` and `loadAssets` only — both are stable and trivially replaceable. |
| 10 | **Scope creep into combat/entities** because the walker is the first thing that looks like a game | High | M5 never happens | The out-of-scope table in §1.1 names the hook for each deferred system. Point at it. |

---

## 12. Appendix: file index

Sources this plan was built from, for anyone verifying it.

**This project:**
- `sorcery/docs/wizardry6/amiga/data-structure.md` §2 (`.PIC`), §4.1-4.7 (dungeon view), §9 (confidence)
- `sorcery/docs/wizardry6/amiga/investigations/mazedata.md` (full trace, sessions 2-4 + escalation)
- `sorcery/docs/wizardry6/TODO.md` (`maze-plane-semantics`, `scenario-section3-fields`)
- `docs/architecture-overview.md` §6 (pipeline), §8 (aspirational runtime)
- `docs/boilerplate-guide.md` (what's framework vs. template)
- `tools/wizardry6/decode-maze.ts`, `decode-scenario-maze.ts`, `pic-format.ts`
- `tools/shared/amiga-planar.ts`, `tools/viewer/{shared,build-manifest,viewer}.ts`
- `src/{main,game-id}.ts`, `src/data/{GameData,AssetLoader}.ts`
- `public/assets/wizardry6/amiga/maps/{mazedata.json,mazedata-composelist.json,maze-levels.json}`
- `data/wizardry6/amiga/Bane` (CODE hunk base = file offset `0x28`)

**Framework** (`/home/ctemplet/Development/seer/`):
- `packages/engine/src/{index,Game,Camera,InputManager,DisplayMode,pixi-helpers}.ts`
- `packages/core/src/{index,assets,binary,binary-reader}.ts`
- `packages/pipeline/src/{index,config,pipeline,io}.ts`
- `packages/create-seer/templates/` (framework-standard project shape)
- `package.json` (npm workspaces), `docs/framework-plan.md`

**Prior art** (`/home/ctemplet/Development/middilgard/`):
- `README.md`, `PLAN.md`, `docs/architecture-overview.md`
- `src/data/scene-compositor.ts`, `src/assets/formats/bscene.ts`
- `src/engine/Game.ts`, `src/map/TileMap.ts`, `src/engine/MovementSystem.ts`
- `src/assets/formats/{scen,mmap}.ts`, `src/data/GameData.ts`
- `docs/wime/amiga/bscene-format.md`, `docs/legend/dosvga/engine.md`

**Generalisation target** (`/home/ctemplet/Development/crawl/`):
- `docs/blackcrypt/amiga/data-structure.md:4964-5516` (3D viewport render loop)
- `docs/blackcrypt/amiga/data-structure.md:6243-6773` (`bcdfs` level format)
- `docs/eotb/amiga/eotb-vmp-spec.md` (EOB block-index view cone)
- `AGENTS.md` (tileset selection, wall-piece vocabulary, palette ramps)
- `scripts/bclib/{bcdfs,bcdfxyz,atlas,paths}.py`
- `public/assets/blackcrypt/amiga/textures/dungeon-bcdfx.json`
