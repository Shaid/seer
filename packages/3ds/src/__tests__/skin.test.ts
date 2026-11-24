import { describe, expect, it } from 'vitest';
import { isSmoothSkinning, toModelSpace, CGFX_SKINNING_SMOOTH, BCH_SKINNING_SMOOTH } from '../skin.js';
import { matApply, matTranslate, type Mat4 } from '../mat4-ctr.js';

// A bone whose bind world matrix puts it at y = 13 (a head bone).
const bone: Mat4 = matTranslate([0, 13, 0]);

/** The pre-fix behaviour: every vertex took its bone's world matrix. */
const oldBehaviour = (pos: [number, number, number]) => matApply(bone, pos);

describe('skinning mode -> model space', () => {
  it('encodes the measured per-container enums', () => {
    // CGFX: 0 none, 1 rigid, 2 smooth. BCH: 0 none, 1 smooth, 2 rigid.
    expect([0, 1, 2].map((m) => isSmoothSkinning('cgfx', m))).toEqual([false, false, true]);
    expect([0, 1, 2].map((m) => isSmoothSkinning('bch', m))).toEqual([false, true, false]);
    expect(CGFX_SKINNING_SMOOTH).toBe(2);
    expect(BCH_SKINNING_SMOOTH).toBe(1);
  });

  it('leaves a smooth vertex (already in model space) where it is', () => {
    // A vertex at the neck, y = 13.2, bound to the head bone at y = 13.
    expect(toModelSpace([0, 13.2, 0], bone, 'cgfx', 2)).toEqual([0, 13.2, 0]);
    expect(toModelSpace([0, 13.2, 0], bone, 'bch', 1)).toEqual([0, 13.2, 0]);
  });

  it('moves a rigid / none vertex (bone-local) by the bone matrix', () => {
    expect(toModelSpace([0, 0.2, 0], bone, 'cgfx', 1)).toEqual([0, 13.2, 0]);
    expect(toModelSpace([0, 0.2, 0], bone, 'bch', 2)).toEqual([0, 13.2, 0]);
    expect(toModelSpace([0, 0.2, 0], bone, 'cgfx', 0)).toEqual([0, 13.2, 0]);
    expect(toModelSpace([0, 0.2, 0], bone, 'bch', 0)).toEqual([0, 13.2, 0]);
  });

  it('null control: the old always-transform rule doubles a smooth vertex (neck at 26.2, not 13.2)', () => {
    expect(oldBehaviour([0, 13.2, 0])[1]).toBeCloseTo(26.2);
    expect(toModelSpace([0, 13.2, 0], bone, 'cgfx', 2)[1]).not.toBeCloseTo(26.2);
    // and the old rule agrees with the new one for rigid vertices, so the test can tell the two apart
    expect(oldBehaviour([0, 0.2, 0])).toEqual(toModelSpace([0, 0.2, 0], bone, 'cgfx', 1));
  });
});
