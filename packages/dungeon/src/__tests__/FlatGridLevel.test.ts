import { describe, expect, it } from 'vitest';
import { FlatGridLevel } from '../model/FlatGridLevel.ts';
import type { DungeonLevelFile } from '../schema/level.ts';

function makeFile(wallFlags: number[], width = 3, height = 3): DungeonLevelFile {
  return {
    schemaVersion: 1,
    game: 'test',
    platform: 'test',
    cellSpace: { kind: 'flat', width, height },
    wallStorage: { kind: 'bitflags', plane: 'wallFlags', bits: [1, 2, 4, 8] }, // N, E, S, W
    yAxisDown: false,
    units: [{ id: 1, planes: { wallFlags } }],
  };
}

describe('FlatGridLevel', () => {
  it('indexes y*width+x', () => {
    const wallFlags = [0, 0, 0, 0, 0, 0, 0, 0, 5]; // cell (2,2) = N+S walls (1|4)
    const file = makeFile(wallFlags);
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(level.wallAt(2, 2, 0)).toBe(true); // N
    expect(level.wallAt(2, 2, 1)).toBe(false); // E
    expect(level.wallAt(2, 2, 2)).toBe(true); // S
    expect(level.wallAt(2, 2, 3)).toBe(false); // W
  });

  it('reports inBounds correctly at the edges', () => {
    const file = makeFile(new Array(9).fill(0));
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(level.inBounds(0, 0)).toBe(true);
    expect(level.inBounds(2, 2)).toBe(true);
    expect(level.inBounds(3, 0)).toBe(false);
    expect(level.inBounds(-1, 0)).toBe(false);
    expect(level.inBounds(0, 3)).toBe(false);
  });

  it('throws for wallAt on an out-of-bounds cell', () => {
    const file = makeFile(new Array(9).fill(0));
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(() => level.wallAt(5, 5, 0)).toThrow(/out of bounds/);
  });

  it('planeAt returns 0 (not a throw) for an out-of-bounds cell', () => {
    const file = makeFile(new Array(9).fill(0));
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(level.planeAt('wallFlags', 5, 5)).toBe(0);
  });

  it('planeAt throws for an unknown plane name', () => {
    const file = makeFile(new Array(9).fill(0));
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(() => level.planeAt('nope', 0, 0)).toThrow(/unknown plane/);
  });

  it('rejects a non-flat cellSpace', () => {
    const file = makeFile(new Array(9).fill(0));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (file as any).cellSpace = { kind: 'regions', regionCount: 1, regionSize: 1, worldWidth: 1, worldHeight: 1 };
    expect(() => new FlatGridLevel(file, file.units[0]!)).toThrow(/cellSpace.kind/);
  });

  it('rejects a plane whose length does not match width*height', () => {
    const file = makeFile([0, 0, 0]); // only 3 elements, needs 9
    expect(() => new FlatGridLevel(file, file.units[0]!)).toThrow(/elements, expected/);
  });
});

describe('FlatGridLevel.entitiesAt', () => {
  function makeFileWithEntities(): DungeonLevelFile {
    const file = makeFile(new Array(9).fill(0));
    file.units[0]!.planes.objectHandle = [0, 0, 0, 0, 5, 0, 0, 0, 0]; // cell (1,1) chain head = slot 5
    file.entityHandlePlane = 'objectHandle';
    file.entities = {
      '1:1:1:5': { type: 0x11, chainNext: 7, raw: [] },
      '1:1:1:7': { type: 0x14, chainNext: 0, raw: [] },
    };
    return file;
  }

  it('walks the same-square chain in order via chainNext', () => {
    const file = makeFileWithEntities();
    const level = new FlatGridLevel(file, file.units[0]!);
    const recs = level.entitiesAt(1, 1);
    expect(recs.map((r) => r.type)).toEqual([0x11, 0x14]);
  });

  it('returns [] for a cell with no chain (objectHandle 0)', () => {
    const file = makeFileWithEntities();
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(level.entitiesAt(0, 0)).toEqual([]);
  });

  it('returns [] when the level has no entityHandlePlane/entities at all', () => {
    const file = makeFile(new Array(9).fill(0));
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(level.entitiesAt(1, 1)).toEqual([]);
  });

  it('returns [] for an out-of-bounds cell rather than throwing', () => {
    const file = makeFileWithEntities();
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(level.entitiesAt(50, 50)).toEqual([]);
  });
});

