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
import type { EntityRecord } from '../schema/level.ts';

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

  /**
   * Every entity (item/structure/monster head record) occupying cell
   * `(x, y)`, walking the same-square chain the way the game's own loader
   * does (`bcdfs.load_world`'s docstring — `chainNext` threads the chain,
   * `0` ends it). Returns `[]` for an out-of-bounds or empty cell — this is
   * a data lookup for props/M5, not a movement/rendering gate, so (like
   * `planeAt`) it never throws for "nothing here".
   */
  entitiesAt(x: number, y: number): EntityRecord[];

  /**
   * Optional — the same records `entitiesAt` returns, each paired with a
   * stable string `handle` a host can hold onto (e.g. from a hotspot's
   * `onInteract`) and later pass to `PatchedCellQuery.setPatch`/a walker's
   * `setEntityState` to mutate that exact record (M4, `walker-plan.md`
   * "Mouse interactivity"). A `CellQuery` with no addressable entity
   * identity (most geometry-only test fixtures) simply omits this —
   * callers needing handles treat a missing implementation as "entities
   * here are anonymous/read-only." `FlatGridLevel`'s handle format is
   * `"<unitId>:<y>:<x>:<slot>"`, the same key `DungeonLevelFile.entities`
   * is keyed by.
   */
  entityHandlesAt?(x: number, y: number): Array<{ handle: string; entity: EntityRecord }>;
}
