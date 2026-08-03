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
