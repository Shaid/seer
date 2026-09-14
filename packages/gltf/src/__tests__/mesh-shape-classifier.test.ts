import { describe, it, expect } from 'vitest';
import { newBuilder, pushView, pushAccessor, assembleGLB, ARRAY_BUFFER } from '../builder.js';
import { parseGLB, FLOAT } from '../reader.js';
import { primitiveBBoxes, isWeaponShaped, WEAPON_ASPECT_THRESHOLD, WEAPON_MIN_LENGTH, WEAPON_MAX_LENGTH } from '../mesh-shape-classifier.js';

/** Builds a minimal one-primitive GLB whose POSITION vertices span exactly `[dx, dy, dz]` (a box from the origin to `(dx,dy,dz)`, plus one extra vertex at the origin so a degenerate 2-point box still has >0 vertices). */
function buildBoxGLB(dx: number, dy: number, dz: number): ArrayBuffer {
  const builder = newBuilder();
  const positions = new Float32Array([0, 0, 0, dx, dy, dz]);
  const view = pushView(builder, positions, ARRAY_BUFFER);
  const posAccessor = pushAccessor(builder, view, 'VEC3', FLOAT, 2);
  builder.json.meshes.push({ primitives: [{ attributes: { POSITION: posAccessor } }] });
  builder.json.nodes.push({ mesh: 0 });
  builder.json.scenes[0]!.nodes.push(0);
  return assembleGLB(builder);
}

describe('mesh-shape-classifier', () => {
  describe('primitiveBBoxes', () => {
    it('computes the local-space extent of a single primitive', () => {
      const glb = buildBoxGLB(10, 20, 30);
      const boxes = primitiveBBoxes(parseGLB(glb));
      expect(boxes).toHaveLength(1);
      expect(boxes[0]!.vertexCount).toBe(2);
      expect(boxes[0]!.extents).toEqual([10, 20, 30]);
    });

    it('skips a degenerate (all-zero-extent) primitive', () => {
      const glb = buildBoxGLB(0, 0, 0);
      expect(primitiveBBoxes(parseGLB(glb))).toHaveLength(0);
    });
  });

  describe('isWeaponShaped', () => {
    it('classifies a long thin rod (a sword/spear silhouette) as a weapon', () => {
      // long=200, mid=5, short=4 -> aspect 40, well past the threshold and inside the length band.
      expect(isWeaponShaped(buildBoxGLB(200, 5, 4))).toBe(true);
    });

    it('classifies a near-cube (a barrel/box/statue silhouette) as not a weapon', () => {
      expect(isWeaponShaped(buildBoxGLB(100, 95, 90))).toBe(false);
    });

    it('classifies a flat disc-like extent (a round shield) as not a weapon', () => {
      // long == mid (aspect 1), short thin -> a flat circular/disc silhouette, not a rod.
      expect(isWeaponShaped(buildBoxGLB(100, 100, 15))).toBe(false);
    });

    it("rejects a shape below the aspect threshold even at weapon-plausible length (a wide-headed axe false negative — see this module's doc comment)", () => {
      const aspect = WEAPON_ASPECT_THRESHOLD - 0.5;
      expect(isWeaponShaped(buildBoxGLB(100, 100 / aspect, 100 / aspect / 4))).toBe(false);
    });

    it('accepts a shape right at the aspect threshold', () => {
      expect(isWeaponShaped(buildBoxGLB(100, 100 / WEAPON_ASPECT_THRESHOLD, 5))).toBe(true);
    });

    it('rejects a too-long, high-aspect shape (a bridge/fence/terrain ridge, not a weapon)', () => {
      expect(isWeaponShaped(buildBoxGLB(WEAPON_MAX_LENGTH + 1000, 50, 40))).toBe(false);
    });

    it('rejects a too-short, high-aspect sliver', () => {
      expect(isWeaponShaped(buildBoxGLB(WEAPON_MIN_LENGTH - 1, 1, 0.5))).toBe(false);
    });

    it('accepts a shape at the long-length boundary', () => {
      expect(isWeaponShaped(buildBoxGLB(WEAPON_MAX_LENGTH, 10, 5))).toBe(true);
    });

    it('returns false for a GLB with no primitives at all', () => {
      const builder = newBuilder();
      builder.json.nodes.push({ name: 'empty' });
      builder.json.scenes[0]!.nodes.push(0);
      const glb = assembleGLB(builder);
      expect(isWeaponShaped(glb)).toBe(false);
    });

    it('picks the largest (by vertex count) primitive as representative when a GLB combines several', () => {
      // Two meshes: a small weapon-shaped one and a bigger, dominant blob-shaped one.
      const builder = newBuilder();
      const weaponPos = new Float32Array([0, 0, 0, 200, 5, 4]);
      const weaponView = pushView(builder, weaponPos, ARRAY_BUFFER);
      const weaponAccessor = pushAccessor(builder, weaponView, 'VEC3', FLOAT, 2);
      builder.json.meshes.push({ primitives: [{ attributes: { POSITION: weaponAccessor } }] });

      // A bigger (more "vertices") blob-shaped primitive — repeat the same two corner points many times.
      const blobPoints: number[] = [];
      for (let i = 0; i < 50; i++) blobPoints.push(0, 0, 0, 100, 95, 90);
      const blobPos = new Float32Array(blobPoints);
      const blobView = pushView(builder, blobPos, ARRAY_BUFFER);
      const blobAccessor = pushAccessor(builder, blobView, 'VEC3', FLOAT, blobPoints.length / 3);
      builder.json.meshes.push({ primitives: [{ attributes: { POSITION: blobAccessor } }] });

      builder.json.nodes.push({ mesh: 0 }, { mesh: 1 });
      builder.json.scenes[0]!.nodes.push(0, 1);
      const glb = assembleGLB(builder);
      // The blob (100 vertices) dominates over the weapon (2 vertices) -> classified as not-a-weapon.
      expect(isWeaponShaped(glb)).toBe(false);
    });
  });
});