describe('FlatGridLevel with shared-edge wall storage', () => {
  // 3x3 grid, index = y*3+x. planeDirs [0, 3]: edgeN carries north-facing
  // edges, edgeW carries west-facing edges (walker.md §10.2's recommended
  // convention) — every east/south query is really a neighbour's west/north
  // read of the exact same physical wall.
  function makeSharedEdgeFile(edgeN: number[], edgeW: number[], offMapValue = 0): DungeonLevelFile {
    return {
      schemaVersion: 1,
      game: 'test',
      platform: 'test',
      cellSpace: { kind: 'flat', width: 3, height: 3 },
      wallStorage: { kind: 'shared-edge', planes: ['edgeN', 'edgeW'], planeDirs: [0, 3], offMapValue },
      yAxisDown: false,
      units: [{ id: 1, planes: { edgeN, edgeW } }],
    };
  }

  it('reads a cell\'s own edge directly for planeDirs-matching facings', () => {
    const edgeN = [0, 0, 0, 0, 5, 0, 0, 0, 0]; // cell (1,1) N edge = 5
    const edgeW = new Array(9).fill(0);
    const file = makeSharedEdgeFile(edgeN, edgeW);
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(level.wallAt(1, 1, 0)).toBe(true); // N, own plane
    expect(level.wallAt(1, 1, 3)).toBe(false); // W, own plane (all zero)
  });

  it('reads the neighbour\'s plane for the opposite facings (S, E)', () => {
    const edgeN = [0, 5, 0, 0, 0, 0, 0, 0, 0]; // cell (1,0) N edge = 5
    const edgeW = [0, 0, 0, 0, 0, 3, 0, 0, 0]; // cell (2,1) W edge = 3
    const file = makeSharedEdgeFile(edgeN, edgeW);
    const level = new FlatGridLevel(file, file.units[0]!);
    // (1,1)'s S edge is the same wall as (1,0)'s N edge (Y increases northward).
    expect(level.wallAt(1, 1, 2)).toBe(true);
    // (1,1)'s E edge is the same wall as (2,1)'s W edge.
    expect(level.wallAt(1, 1, 1)).toBe(true);
  });

  it('agrees with its neighbour on a shared edge (both sides read the same wall)', () => {
    const edgeN = [0, 5, 0, 0, 0, 0, 0, 0, 0]; // cell (1,0) N edge = 5
    const edgeW = new Array(9).fill(0);
    const file = makeSharedEdgeFile(edgeN, edgeW);
    const level = new FlatGridLevel(file, file.units[0]!);
    expect(level.wallAt(1, 0, 0)).toBe(level.wallAt(1, 1, 2)); // both true
  });

  it('uses offMapValue when the shared edge falls off the grid', () => {
    const edgeN = new Array(9).fill(0);
    const edgeW = new Array(9).fill(0);
    const withoutBorder = new FlatGridLevel(makeSharedEdgeFile(edgeN, edgeW, 0), makeSharedEdgeFile(edgeN, edgeW, 0).units[0]!);
    const withBorder = new FlatGridLevel(makeSharedEdgeFile(edgeN, edgeW, 9), makeSharedEdgeFile(edgeN, edgeW, 9).units[0]!);
    // Row y=0 is the grid's south edge (Y increases northward) — its own S
    // query has no neighbour to read.
    expect(withoutBorder.wallAt(1, 0, 2)).toBe(false);
    expect(withBorder.wallAt(1, 0, 2)).toBe(true);
  });

  it('rejects a plane missing from the unit', () => {
    const file = makeSharedEdgeFile(new Array(9).fill(0), new Array(9).fill(0));
    file.units[0]!.planes = { edgeN: new Array(9).fill(0) }; // edgeW missing
    expect(() => new FlatGridLevel(file, file.units[0]!)).toThrow(/no plane "edgeW"/);
  });

  it('throws if planeDirs share an axis (misconfigured schema, not a valid shared-edge pair)', () => {
    const file: DungeonLevelFile = {
      schemaVersion: 1,
      game: 'test',
      platform: 'test',
      cellSpace: { kind: 'flat', width: 3, height: 3 },
      wallStorage: { kind: 'shared-edge', planes: ['edgeN', 'edgeS'], planeDirs: [0, 0], offMapValue: 0 },
      yAxisDown: false,
      units: [{ id: 1, planes: { edgeN: new Array(9).fill(0), edgeS: new Array(9).fill(0) } }],
    };
    const level = new FlatGridLevel(file, file.units[0]!);
    // dir=1 (E) matches neither planeDirs[i]=0 nor its opposite (2).
    expect(() => level.wallAt(1, 1, 1)).toThrow(/matches neither planeDirs entry nor its opposite/);
  });

  it('does not infinite-loop on a self-referential chainNext', () => {
    const file = makeFile(new Array(9).fill(0));
    file.units[0]!.planes.objectHandle = [0, 0, 0, 0, 5, 0, 0, 0, 0];
    file.entityHandlePlane = 'objectHandle';
    file.entities = { '1:1:1:5': { type: 0x30, chainNext: 5, raw: [] } }; // points to itself
    const level = new FlatGridLevel(file, file.units[0]!);
    let recs: ReturnType<typeof level.entitiesAt> = [];
    expect(() => {
      recs = level.entitiesAt(1, 1);
    }).not.toThrow();
    expect(recs).toHaveLength(1); // visited once, not forever
  });
});
