/**
 * `canStep` — the single movement-gate predicate `WalkerController` (and any
 * other mover) should call before turning an intended step into a pose
 * change. Per the walker plan's M3 design:
 *
 * - It checks the **edge's** wall value, via `CellQuery.wallAt(pose.x,
 *   pose.y, dir)` on the *source* cell — never the destination cell's own
 *   contents. This is what keeps the check correct under every
 *   `WallStorage` kind the schema allows: a `bitflags` cell (Black Crypt)
 *   stores each cell's own opinion of its 4 edges, and a future
 *   `shared-edge` model stores one edge shared by two cells — either way,
 *   "does the edge I'm about to cross have a wall on it" is answerable from
 *   the cell you're leaving, without needing to know which storage kind
 *   backs the level.
 * - It **fails closed**: if `wallAt` throws (e.g. a malformed/partial
 *   `CellQuery` implementation, or any other "I don't actually know" case),
 *   movement is blocked rather than allowed. Silently walking through
 *   unmodeled geometry is a worse failure mode than being incorrectly stuck
 *   — a stuck party is immediately visible and diagnosable; a party that
 *   walked through a wall because a lookup failed usually isn't caught until
 *   much later, if ever.
 * - It also checks `inBounds` on the destination — stepping off the edge of
 *   a level is exactly as much a "no" as stepping into a mapped wall.
 */
import type { CellQuery } from './CellQuery.js';
import type { Pose, Dir4 } from './Pose.js';
import { step } from './Direction.js';
import type { SemanticsFile } from '../schema/semantics.js';

/**
 * `semantics` is accepted per the walker plan's documented signature — a
 * richer `WallStorage` kind (or a wall whose meaning depends on discovery
 * state, e.g. a secret door) would consult `semantics.walls` here. Black
 * Crypt's plain boolean `wallAt` needs none of it yet, mirroring
 * `buildViewList`'s identical `_semantics` parameter and its own doc
 * comment explaining why.
 */
export function canStep(
  level: CellQuery,
  _semantics: SemanticsFile,
  pose: Pose,
  dir: Dir4,
): boolean {
  const dest = step(pose.x, pose.y, dir);
  if (!level.inBounds(dest.x, dest.y)) return false;

  try {
    return !level.wallAt(pose.x, pose.y, dir);
  } catch {
    // Fail closed: an unmapped/unknown wall value blocks movement rather
    // than allowing travel through unmodeled geometry.
    return false;
  }
}
