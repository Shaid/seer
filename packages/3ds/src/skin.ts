/**
 * Skinning-mode semantics shared by the CGFX and BCH mesh decoders.
 *
 * A face group (CGFX: SOBJ face-group `skinningMode`; BCH: face-header word 0) says what space its vertices are in:
 *
 * - **rigid**: positions are local to the bone named by the vertex's node-list index. The decoder places them in
 *   model space by applying that bone's accumulated bind matrix.
 * - **smooth**: positions are *already* in model (bind) space. Blend weights and bone indices only matter for animation.
 *   Applying the bone's world matrix again moves a vertex at bone position p to ~2p (long necks, floating feet).
 * - **none**: no blending; the face group's node list still names the one bone it hangs on, and the positions are local to it
 *   (measured on Awakening's built-in head parts: the vertices sit near the origin, the bone far from it).
 *
 * The enum values differ per container (measured, docs/3ds-formats.md section 11.4):
 * CGFX 0 none / 1 rigid / 2 smooth; BCH 0 none / 1 smooth / 2 rigid.
 */
import { matApply, type Mat4 } from './mat4-ctr.js';

export const CGFX_SKINNING_SMOOTH = 2;
export const BCH_SKINNING_SMOOTH = 1;

/** True when a face group's vertices are already in model space (smooth skinning) in the given container. */
export function isSmoothSkinning(container: 'cgfx' | 'bch', skinningMode: number): boolean {
  return skinningMode === (container === 'cgfx' ? CGFX_SKINNING_SMOOTH : BCH_SKINNING_SMOOTH);
}

/** A vertex position in model (bind) space: bone-local positions get the bone's world matrix, smooth ones are left alone. */
export function toModelSpace(
  pos: [number, number, number],
  boneWorld: Mat4,
  container: 'cgfx' | 'bch',
  skinningMode: number,
): [number, number, number] {
  return isSmoothSkinning(container, skinningMode) ? pos : matApply(boneWorld, pos);
}
