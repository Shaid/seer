# `@seer/engine-3d` — scoping proposal

**Status: proposal, not started.** This is a scoping document, not an implementation
plan with committed dates. It exists so that if/when the work happens, it starts
from a real assessment of what's generic vs. game-specific, not a guess.

## Why this might become a package

`@seer/engine-2d` (the renamed `@seer/engine`) is a PixiJS-based 2D runtime —
camera, input, tilemap/sprite rendering. It fits every seer-family game so far
because they're all 2D: sprite-and-tile games on Amiga/DOS/IIGS hardware.

`~/Development/hunter` is different. Several of the games it targets — Hunter,
Carrier Command, and (per `data/explore/`) candidates like Midwinter, Frontier:
Elite II, Zeewolf, Virus, Guardian, ArmourGeddon, Wings, Gunship 2000 — use
**real 3D polygon models**, not sprites. Hunter already has a working,
non-trivial Three.js viewer for this
(`~/Development/hunter/tools/viewer/index-3d.html`, 475 lines) that renders
models from three different games (Hunter, Carrier Command, Epic) through one
shared rendering path. That's real evidence a generic 3D engine package is
viable, not just a hunch.

## What the prototype already gets right (the generic core)

Reading `index-3d.html` in full, the following has **no game-specific
assumptions** and is a strong basis for `@seer/engine-3d`'s core:

- **Scene/camera/lighting setup** (`initScene()`) — perspective camera,
  ambient + two directional lights, a ground grid, `OrbitControls` wired to
  the renderer's DOM element. Generic to any polygon-model viewer.
- **A common in-memory model shape**: `{ id, name, verts: [x,y,z][], edges:
  [i,j][], faces: [{verts: number[], fill: number}], type_hi, stats }`. All
  three games' loaders normalize into this same shape before rendering,
  including Epic's completely different source (glTF via `GLTFLoader`,
  reverse-derived back into `verts`/`faces` — see `glbToObject()`).
- **Mesh construction from that shape** (`buildMesh()`) — per-face
  `BufferGeometry` with fan-triangulation from the first vertex (correct for
  convex/simple polygons, which these are), vertex colors, and three
  alternate rendering modes (faces / wireframe / points) plus an edge-set
  dedup for the wireframe pass (handles both declared `edges` and
  faces-derived edges when a format doesn't ship an edge list).
- **Auto-fit camera framing** (`selectObject()`'s bounding-sphere + distance
  calculation) — generic to any model's vertex bounds.
- **Color-mode abstraction** (`getColor()`) — face-index / object-index /
  height-gradient modes are pure functions of geometry, not game data. Only
  the fourth mode ("palette") needs a per-game color source.

## What's genuinely game-specific (must NOT be generalized into the core)

- **The "palette" color mode's fill-word decode**
  (`fillToColor()`/`PALETTE` array): bits 11-8 of a 16-bit fill word are a
  4-bit index into a **16-color hardware palette extracted from Hunter's own
  IFF images**, bits 3-0 are a vertices-per-face count specific to Hunter's
  `OB` format. Carrier Command and Epic reuse this same decode today by
  accident of sharing the viewer file, not because their fill words mean the
  same thing — this should become an explicit per-game plugin point, not
  a shared default.
- **The parsers themselves.** Confirmed by reading the actual tools:
  - Hunter's `OB` format (`tools/hunter/ob-format.mjs`, driven by
    `parse-3d-format.mjs`): region-scanned polygons with "rings" (open vs.
    closed edge loops) and a fill/line polygon distinction.
  - Epic's `.3D`/`.3DL` format (`tools/epic/epic_3d_to_obj.py`,
    documented in `docs/explore/Epic/epic-3d-format.md`): a face-record
    list (`edges`, `colour`, `index[n+1]`) terminated by a sentinel, with
    the **vertex count not recoverable from the file at all** — it's a
    hand-maintained lookup table (`KNOWN_COUNTS`) keyed by filename.
  - These two formats share almost nothing at the byte level. There is no
    "generic Amiga 3D object format" to extract — only the *destination*
    shape (verts/edges/faces) that both converge on.
- **The game/model selector** — currently a hardcoded `<option>` list
  (`hunter`/`carrier-command`/`epic`), same anti-pattern already fixed in the
  2D scaffold viewer (see `docs/viewer.md`). A real package should solve this
  the same way: a manifest emitted by the build step, not hardcoded HTML.
- **Two incompatible source pipelines feeding the same viewer**: Hunter and
  Carrier Command ship simple JSON manifests directly; Epic ships actual
  `.glb` files (produced by some other export step not examined here) that
  get loaded via `GLTFLoader` and *reduced back down* to the same
  vert/face shape rather than rendered as native glTF meshes. A real package
  needs to decide whether to standardize on one input shape (probably the
  simple JSON one, since it's lighter and doesn't require round-tripping
  through glTF) or support both natively.

## Proposed package shape (if/when this is built)

```
@seer/engine-3d/
  src/
    scene.ts       # initScene(), animate loop, resize handling — generic
    model.ts       # Model3D type (the verts/edges/faces shape), buildMesh()
    camera-fit.ts  # auto-fit-to-bounds framing
    color-modes.ts # face/object/height color modes (generic);
                    # palette mode takes an injected per-game decode fn,
                    # not a hardcoded table
    index.ts
  package.json     # peerDependency: three
```

Mirrors `@seer/engine-2d`'s shape: a thin, opinionated runtime core plus an
explicit escape hatch (the injected palette decoder) for the one piece that's
legitimately per-game, the same way `@seer/engine-2d` leaves `Game.ts` as an
edit-me template rather than a locked-down class.

## What this would take, roughly

1. Extract `index-3d.html`'s inline script into typed, tested modules per the
   shape above — currently zero types, zero tests, no build step at all.
   This is the bulk of the real effort: turning a working prototype into
   something with the same rigor as the rest of `packages/*`.
2. Define the injection point for the palette/fill-word decode (a function
   parameter or config object), rather than assuming Hunter's 4-bit/16-color
   scheme applies elsewhere.
3. Decide the standard input JSON shape and write one canonical loader for
   it; treat glTF-sourced input (Epic's case) as an adapter into that same
   shape, not a second first-class path through the renderer.
4. Add the data-driven model/game selector (reuse the pattern from
   `docs/viewer.md`'s 2D selector work rather than re-solving it).
5. Tests: at minimum, `buildMesh()` against synthetic vert/face fixtures
   (triangulation correctness, edge dedup), and the auto-fit camera math.
   Real GPU rendering isn't practically unit-testable — that stays a manual
   "does it look right" check, same as `@seer/engine-2d`'s current state.

## What this does NOT require

- No changes to `@seer/engine-2d` — the two packages don't interact. A
  project could depend on both if it has both 2D and 3D content (plausible
  for a game with an overworld sprite view and a 3D combat view), or either
  alone.
- No changes to any existing seer-family repo. `hunter`'s current
  `index-3d.html` keeps working unmodified whether or not this package is
  ever built; this is additive, not a migration forced on anyone.

## Recommendation

Worth doing once there's a second real consumer beyond Hunter's own
prototype — Carrier Command and Epic already sort of count, but they're
riding on the same one file rather than an independent integration. If
Frontier or another `data/explore/` candidate gets a real 3D extraction
pipeline built, that's the natural trigger to extract this properly rather
than growing `index-3d.html` further in place.
