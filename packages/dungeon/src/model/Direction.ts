/**
 * Small, pure compass-direction helpers `Pose.ts` and `buildViewList.ts`
 * both need — factored out here rather than duplicated, since both a pose
 * turning in place and a view walker sighting down a corridor are really
 * doing the same rotation/step arithmetic.
 *
 * `Dir4` is `0=N, 1=E, 2=S, 3=W` and the deltas below are Black Crypt's own
 * confirmed convention (`docs/blackcrypt/amiga/data-structure.md`,
 * "Party Movement / Facing State Machine"): **Y increases northward**
 * (`facing=0 ⇒ Y+=1`), X increases eastward (`facing=1 ⇒ X+=1`) — a
 * standard right-handed 2D frame, not a screen/array convention. This is
 * exactly why `DungeonLevelFile.yAxisDown` is `false` for this game.
 */
import type { Dir4 } from './Pose.ts';

export const FACING_DELTAS: Record<Dir4, { dx: number; dy: number }> = {
  0: { dx: 0, dy: 1 }, // N
  1: { dx: 1, dy: 0 }, // E
  2: { dx: 0, dy: -1 }, // S
  3: { dx: -1, dy: 0 }, // W
};

/** Rotate a facing by `delta` steps (may be negative), wrapping mod 4. */
export function rotate(facing: Dir4, delta: number): Dir4 {
  return (((facing + delta) % 4) + 4) % 4 as Dir4;
}

/** The compass direction 90 degrees left of `facing`. */
export function leftOf(facing: Dir4): Dir4 {
  return rotate(facing, -1);
}

/** The compass direction 90 degrees right of `facing`. */
export function rightOf(facing: Dir4): Dir4 {
  return rotate(facing, 1);
}

/** One cell step from `(x, y)` in compass direction `dir`. */
export function step(x: number, y: number, dir: Dir4): { x: number; y: number } {
  const d = FACING_DELTAS[dir];
  return { x: x + d.dx, y: y + d.dy };
}

/**
 * A point `depth` cells forward of `(x, y)` (in compass direction
 * `facing`) and `lateral` cells to that facing's right (negative =
 * left) — the exact vector `DrawViewport`'s Phase-1 sight-line walk uses
 * per square (`data-structure.md`, "Phase 1 — the sight-line walk":
 * "Lateral step (D3, + = party's right)").
 */
export function project(x: number, y: number, facing: Dir4, depth: number, lateral: number): { x: number; y: number } {
  const fwd = FACING_DELTAS[facing];
  const right = FACING_DELTAS[rightOf(facing)];
  return {
    x: x + fwd.dx * depth + right.dx * lateral,
    y: y + fwd.dy * depth + right.dy * lateral,
  };
}
