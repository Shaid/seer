/**
 * The small vector/quaternion/matrix layer and the bind-pose forward
 * kinematics every module in this package shares.
 *
 * `@seer-project/gltf` already provides `mat4Inverse` / `mat4Multiply` /
 * `quatToMatrix`, which the callers import directly; what is here is the
 * remainder it does not cover (component-wise vec3/quat algebra, the three
 * 4x4 constructors the bind-pose reconciler builds its corrections from, and
 * the two FK passes — translation-only `computeWorldPositions` and the
 * richer `computePose`).
 */
import type { TrsBone, Vec3, Quat4 } from './types.js';
import { computeBoneWorldMatrices } from './fk.js';

export type { Vec3, Quat4 } from './types.js';

/** Bind-pose world position AND orientation per bone, plus the hierarchy both directions. */
export interface Pose { position: Vec3[]; rotation: Quat4[]; children: number[][]; roots: number[]; }

// ---------------------------------------------------------------------------
// Vector / quaternion algebra
// ---------------------------------------------------------------------------

export function vsub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function vlen(a: Vec3): number { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
export function vdot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function qdot(a: Quat4, b: Quat4): number { return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w); } // abs: q and -q are the same rotation

export function qmul(a: Quat4, b: Quat4): Quat4 {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
/** Conjugate (== inverse, for a unit quaternion) — `q * qconj(q) == identity`. */
export function qconj(q: Quat4): Quat4 { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
export function qrot(q: Quat4, v: Vec3): Vec3 {
  const uvx = q.y * v.z - q.z * v.y, uvy = q.z * v.x - q.x * v.z, uvz = q.x * v.y - q.y * v.x;
  const uuvx = q.y * uvz - q.z * uvy, uuvy = q.z * uvx - q.x * uvz, uuvz = q.x * uvy - q.y * uvx;
  return { x: v.x + 2 * (q.w * uvx + uuvx), y: v.y + 2 * (q.w * uvy + uuvy), z: v.z + 2 * (q.w * uvz + uuvz) };
}
export function qnormalize(q: Quat4): Quat4 {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}
/** Shortest-arc rotation taking unit vector `a` onto unit vector `b`. */
export function quatFromTo(a: Vec3, b: Vec3): Quat4 {
  const d = vdot(a, b);
  if (d < -0.999999) {
    // Antiparallel: 180 deg about any axis perpendicular to a.
    let axis = { x: -a.y, y: a.x, z: 0 };
    if (vlen(axis) < 1e-6) axis = { x: 0, y: -a.z, z: a.y };
    const l = vlen(axis);
    return { x: axis.x / l, y: axis.y / l, z: axis.z / l, w: 0 };
  }
  const c = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  return qnormalize({ x: c.x, y: c.y, z: c.z, w: 1 + d });
}
export function quatAngleDeg(q: Quat4): number {
  return (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// 4x4 constructors / application (column-major, glTF convention)
// ---------------------------------------------------------------------------

export function mat4Translation(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1; m[12] = x; m[13] = y; m[14] = z;
  return m;
}
export function mat4UniformScale(s: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = s; m[5] = s; m[10] = s; m[15] = 1;
  return m;
}
/** `I + (k - 1) d d^T` — scale by `k` along unit direction `d`. */
export function mat4AxisScale(d: Vec3, k: number): Float32Array {
  const m = new Float32Array(16);
  const f = k - 1;
  m[0] = 1 + f * d.x * d.x; m[1] = f * d.y * d.x; m[2] = f * d.z * d.x;
  m[4] = f * d.x * d.y; m[5] = 1 + f * d.y * d.y; m[6] = f * d.z * d.y;
  m[8] = f * d.x * d.z; m[9] = f * d.y * d.z; m[10] = 1 + f * d.z * d.z;
  m[15] = 1;
  return m;
}
export function mat4ApplyPoint(m: Float32Array, v: Vec3): Vec3 {
  return { x: m[0]! * v.x + m[4]! * v.y + m[8]! * v.z + m[12]!, y: m[1]! * v.x + m[5]! * v.y + m[9]! * v.z + m[13]!, z: m[2]! * v.x + m[6]! * v.y + m[10]! * v.z + m[14]! };
}

// ---------------------------------------------------------------------------
// Bind-pose forward kinematics and hierarchy measures
// ---------------------------------------------------------------------------

/** Bind-pose world-space translation per bone, Y-up (the convention every rig in this package is assumed to use). */
export function computeWorldPositions(bones: readonly TrsBone[]): Vec3[] {
  return computeBoneWorldMatrices(bones).map((m) => ({ x: m[12]!, y: m[13]!, z: m[14]! }));
}

export function boundingHeight(world: readonly Vec3[]): number {
  let min = Infinity, max = -Infinity;
  for (const p of world) { if (p.y < min) min = p.y; if (p.y > max) max = p.y; }
  return max - min;
}

/** Uniform scale that best maps SOURCE bind-pose space onto TARGET bind-pose space, estimated from overall standing height (assumes two Y-up humanoids of comparable proportions). */
export function estimateUniformScale(sourceWorld: readonly Vec3[], targetWorld: readonly Vec3[]): number {
  const sh = boundingHeight(sourceWorld), th = boundingHeight(targetWorld);
  if (sh <= 0 || th <= 0) return 1;
  return th / sh;
}

/** Bind-pose world position AND orientation per bone, plus hierarchy — the richer pose the matchers need for the rotation/child-count signals `computeWorldPositions` alone cannot give. */
export function computePose(bones: readonly TrsBone[]): Pose {
  const children: number[][] = Array.from({ length: bones.length }, () => []);
  const roots: number[] = [];
  bones.forEach((b, i) => { if (b.parent >= 0 && b.parent < bones.length) children[b.parent]!.push(i); else roots.push(i); });
  const position = new Array<Vec3>(bones.length);
  const rotation = new Array<Quat4>(bones.length);
  function compute(i: number): void {
    if (position[i]) return;
    const b = bones[i]!;
    if (b.parent < 0 || b.parent >= bones.length) {
      position[i] = { ...b.position };
      rotation[i] = { ...b.rotation };
      return;
    }
    compute(b.parent);
    const pr = rotation[b.parent]!, pw = position[b.parent]!;
    const rotatedLocal = qrot(pr, b.position);
    position[i] = { x: pw.x + rotatedLocal.x, y: pw.y + rotatedLocal.y, z: pw.z + rotatedLocal.z };
    rotation[i] = qmul(pr, b.rotation);
  }
  for (let i = 0; i < bones.length; i++) compute(i);
  return { position, rotation, children, roots };
}

/** Bone count in each bone's own subtree, itself included. */
export function subtreeSizes(children: readonly number[][]): Int32Array {
  const size = new Int32Array(children.length);
  const sizeOf = (i: number): number => {
    if (size[i]! > 0) return size[i]!;
    let n = 1;
    for (const c of children[i]!) n += sizeOf(c);
    size[i] = n;
    return n;
  };
  for (let i = 0; i < children.length; i++) sizeOf(i);
  return size;
}

/** Hierarchy levels between bone `i` and its root (0 = a root). */
export function boneDepth(bones: readonly TrsBone[], i: number): number {
  let d = 0, cur = i;
  const seen = new Set<number>();
  while (bones[cur]!.parent >= 0 && bones[cur]!.parent < bones.length && !seen.has(cur)) { seen.add(cur); cur = bones[cur]!.parent; d++; }
  return d;
}
