/**
 * Maps a cell to the automap tile Black Crypt itself would show for it, and
 * composites visited cells into an `IndexedSurface` using the game's own
 * 24-tile automap atlas (`public/assets/blackcrypt/amiga/sprites/automap.{png,json}`,
 * frames `tile00`..`tile23`) — reusing the exact same `PieceBank`/
 * `IndexedSurface`/blit code the main first-person view uses, per the walker
 * plan's automap section ("reuses the exact same blit/palette code as the
 * main view").
 *
 * `tileForCell` is a faithful, bounded port of `scripts/automap_tiles.py`'s
 * `reveal_around`/`_dispatch` (S_1 `+0x0382A`/`+0x03B1A`) — the ground-truth
 * oracle named in the walker plan. It reads the exact same source data
 * (the `type` plane's wall/darkness bits, and the same-square entity chain)
 * `automap_tiles.py` does, so a hand cross-check against that script's ASCII
 * map output for the same cell is a meaningful, independent verification
 * (see `__tests__/AutomapRenderer.test.ts`).
 *
 * Entity-chain walking itself is `CellQuery.entitiesAt` — this module
 * doesn't walk `chainNext`/plane lookups on its own, keeping `CellQuery` the
 * single read path per the walker plan's automap section ("fog-of-war is a
 * decorator around it, not a fork of it").
 *
 * **Deliberately not ported**: `reveal_walls`'s cross-cell side effect
 * (propagating a wall/illusionary-wall reveal onto a *neighbouring* square
 * the instant a teleport/stairs/door/panel feature is discovered elsewhere).
 * That's a dynamic, stateful reveal mechanic, not a pure per-cell query, and
 * is out of scope until prop placement/interaction lands (walker plan's "one
 * genuine gap", scheduled before M5). Omitting it only affects display
 * embellishment on illusionary-wall-adjacent squares — it never affects
 * collision (`canStep` never reads automap tiles) or visited-tracking
 * (`AutomapState`).
 *
 * Hardcodes Black Crypt's own `type` plane name the same way `FlatGridLevel`
 * hardcodes `wallFlags` — a future generalisation pass (M6) would
 * parameterise it, the same way `WallStorage.plane` already is.
 */
import type { CellQuery } from '../model/CellQuery.js';
import type { EntityRecord } from '../schema/level.js';
import type { PieceBank } from '../raster/PieceBank.js';
import type { IndexedSurface } from '../raster/IndexedSurface.js';
import type { Dir4 } from '../model/Pose.js';

export const AUTOMAP_TILE_COUNT = 24;
export const AUTOMAP_TILE_SIZE = 8;

/** Mirrors `scripts/automap_tiles.py`'s `TILE_NAMES`, for debug/label use. */
export const AUTOMAP_TILE_NAMES: Record<number, string> = {
  0: 'wall',
  1: 'stairs up',
  2: 'stairs down',
  3: 'door open (horizontal)',
  4: 'door closed (horizontal)',
  5: 'door open (vertical)',
  6: 'door closed (vertical)',
  7: 'pillar',
  8: 'floor pit',
  9: 'teleport',
  10: 'magic field',
  11: 'glyph',
  12: 'fountain',
  13: 'floor plate',
  14: 'trap (visible)',
  15: 'floor',
  16: 'darkness',
  17: 'party facing N',
  18: 'party facing E',
  19: 'party facing S',
  20: 'party facing W',
  21: 'illusionary wall',
  22: 'spinner',
  23: 'special panel',
};

function u16(raw: number[] | undefined, off: number): number {
  const hi = raw?.[off] ?? 0;
  const lo = raw?.[off + 1] ?? 0;
  return ((hi << 8) | lo) & 0xffff;
}

