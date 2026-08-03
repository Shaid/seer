/**
 * The single read interface every geometry consumer (`buildViewList`,
 * automap, movement/collision) queries a level through. `CellSpace` has two
 * shapes in the schema (`flat`, `regions`); `CellQuery` is what lets
 * `buildViewList` stay agnostic to which one backs a given level —
 * `FlatGridLevel` implements it for Black Crypt's `{kind:'flat'}` cells,
 * and a future `RegionGridLevel` (mentioned in the walker plan, not needed
 * until a game with sparse/paged storage shows up) would implement it too.
 */
import type { Dir4 } from './Pose.ts';

export interface CellQuery {
  /** Whether `(x, y)` is a real, addressable cell in this level. */
  inBounds(x: number, y: number): boolean;

  /**
   * Whether cell `(x, y)` has a wall on its `dir`-facing edge. Must be
   * queried only when `inBounds(x, y)` — implementations are free to throw
   * for an out-of-bounds cell rather than inventing a value, since callers
   * (`buildViewList`) always check bounds first.
   */
  wallAt(x: number, y: number, dir: Dir4): boolean;

  /**
   * The raw value of plane `name` at `(x, y)` — e.g. Black Crypt's `type`,
   * `sublevel`, `objectHandle` planes. Throws for an unknown plane name;
   * returns `0` for an out-of-bounds cell (planes are informational, not a
   * movement/rendering gate the way `wallAt` is, so a caller reading a
   * plane speculatively near the level's edge gets a harmless default
   * instead of a bounds exception).
   */
  planeAt(name: string, x: number, y: number): number;
}
