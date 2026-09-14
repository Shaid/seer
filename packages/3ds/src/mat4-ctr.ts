/**
 * Row-major 4×4 matrix helpers shared by `bch.ts` and `cgfx.ts` for
 * rigid-skinning bind-pose transforms and Euler→quaternion conversion for
 * glTF export.
 *
 * This file exists because `bch.ts` and `cgfx.ts` (Ohana3DS-Rebirth ports of
 * two independent 3DS model containers) used to carry byte-identical copies
 * of `matMul`/`matApply`/`matIdentity`/`matScale`/`matRotX`/`matRotY`/
 * `matRotZ`/`matTranslate`/`matToQuaternion`/`eulerToQuaternion`/
 * `mat4Invert` — confirmed still identical at the point this package was
 * extracted (2026-09-14) — plus overlapping exported names
 * (`eulerToQuaternion`/`mat4Invert`) that would collide in a flat package
 * barrel. Both files now import these from here instead of duplicating them.
 *
 * `accumulateBone` is deliberately NOT here: bch.ts's and cgfx.ts's versions
 * take differently-shaped bone-array types (`BchBone`/local `Bone` vs.
 * `CgfxBone`) and, as of this extraction, have diverged in behavior —
 * bch.ts's guards against an undefined bone entry and a self-referential or
 * out-of-range parent index (`if (!b) return matIdentity()`, and a
 * `parent < bones.length && parent !== index` bounds check before recursing),
 * while cgfx.ts's has neither guard. That's a real behavioral difference
 * (not just a typing one), so each file keeps its own `accumulateBone`
 * rather than being forced onto a shared implementation that would either
 * silently add or silently drop a safety check on one side.
 */

/** Row-major flat matrix: element(row i, col j) = m[i*4+j]. */
export type Mat4 = number[];

export function matMul(a: Mat4, b: Mat4): Mat4 {
  const c = new Array(16).fill(0);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      c[i + j * 4] =
        a[i]! * b[j * 4]! +
        a[i + 4]! * b[j * 4 + 1]! +
        a[i + 8]! * b[j * 4 + 2]! +
        a[i + 12]! * b[j * 4 + 3]!;
    }
  }
  return c;
}

export function matApply(m: Mat4, v: [number, number, number]): [number, number, number] {
  return [
    v[0] * m[0]! + v[1] * m[1]! + v[2] * m[2]! + m[3]!,
    v[0] * m[4]! + v[1] * m[5]! + v[2] * m[6]! + m[7]!,
    v[0] * m[8]! + v[1] * m[9]! + v[2] * m[10]! + m[11]!,
  ];
}

