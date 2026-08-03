/**
 * The pure view-geometry walker: given a level, a pose, and where art comes
 * from, produce the list of pieces a compositor should draw. No DOM, no
 * PixiJS — this is "the layer middilgard never had and never tested"
 * (`walker-plan.md`).
 *
 * Reproduces Black Crypt's own `DrawViewport` Phase-1 sight-line walk
 * (`data-structure.md`, "3D Viewport Compositing" -> "Phase 1"): visits
 * `depth` 0..`spec.depthCount-1`, and at each depth every offset in
 * `spec.lateralOffsets` (Black Crypt: `[0, 1, -1]`, centre-first — order
 * doesn't matter for this pure list-building pass, only for a later
 * painter's sort). For each visited cell:
 *
 * - a **front-wall** piece is emitted only for `depth < spec.frontWallMaxDepth`
 *   (the `CMPI.W #3,D2 / BGE` gate) and only when that cell actually has a
 *   wall on its edge facing the pose's own facing;
 * - a **side-wall** piece (both left and right, independently) is emitted
 *   only at `lateral === 0` (the `TST.W D3 / BNE` gate — side walls are only
 *   ever drawn for the centre column) and only when that edge has a wall.
 *
 * Both gates and the wall-bit directions (front = `pose.facing`, left =
 * `leftOf(pose.facing)`, right = `rightOf(pose.facing)`) are the confirmed
 * facts from "3D Viewport Compositing" -> "Verification" and "Party
 * Movement" -> "Facing encoding" — not re-derived here, just applied.
 *
 * A missing slot table entry (`slots.slots[key]` is `null`/absent) is not an
 * error — it just means this milestone's `slots.json` doesn't cover that
 * placement yet (e.g. a prop-carrying square with no wall descriptor). This
 * function only ever looks up the 9 front-wall / 8 side-wall keys the M1
 * slot table already proves exist (`frontWallMaxDepth * lateralOffsets.length`
 * / `depthCount * 2`), so a well-formed `spec` can never reference a key
 * outside that already-verified range.
 */
import type { CellQuery } from '../model/CellQuery.ts';
import type { Pose } from '../model/Pose.ts';
import { leftOf, rightOf, project } from '../model/Direction.ts';
import type { ViewSpec } from './ViewSpec.ts';
import type { SemanticsFile } from '../schema/semantics.ts';
import type { SlotTableFile } from '../schema/slots.ts';
import type { DrawItem, DrawItemKind } from './DrawItem.ts';

function pushSlot(
  items: DrawItem[],
  slots: SlotTableFile,
  key: string,
  kind: DrawItemKind,
  depth: number,
  lateral: number,
  side?: 'L' | 'R',
): void {
  const slot = slots.slots[key];
  if (!slot) return;
  for (const draw of slot.draws) {
    items.push({ ...draw, kind, depth, lateral, side });
  }
}

/**
 * `semantics` is accepted per the walker plan's documented signature (a
 * future milestone's piece-kind/behaviour lookups need it) but not yet
 * consulted here — Black Crypt's plain wall geometry needs only the wall
 * bits themselves, nothing from `semantics.walls`/`features` (see
 * `docs/porting-guide.md`'s eventual write-up of this). Kept as an explicit
 * parameter now rather than added later so the signature doesn't change
 * shape out from under existing callers.
 */
export function buildViewList(
  level: CellQuery,
  pose: Pose,
  spec: ViewSpec,
  _semantics: SemanticsFile,
  slots: SlotTableFile,
): DrawItem[] {
  const items: DrawItem[] = [];

  for (let depth = 0; depth < spec.depthCount; depth++) {
    for (const lateral of spec.lateralOffsets) {
      const { x, y } = project(pose.x, pose.y, pose.facing, depth, lateral);
      if (!level.inBounds(x, y)) continue;

      if (depth < spec.frontWallMaxDepth && level.wallAt(x, y, pose.facing)) {
        pushSlot(items, slots, `front:${lateral}:${depth}`, 'front', depth, lateral);
      }

      if (lateral === 0) {
        if (level.wallAt(x, y, leftOf(pose.facing))) {
          pushSlot(items, slots, `side:L:${depth}`, 'side', depth, lateral, 'L');
        }
        if (level.wallAt(x, y, rightOf(pose.facing))) {
          pushSlot(items, slots, `side:R:${depth}`, 'side', depth, lateral, 'R');
        }
      }
    }
  }

  return items;
}
