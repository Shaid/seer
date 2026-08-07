/**
 * `CellQuery` for a `{kind:'flat'}` cell space, supporting both wall-storage
 * conventions the schema declares: `bitflags` (Black Crypt's own shape — a
 * `bcdfs` map densified to 64x64, `wallFlags` plane, one bit per compass
 * direction; indexing is `y*width+x`, matching the runtime array the game
 * itself uses — `A4-0x37CA`, `(row<<8)|(col<<2)`, row is `y`, col is `x`,
 * and the byte strides there are just `4*width`/`4` element strides once
 * read as an element index rather than a byte offset) and `shared-edge`
 * (Wizardry 6's own shape — a wall edge is stored once, on whichever of its
 * two adjacent cells "owns" that plane, per `planeDirs`; the *other* cell's
 * query for the same edge reads its neighbour's plane value instead of its
 * own — see `wallAt` below).
 */
import type { CellQuery } from './CellQuery.ts';
import type { Dir4 } from './Pose.ts';
import { step } from './Direction.ts';
import type { DungeonLevelFile, EntityRecord, LevelUnit, WallStorage } from '../schema/level.ts';

export class FlatGridLevel implements CellQuery {
  readonly width: number;
  readonly height: number;
  readonly unit: LevelUnit;
  private readonly wallStorage: WallStorage;
  /** Resolved once in the constructor so `wallAt` never does a `Record` lookup by plane name in its hot inner-loop path. */
  private readonly bitflagsPlane: number[] | undefined;
  /** Same caching, for `shared-edge`'s two planes, indexed the same way as `wallStorage.planes`/`planeDirs`. */
  private readonly sharedEdgePlanes: [number[], number[]] | undefined;
  private readonly entities: Record<string, EntityRecord> | undefined;
  private readonly entityHandlePlane: string | undefined;

  constructor(file: DungeonLevelFile, unit: LevelUnit) {
    if (file.cellSpace.kind !== 'flat') {
      throw new Error(`FlatGridLevel: cellSpace.kind must be "flat", got "${file.cellSpace.kind}"`);
    }
    if (file.yAxisDown) {
      // Direction.ts's FACING_DELTAS/step() hardcode a fixed "Y increases
      // northward" convention (Black Crypt's own, doc-commented there) and
      // take no yAxisDown parameter at all -- every consumer of `step`
      // (Pose, buildViewList, and this class's own shared-edge neighbour
      // lookup below) shares that same unconditional assumption. A
      // yAxisDown:true game would therefore get silently wrong
      // neighbour/movement geometry, not a schema violation -- so this
      // throws instead of guessing. Fix Direction.ts to actually consult
      // yAxisDown (threaded through every step()/project() call site) before
      // removing this guard for a real yAxisDown:true game.
      throw new Error('FlatGridLevel: yAxisDown:true is not yet supported -- see this constructor\'s comment');
    }
    this.width = file.cellSpace.width;
    this.height = file.cellSpace.height;
    this.unit = unit;
    const cellCount = this.width * this.height;
    const requirePlane = (name: string) => {
      const plane = unit.planes[name];
      if (!plane) {
        throw new Error(`FlatGridLevel: unit ${unit.id} has no plane "${name}" named by wallStorage`);
      }
      if (plane.length !== cellCount) {
        throw new Error(`FlatGridLevel: unit ${unit.id} plane "${name}" has ${plane.length} elements, expected ${cellCount}`);
      }
      return plane;
    };
    switch (file.wallStorage.kind) {
      case 'bitflags':
        this.bitflagsPlane = requirePlane(file.wallStorage.plane);
        break;
      case 'shared-edge': {
        const [dirA, dirB] = file.wallStorage.planeDirs;
        // The two planeDirs must span perpendicular axes (differ by 1 or 3
        // mod 4) so that, together with each one's "opposite" facing, they
        // partition all 4 facings exactly once. A degenerate pair sharing
        // or opposing the same axis (e.g. [0,0] or [0,2]) doesn't just fail
        // to cover 2 facings (which already throws below, in
        // sharedEdgeValueAt) -- for the 2 facings it DOES match, it makes
        // one of the two planes permanently unreachable (silently ignored,
        // not a wrong-but-visible read), because the loop's first matching
        // branch short-circuits before the second plane is ever consulted.
        // Reject that at construction time rather than let it through.
        if (dirA === dirB || ((dirA + 2) % 4) === dirB) {
          throw new Error(`FlatGridLevel: wallStorage.planeDirs [${dirA}, ${dirB}] must be perpendicular (differ by 1 or 3 mod 4) -- a pair sharing or opposing the same axis leaves one plane unreachable`);
        }
        this.sharedEdgePlanes = [requirePlane(file.wallStorage.planes[0]), requirePlane(file.wallStorage.planes[1])];
        break;
      }
      default:
        throw new Error(`FlatGridLevel: wallStorage.kind "${(file.wallStorage as WallStorage).kind}" is not yet implemented`);
    }
    this.wallStorage = file.wallStorage;
    this.entities = file.entities;
    this.entityHandlePlane = file.entityHandlePlane;
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
    if (this.wallStorage.kind === 'bitflags') {
      const bits = this.bitflagsPlane![this.index(x, y)] ?? 0;
      return (bits & this.wallStorage.bits[dir]) !== 0;
    }
    if (this.wallStorage.kind === 'shared-edge') {
      return this.sharedEdgeValueAt(x, y, dir, this.wallStorage) !== 0;
    }
    // Unreachable: the constructor already rejects any other kind.
    throw new Error(`FlatGridLevel.wallAt: wallStorage.kind "${this.wallStorage.kind}" is not implemented`);
  }