export function matIdentity(): Mat4 {
  const m = new Array(16).fill(0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

export function matScale(s: [number, number, number]): Mat4 {
  const m = matIdentity();
  m[0] = s[0];
  m[5] = s[1];
  m[10] = s[2];
  return m;
}

export function matRotX(a: number): Mat4 {
  const m = matIdentity();
  m[5] = Math.cos(a);
  m[6] = Math.sin(a);
  m[9] = -Math.sin(a);
  m[10] = Math.cos(a);
  return m;
}

export function matRotY(a: number): Mat4 {
  const m = matIdentity();
  m[0] = Math.cos(a);
  m[2] = -Math.sin(a);
  m[8] = Math.sin(a);
  m[10] = Math.cos(a);
  return m;
}

export function matRotZ(a: number): Mat4 {
  const m = matIdentity();
  m[0] = Math.cos(a);
  m[1] = -Math.sin(a);
  m[4] = Math.sin(a);
  m[5] = Math.cos(a);
  return m;
}

export function matTranslate(t: [number, number, number]): Mat4 {
  const m = matIdentity();
  m[3] = t[0];
  m[7] = t[1];
  m[11] = t[2];
  return m;
}

/**
 * Row-major rotation matrix → quaternion [x,y,z,w] (standard "trace"
 * method).
 */
export function matToQuaternion(m: readonly number[]): [number, number, number, number] {
  const m00 = m[0]!,
    m01 = m[1]!,
    m02 = m[2]!;
  const m10 = m[4]!,
    m11 = m[5]!,
    m12 = m[6]!;
  const m20 = m[8]!,
    m21 = m[9]!,
    m22 = m[10]!;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

/** Bind-pose Euler XYZ (this file's `matRotX*matRotY*matRotZ` composition) → quaternion. */
export function eulerToQuaternion(
  rx: number,
  ry: number,
  rz: number,
): [number, number, number, number] {
  return matToQuaternion(matMul(matMul(matRotX(rx), matRotY(ry)), matRotZ(rz)));
}

/**
 * General 4x4 matrix inverse (cofactor/adjugate via 2x2 sub-determinants of
 * the top/bottom row pairs) — used for inverseBindMatrices. Written generically
 * against a `get(row, col) = m[row*4+col]` accessor (this file's row-major
 * `Mat4` convention, confirmed by `matApply`) rather than adapted from a
 * column-major reference snippet, to avoid a row/col transposition bug.
 */
export function mat4Invert(m: readonly number[]): number[] {
  const e = (r: number, c: number): number => m[r * 4 + c]!;

  const s0 = e(0, 0) * e(1, 1) - e(1, 0) * e(0, 1);
  const s1 = e(0, 0) * e(1, 2) - e(1, 0) * e(0, 2);
  const s2 = e(0, 0) * e(1, 3) - e(1, 0) * e(0, 3);
  const s3 = e(0, 1) * e(1, 2) - e(1, 1) * e(0, 2);
  const s4 = e(0, 1) * e(1, 3) - e(1, 1) * e(0, 3);
  const s5 = e(0, 2) * e(1, 3) - e(1, 2) * e(0, 3);

  const c5 = e(2, 2) * e(3, 3) - e(3, 2) * e(2, 3);
  const c4 = e(2, 1) * e(3, 3) - e(3, 1) * e(2, 3);
  const c3 = e(2, 1) * e(3, 2) - e(3, 1) * e(2, 2);
  const c2 = e(2, 0) * e(3, 3) - e(3, 0) * e(2, 3);
  const c1 = e(2, 0) * e(3, 2) - e(3, 0) * e(2, 2);
  const c0 = e(2, 0) * e(3, 1) - e(3, 0) * e(2, 1);

  const det = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
  if (Math.abs(det) < 1e-12) return matIdentity();
  const invDet = 1 / det;

  const out = new Array(16).fill(0);
  out[0 * 4 + 0] = (e(1, 1) * c5 - e(1, 2) * c4 + e(1, 3) * c3) * invDet;
  out[0 * 4 + 1] = (-e(0, 1) * c5 + e(0, 2) * c4 - e(0, 3) * c3) * invDet;
  out[0 * 4 + 2] = (e(3, 1) * s5 - e(3, 2) * s4 + e(3, 3) * s3) * invDet;
  out[0 * 4 + 3] = (-e(2, 1) * s5 + e(2, 2) * s4 - e(2, 3) * s3) * invDet;

  out[1 * 4 + 0] = (-e(1, 0) * c5 + e(1, 2) * c2 - e(1, 3) * c1) * invDet;
  out[1 * 4 + 1] = (e(0, 0) * c5 - e(0, 2) * c2 + e(0, 3) * c1) * invDet;
  out[1 * 4 + 2] = (-e(3, 0) * s5 + e(3, 2) * s2 - e(3, 3) * s1) * invDet;
  out[1 * 4 + 3] = (e(2, 0) * s5 - e(2, 2) * s2 + e(2, 3) * s1) * invDet;

  out[2 * 4 + 0] = (e(1, 0) * c4 - e(1, 1) * c2 + e(1, 3) * c0) * invDet;
  out[2 * 4 + 1] = (-e(0, 0) * c4 + e(0, 1) * c2 - e(0, 3) * c0) * invDet;
  out[2 * 4 + 2] = (e(3, 0) * s4 - e(3, 1) * s2 + e(3, 3) * s0) * invDet;
  out[2 * 4 + 3] = (-e(2, 0) * s4 + e(2, 1) * s2 - e(2, 3) * s0) * invDet;

  out[3 * 4 + 0] = (-e(1, 0) * c3 + e(1, 1) * c1 - e(1, 2) * c0) * invDet;
  out[3 * 4 + 1] = (e(0, 0) * c3 - e(0, 1) * c1 + e(0, 2) * c0) * invDet;
  out[3 * 4 + 2] = (-e(3, 0) * s3 + e(3, 1) * s1 - e(3, 2) * s0) * invDet;
  out[3 * 4 + 3] = (e(2, 0) * s3 - e(2, 1) * s1 + e(2, 2) * s0) * invDet;

  return out;
}
