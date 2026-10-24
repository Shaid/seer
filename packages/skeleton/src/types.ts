/**
 * The plain-data skeleton this package works on.
 *
 * Nothing here is tied to a file format, an engine or a renderer: a bone is a
 * parent index plus a TRS triple, and a skeleton is an array of them. Any
 * engine-specific skeleton type whose bones carry those four fields — Koei
 * Tecmo's `G1MSkeleton`, a glTF node graph viewed one-node-per-bone, a Unity
 * `Avatar` dump — is *structurally* assignable to `Skeleton` with no adapter
 * and no conversion copy, which is the whole reason the types are declared
 * this narrowly.
 */

export interface Vec3 { x: number; y: number; z: number; }
export interface Quat4 { x: number; y: number; z: number; w: number; }

/**
 * One bone: its parent's index (negative, or out of range, means "root") and
 * its parent-relative rest transform. Extra fields an engine's own bone type
 * carries are ignored.
 */
export interface TrsBone {
  parent: number;
  rotation: Quat4;
  position: Vec3;
  scale: Vec3;
}

/**
 * A rig, as every algorithm here reads it: just the bone array. Deliberately
 * the smallest shape that works, so an engine's richer skeleton object (bone
 * remap tables, bone-set counts, format flags) is accepted as-is.
 */
export interface Skeleton {
  bones: readonly TrsBone[];
}

/**
 * The minimal node shape a TRS node graph (e.g. a glTF `nodes[]` array with
 * decomposed transforms) needs to be viewed as a `Skeleton`.
 */
export interface TrsNodeLike {
  translation: readonly [number, number, number] | readonly number[];
  rotation: readonly [number, number, number, number] | readonly number[];
  scale: readonly [number, number, number] | readonly number[];
}
