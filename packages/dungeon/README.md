# `@seer-project/dungeon`

A generic first-person grid-dungeon walker — the schema, raster and
presenter layers shared by every game-specific dungeon renderer in Seer.
Black Crypt is the driving consumer; Wizardry 6 validates the
generalisation later. See `/home/ctemplet/Development/crawl/docs/blackcrypt/walker-plan.md`
for the full design rationale and milestone sequence.

> **Pre-1.0: interfaces change without notice** until the Black Crypt AND
> Wizardry 6 consumers have both driven the design. Do not build against
> this package expecting API stability yet.

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
