/**
 * The walker's position + facing. Deliberately tiny and serializable —
 * `serialize()`/`restore()` in a later milestone just needs to round-trip
 * this plus a visited set.
 */
export type { Dir4 } from '../schema/level.js';
import type { Dir4 } from '../schema/level.js';
import { rotate } from './Direction.js';

export interface Pose {
  /** The `LevelUnit.id` this pose is in. */
  level: number;
  x: number;
  y: number;
  facing: Dir4;
}

/** `TurnParty(delta=3)` — S_1 `+0x1702A`, called with `delta=3` for left. */
export function turnLeft(pose: Pose): Pose {
  return { ...pose, facing: rotate(pose.facing, -1) };
}

/** `TurnParty(delta=1)` — the same routine, called with `delta=1` for right. */
export function turnRight(pose: Pose): Pose {
  return { ...pose, facing: rotate(pose.facing, 1) };
}
