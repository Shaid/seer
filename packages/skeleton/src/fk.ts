/**
 * Bind-pose forward kinematics over a plain TRS bone hierarchy.
 *
 * A deliberate leaf module: it imports only `./types.js` and
 * `@seer-project/gltf`'s matrix helpers, so every consumer can import it
 * without a cycle — which is exactly why hand-rolled copies of it tend to
 * accumulate one per exporter.
 *
 * The parent-first DFS `order` is load-bearing for glTF consumers: a skin's
 * `joints[]` and the matching `inverseBindMatrices` accessor have to be laid
 * out in the same sequence, and having one implementation is what keeps those
 * from silently desyncing.
 */

import { mat4Multiply, quatToMatrix } from '@seer-project/gltf';
import type { TrsBone } from './types.js';

export interface BoneTraversal {
  /** Bone indices in parent-first depth-first order — the glTF node / joint-slot order. */
  order: number[];
  /** Bone indices with no in-range parent, in ascending index order. */
  roots: number[];
  /** `children[i]` = the bone indices whose `parent` is `i`, in ascending index order. */
  children: number[][];
}

/**
 * Parent-first DFS over a bone hierarchy. A bone whose `parent` is negative
 * or out of range is treated as a root, so a malformed rig still yields every
 * bone exactly once rather than dropping a subtree.
 */
export function boneTraversalOrder(bones: readonly TrsBone[]): BoneTraversal {
  const children: number[][] = Array.from({ length: bones.length }, () => []);
  const roots: number[] = [];
  bones.forEach((b, i) => { if (b.parent >= 0 && b.parent < bones.length) children[b.parent]!.push(i); else roots.push(i); });
  const order: number[] = [];
  const visit = (i: number): void => { order.push(i); for (const c of children[i]!) visit(c); };
  for (const r of roots) visit(r);
  return { order, roots, children };
}

/**
 * World-space bind matrix per bone (column-major, glTF layout): the bone's
 * quaternion rotation scaled per axis, translated, then composed with its
 * parent's world matrix along the parent-first walk.
 */
export function computeBoneWorldMatrices(bones: readonly TrsBone[]): Float32Array[] {
  const { order } = boneTraversalOrder(bones);
  const world = new Array<Float32Array>(bones.length);
  for (const i of order) {
    const b = bones[i]!;
    const local = quatToMatrix(b.rotation);
    local[0]! *= b.scale.x; local[1]! *= b.scale.x; local[2]! *= b.scale.x;
    local[4]! *= b.scale.y; local[5]! *= b.scale.y; local[6]! *= b.scale.y;
    local[8]! *= b.scale.z; local[9]! *= b.scale.z; local[10]! *= b.scale.z;
    local[12] = b.position.x; local[13] = b.position.y; local[14] = b.position.z;
    world[i] = b.parent >= 0 && b.parent < bones.length && world[b.parent] ? mat4Multiply(world[b.parent]!, local) : local;
  }
  return world;
}
