/**
 * `tileForCell` cross-checked against five real entity records pulled
 * straight from `data/blackcrypt/amiga/bcdfs` (via `bclib.bcdfs.load_world`)
 * and their expected automap tile, computed independently by running the
 * *actual* `scripts/automap_tiles.py` (`explore()` + `tiles_of()`) against
 * that same raw data — the ground-truth oracle the walker plan names. Every
 * one of these five matched on the first attempt, which is strong
 * confirmation `dispatchOne`/`tileForCell` is a faithful port of
 * `_dispatch`/`reveal_around`, not just something that compiles.
 *
 * `buildRecord` mirrors `scripts/export_dungeon_levels.py`'s
 * `build_entity_record` field mapping exactly, so these fixtures are the
 * same shape a real `dungeon/levels.json` would actually contain.
 *
 * `tileForCell` reads entities via `CellQuery.entitiesAt` (chain-walking
 * itself lives there now, shared with any other consumer) — `OneCellWorld`
 * below just returns a fixed list for whichever single cell the test cares
 * about.
 */
import { describe, expect, it } from 'vitest';
import { tileForCell, AUTOMAP_TILE_NAMES } from '../automap/AutomapRenderer.ts';
import type { EntityRecord } from '../schema/level.ts';
import type { CellQuery } from '../model/CellQuery.ts';
import type { Dir4 } from '../model/Pose.ts';

function u16(raw: number[], off: number): number {
  return ((raw[off] ?? 0) << 8) | (raw[off + 1] ?? 0);
}

/** Mirrors `scripts/export_dungeon_levels.py`'s `build_entity_record`. */
function buildRecord(raw: number[]): EntityRecord {
  const monster = (raw[0]! & 0x80) !== 0;
  return {
    type: monster ? 0x80 : raw[5]!,
    gfx: monster ? raw[1]! : u16(raw, 0x00),
    wallMask: raw[4]!,
    slotNibble: raw[6]!,
    chainNext: u16(raw, 0x12),
    flags: u16(raw, 0x0e),
    raw,
  };
}

/** A single-cell world: `type` plane is the non-wall/non-dark baseline (0), `entitiesAt` returns a fixed list for that one cell. */
class OneCellWorld implements CellQuery {
  private readonly records: EntityRecord[];
  constructor(records: EntityRecord[] = []) {
    this.records = records;
  }
  inBounds(): boolean {
    return true;
  }
  wallAt(): boolean {
    return false;
  }
  planeAt(name: string): number {
    if (name === 'type') return 0;
    throw new Error(`unknown plane ${name}`);
  }
  entitiesAt(): EntityRecord[] {
    return this.records;
  }
}

const X = 0;
const Y = 0;

function cellWithRecord(raw: number[]) {
  const level = new OneCellWorld([buildRecord(raw)]);
  return tileForCell(level, X, Y);
}

describe('tileForCell baseline (no entity chain)', () => {
  it('a plain wall square (type bit 0) is tile 0, regardless of entities', () => {
    const level: CellQuery = {
      inBounds: () => true,
      wallAt: () => false,
      planeAt: (name) => (name === 'type' ? 1 : 0),
      entitiesAt: () => [],
    };
    expect(tileForCell(level, X, Y)).toBe(0);
  });

  it('a darkness square (type bit 1) is tile 16', () => {
    const level: CellQuery = {
      inBounds: () => true,
      wallAt: () => false,
      planeAt: (name) => (name === 'type' ? 2 : 0),
      entitiesAt: () => [],
    };
    expect(tileForCell(level, X, Y)).toBe(16);
  });

  it('a plain floor square with no entities is tile 15', () => {
    const level = new OneCellWorld([]);
    expect(tileForCell(level, X, Y)).toBe(15);
  });

  it('out-of-bounds cells are treated as wall (tile 0)', () => {
    const level: CellQuery = { inBounds: () => false, wallAt: () => false, planeAt: () => 0, entitiesAt: () => [] };
    expect(tileForCell(level, X, Y)).toBe(0);
  });
});

describe('tileForCell against real bcdfs entity records', () => {
  it('a closed vertical door (map 1, (row=3,col=49), slot 17) -> tile 6', () => {
    const raw = [0, 54, 0, 0, 80, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0];
    expect(cellWithRecord(raw)).toBe(6);
    expect(AUTOMAP_TILE_NAMES[6]).toBe('door closed (vertical)');
  });

  it('a spinner (map 1, (row=1,col=10), slot 2, kind 4) -> tile 22', () => {
    const raw = [0, 30, 0, 0, 15, 18, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0];
    expect(cellWithRecord(raw)).toBe(22);
    expect(AUTOMAP_TILE_NAMES[22]).toBe('spinner');
  });

  it('a fountain (map 1, (row=13,col=34), slot 91) -> tile 12', () => {
    const raw = [0, 69, 0, 0, 0, 31, 0, 255, 0, 158, 0, 0, 0, 0, 0, 0, 0, 0, 0, 92];
    expect(cellWithRecord(raw)).toBe(12);
    expect(AUTOMAP_TILE_NAMES[12]).toBe('fountain');
  });

  it('a glyph (map 1, (row=7,col=6), slot 33, kind 3) -> tile 11', () => {
    const raw = [0, 60, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 3, 0, 1, 0, 2, 0, 0];
    expect(cellWithRecord(raw)).toBe(11);
    expect(AUTOMAP_TILE_NAMES[11]).toBe('glyph');
  });

  it('a pillar (map 1, (row=2,col=35), slot 7) -> tile 7', () => {
    const raw = [0, 56, 0, 0, 0, 23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8];
    expect(cellWithRecord(raw)).toBe(7);
    expect(AUTOMAP_TILE_NAMES[7]).toBe('pillar');
  });
});

describe('tileForCell over multiple chained entities', () => {
  it('applies each entity in the order entitiesAt returns them', () => {
    // A pillar record alone -> tile 7; a trailing floor-plate record after
    // it (type 0x1E, kind gate satisfied, +0x0E==0) overrides to tile 13 --
    // proving later entities in the chain can still override earlier ones,
    // exactly like the original chain-walk did.
    const pillarRaw = [0, 56, 0, 0, 0, 0x17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const platesRaw = [0, 40, 0, 0, 0, 0x1e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const level = new OneCellWorld([buildRecord(pillarRaw), buildRecord(platesRaw)]);
    expect(tileForCell(level, X, Y)).toBe(13);
  });

  it('an empty entitiesAt() list leaves the wall/darkness/floor baseline untouched', () => {
    const level = new OneCellWorld([]);
    expect(tileForCell(level, X, Y)).toBe(15);
  });

  it('a facing constant is exactly 17 + Dir4', () => {
    const facings: Dir4[] = [0, 1, 2, 3];
    for (const f of facings) expect(AUTOMAP_TILE_NAMES[17 + f]).toMatch(/^party facing/);
  });
});