/** One record's contribution to the tile, per `automap_tiles.py`'s `_dispatch` (S_1 `+0x03B1A`). */
function dispatchOne(rec: EntityRecord, tile: number): number {
  const raw = rec.raw;
  const gate = u16(raw, 0x0a) === 0; // SEQ on word +0x0A, S_1 +0x03936
  const t = rec.type;

  if (t === 0x10 && gate) {
    const kind = u16(raw, 0x0c);
    if (kind === 1)
      tile = 21; // illusionary wall
    else if (kind === 2)
      tile = 10; // magic field
    else if (kind === 3) tile = 11; // glyph
  } else if (t === 0x11 && tile === 15) {
    const vertical = ((raw?.[4] ?? 0) & 0x10) !== 0; // +0x04 bit 4 = N wall -> E-W corridor
    const isOpen = ((raw?.[0x0f] ?? 0) & 0x01) !== 0;
    tile = vertical ? (isOpen ? 5 : 6) : isOpen ? 3 : 4;
  } else if (t === 0x12 && gate) {
    const kind = u16(raw, 0x10);
    const KIND_TILE = [9, 9, 1, 2, 22];
    if (kind < KIND_TILE.length) tile = KIND_TILE[kind]!;
  } else if (t === 0x14) {
    if (u16(raw, 0x10) === 0 && gate) tile = 8; // floor pit
  } else if (t === 0x17) {
    if (gate) tile = 7; // pillar
  } else if (t === 0x1e) {
    if ((raw?.[7] ?? 0) === 0 && gate) {
      if (u16(raw, 0x0e) === 0)
        tile = 13; // floor plate
      else if (u16(raw, 0x0c) !== 0) tile = 14; // visible trap
    }
  } else if (t === 0x1f) {
    tile = u16(raw, 0x0e) === 0 ? 12 : 23; // fountain / special panel
  }
  return tile;
}

/**
 * The automap tile index (0-23) `ShowAutomap` would draw for cell `(x, y)`
 * — see the module doc comment for exactly what is and isn't ported from
 * `automap_tiles.py`. Entities are read via `level.entitiesAt(x, y)`, so
 * this needs no entity-lookup/unit-id plumbing of its own.
 */
export function tileForCell(level: CellQuery, x: number, y: number): number {
  if (!level.inBounds(x, y)) return 0;

  const type = level.planeAt('type', x, y);
  let tile = 15; // floor baseline
  if (type & 1) tile = 0; // square type bit 0: solid wall
  if (type & 2) tile = 16; // square type bit 1: darkness
  if (tile === 0) return tile; // a solid wall square is never feature-dispatched

  for (const rec of level.entitiesAt(x, y)) {
    if (((rec.gfx ?? 0) & 0x7fff) !== 0) tile = dispatchOne(rec, tile);
  }
  return tile;
}

export interface AutomapRenderOptions {
  /** Draw a `17 + facing` party-facing tile at this cell instead of its computed tile, matching the game's own automap. */
  party?: { x: number; y: number; facing: Dir4 };
}

/**
 * Composites every cell in `visitedCells` into `surface`, using `bank`'s
 * `tile00`..`tile23` frames. `origin` is the north-west corner cell (minimum
 * x, **maximum** y — Y increases northward) shown at `surface`'s `(0, 0)`;
 * a cell's screen row grows as `y` shrinks, since a raster surface's row 0
 * is its top edge but this world's `y` increases north.
 */
export function renderAutomap(
  surface: IndexedSurface,
  bank: PieceBank,
  level: CellQuery,
  visitedCells: Array<{ x: number; y: number }>,
  origin: { x: number; y: number },
  options: AutomapRenderOptions = {},
): void {
  for (const { x, y } of visitedCells) {
    let tile = tileForCell(level, x, y);
    if (options.party && options.party.x === x && options.party.y === y) {
      tile = 17 + options.party.facing;
    }
    const frame = `tile${String(tile).padStart(2, '0')}`;
    if (!bank.hasFrame(frame)) continue;
    const rect = bank.frame(frame);
    const destX = (x - origin.x) * AUTOMAP_TILE_SIZE;
    const destY = (origin.y - y) * AUTOMAP_TILE_SIZE;
    if (destX < 0 || destY < 0 || destX >= surface.width || destY >= surface.height) continue;
    surface.blit(bank.source(), rect.x, rect.y, rect.w, rect.h, destX, destY, false, 'replace');
  }
}
