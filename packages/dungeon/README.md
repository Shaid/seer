# `@seer-project/dungeon`

A generic first-person grid-dungeon walker — the schema, raster and
presenter layers shared by every game-specific dungeon renderer in Seer.
Black Crypt is the driving consumer; Wizardry 6 validates the
generalisation later. See
[`docs/walker.md`](https://github.com/Shaid/seer/blob/main/docs/walker.md)
for the full design rationale and milestone sequence.

> **Pre-1.0: interfaces change without notice** until the Black Crypt AND
> Wizardry 6 consumers have both driven the design. Do not build against
> this package expecting API stability yet. Project-wide detail:
> <https://seer.shaid.net/start-here/project-status/>.

## A note on the source comments

Comments throughout `src/` cite paths like `docs/blackcrypt/amiga/data-structure.md`.
Those live in the **driving consumer's** repository, not this package — this is a
generic walker, but every behaviour in it was derived from a specific game's
disassembly, and the citations record which finding each rule came from. They
are provenance, not links you can follow from an installed copy.

## Status

- **M0** — package skeleton, the three walker data-file schemas
  (`levels.json`, `slots.json`, `semantics.json`) and hand-written runtime
  validators. No game logic, no rendering.
- **M1** — static-corridor raster/render layers (`IndexedSurface`,
  `PieceBank`, `composite`, `palette`, `PixiPresenter`, `CanvasPresenter`),
  proven against Black Crypt's fully-numeric front-wall/side-wall
  placement tables. No movement, no level data, no input.

Everything else described in the walker plan (`model/`, `view/`, `input/`,
`automap/`, `actors/`, `debug/`) is later milestones and does not exist yet.

## The three-file contract

A game provides three config files per platform, each with a
`schemaVersion` the loader hard-fails on if unrecognised:

- **`levels.json`** (`DungeonLevelFile`) — the map data: cell space, wall
  storage convention, load units, entity records.
- **`slots.json`** (`SlotTableFile`) — where each depth/lateral "slot" of
  the first-person view is drawn from, in a named piece bank's atlas.
- **`semantics.json`** (`SemanticsFile`) — what wall/feature values *mean*
  (blocks movement, blocks sight, which piece kind), with a
  `confidence: 'confirmed' | 'rendered' | 'hypothesis'` field per entry.

Import types and validators from `@seer-project/dungeon/schema` — that subpath is
zero-dependency (no PixiJS) so Node-side exporters can use it without
pulling in a browser rendering stack.

## Quickstart

```ts
import { validateSlotTableFile } from '@seer-project/dungeon/schema';
import { PieceBank, IndexedSurface, compositeSlotTable } from '@seer-project/dungeon';

const slots = validateSlotTableFile(await (await fetch('/assets/<game>/<platform>/dungeon/slots.json')).json());
// decode the atlas PNG to RGBA yourself (pngjs in Node, canvas in the
// browser — PieceBank has no PNG/DOM dependency), then:
const bank = PieceBank.fromRGBA(rgba, atlasWidth, atlasHeight, atlasMeta);

const surface = new IndexedSurface(slots.surface.width, slots.surface.height);
compositeSlotTable(surface, { [slots.banks[0].id]: bank }, slots);
// hand `surface` + `bank.palette` to a CanvasPresenter or PixiPresenter.
```

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
