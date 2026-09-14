import { describe, expect, it } from 'vitest';
import {
  eulerToQuaternion,
  mat4Invert,
  matApply,
  matIdentity,
  matMul,
  matRotX,
  matScale,
  matToQuaternion,
  matTranslate,
} from '../mat4-ctr.js';

describe('mat4-ctr', () => {
  it('matIdentity leaves a point unchanged under matApply', () => {
    expect(matApply(matIdentity(), [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('matTranslate offsets a point', () => {
    expect(matApply(matTranslate([1, 2, 3]), [0, 0, 0])).toEqual([1, 2, 3]);
  });

  it('matScale scales a point', () => {
    expect(matApply(matScale([2, 3, 4]), [1, 1, 1])).toEqual([2, 3, 4]);
  });

  it('a 90° X rotation maps +Y to -Z (this file\'s row-major convention)', () => {
    const [x, y, z] = matApply(matRotX(Math.PI / 2), [0, 1, 0]);
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(0, 10);
    expect(z).toBeCloseTo(-1, 10);
  });

  it('matMul with identity is a no-op', () => {
    const m = matTranslate([5, 6, 7]);
    expect(matMul(m, matIdentity())).toEqual(m);
    expect(matMul(matIdentity(), m)).toEqual(m);
  });

  it('matToQuaternion of the identity matrix is [0,0,0,1]', () => {
    const q = matToQuaternion(matIdentity());
    expect(q[0]).toBeCloseTo(0, 10);
    expect(q[1]).toBeCloseTo(0, 10);
    expect(q[2]).toBeCloseTo(0, 10);
    expect(q[3]).toBeCloseTo(1, 10);
  });

  it('eulerToQuaternion(0,0,0) is the identity quaternion', () => {
    expect(eulerToQuaternion(0, 0, 0)).toEqual([0, 0, 0, 1]);
  });

  it('mat4Invert(identity) is identity', () => {
    expect(mat4Invert(matIdentity())).toEqual(matIdentity());
  });

  it('mat4Invert round-trips a translation', () => {
    const m = matTranslate([3, -4, 5]);
    const inv = mat4Invert(m);
    const roundTrip = matMul(m, inv);
    for (let i = 0; i < 16; i++) expect(roundTrip[i]).toBeCloseTo(matIdentity()[i]!, 8);
  });

  it('mat4Invert falls back to identity for a singular matrix', () => {
    const singular = new Array(16).fill(0);
    expect(mat4Invert(singular)).toEqual(matIdentity());
  });
});
