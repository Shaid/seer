/**
 * `CellQuery` for a `{kind:'flat'}` cell space with `{kind:'bitflags'}` wall
 * storage — Black Crypt's own shapes (a `bcdfs` map densified to 64x64,
 * `wallFlags` plane, one bit per compass direction). Indexing is `y*width+x`,
 * matching the runtime array the game itself uses
 * (`A4-0x37CA`, `(row<<8)|(col<<2)` — row is `y`, col is `x`, and the byte
 * strides there are just `4*width`/`4` element strides once read as an
 * element index rather than a byte offset).
 */
import type { CellQuery } from './CellQuery.ts';
import type { Dir4 } from './Pose.ts';
import type { DungeonLevelFile, LevelUnit } from '../schema/level.ts';

export class FlatGridLevel implements CellQuery {
  readonly width: number;
  readonly height: number;
  readonly unit: LevelUnit;
  private readonly wallPlane: number[];
  private readonly wallBits: readonly [number, number, number, number];

  constructor(file: DungeonLevelFile, unit: LevelUnit) {
    if (file.cellSpace.kind !== 'flat') {
      throw new Error(`FlatGridLevel: cellSpace.kind must be "flat", got "${file.cellSpace.kind}"`);
    }
    if (file.wallStorage.kind !== 'bitflags') {
      throw new Error(`FlatGridLevel: wallStorage.kind must be "bitflags", got "${file.wallStorage.kind}" (not yet implemented)`);
    }
    this.width = file.cellSpace.width;
    this.height = file.cellSpace.height;
    this.unit = unit;
    const plane = unit.planes[file.wallStorage.plane];
    if (!plane) {
      throw new Error(`FlatGridLevel: unit ${unit.id} has no plane "${file.wallStorage.plane}" named by wallStorage`);
    }
    if (plane.length !== this.width * this.height) {
      throw new Error(`FlatGridLevel: unit ${unit.id} plane "${file.wallStorage.plane}" has ${plane.length} elements, expected ${this.width * this.height}`);
    }
    this.wallPlane = plane;
    this.wallBits = file.wallStorage.bits;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  private index(x: number, y: number): number {
    return y * this.width + x;
  }

  wallAt(x: number, y: number, dir: Dir4): boolean {
    if (!this.inBounds(x, y)) {
      throw new Error(`FlatGridLevel.wallAt: (${x}, ${y}) is out of bounds (${this.width}x${this.height})`);
    }
    const bits = this.wallPlane[this.index(x, y)] ?? 0;
    return (bits & this.wallBits[dir]) !== 0;
  }

  planeAt(name: string, x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    const plane = this.unit.planes[name];
    if (!plane) throw new Error(`FlatGridLevel.planeAt: unknown plane "${name}"`);
    return plane[this.index(x, y)] ?? 0;
  }
}