  /**
   * The raw shared-edge plane value for `(x, y)`'s `dir`-facing edge. Each
   * edge is stored once, on the plane named by `planeDirs[i]` for whichever
   * cell's `dir === planeDirs[i]` — e.g. with the walker plan's recommended
   * `planeDirs: [0, 3]` (plane A = north-facing edges, plane B =
   * west-facing edges, `walker.md` §10.2), a cell's own north/west edges
   * read its own planes directly, while its south/east edges are the same
   * physical wall as its southern/eastern neighbour's north/west edge, so
   * they read that neighbour's plane instead. A neighbour that falls off
   * the grid (the level's own south/east border) reads as `offMapValue`
   * rather than indexing out of bounds — that value is still meaningful
   * (whether the map edge itself is walled) precisely because nothing else
   * ever stores it.
   */
  private sharedEdgeValueAt(
    x: number,
    y: number,
    dir: Dir4,
    storage: Extract<WallStorage, { kind: 'shared-edge' }>,
  ): number {
    for (let i = 0; i < 2; i++) {
      const planeDir = storage.planeDirs[i]!;
      const plane = this.sharedEdgePlanes![i];
      if (dir === planeDir) {
        return plane[this.index(x, y)] ?? 0;
      }
      if (dir === (((planeDir + 2) % 4) as Dir4)) {
        const neighbour = step(x, y, dir);
        if (!this.inBounds(neighbour.x, neighbour.y)) return storage.offMapValue;
        return plane[this.index(neighbour.x, neighbour.y)] ?? 0;
      }
    }
    // Unreachable: the constructor rejects any planeDirs pair that isn't
    // perpendicular, and a perpendicular pair's two (own, opposite) facing
    // sets always partition all 4 facings exactly once between them.
    throw new Error(`FlatGridLevel.sharedEdgeValueAt: dir ${dir} matches neither planeDirs entry nor its opposite`);
  }

  planeAt(name: string, x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    const plane = this.unit.planes[name];
    if (!plane) throw new Error(`FlatGridLevel.planeAt: unknown plane "${name}"`);
    return plane[this.index(x, y)] ?? 0;
  }

  entitiesAt(x: number, y: number): EntityRecord[] {
    return this.walkEntityChain(x, y).map((e) => e.entity);
  }

  /** Same chain walk as `entitiesAt`, but keeping each record's own lookup key as its `handle` — see `CellQuery.entityHandlesAt`'s doc comment. */
  entityHandlesAt(x: number, y: number): Array<{ handle: string; entity: EntityRecord }> {
    return this.walkEntityChain(x, y);
  }

  private walkEntityChain(x: number, y: number): Array<{ handle: string; entity: EntityRecord }> {
    if (!this.entities || !this.entityHandlePlane || !this.inBounds(x, y)) return [];
    let slot = this.planeAt(this.entityHandlePlane, x, y);
    const out: Array<{ handle: string; entity: EntityRecord }> = [];
    const seen = new Set<number>(); // defensive: never loop forever on a malformed chain
    while (slot && !seen.has(slot)) {
      seen.add(slot);
      const handle = `${this.unit.id}:${y}:${x}:${slot}`;
      const rec = this.entities[handle];
      if (!rec) break;
      out.push({ handle, entity: rec });
      slot = rec.chainNext ?? 0;
    }
    return out;
  }
}
