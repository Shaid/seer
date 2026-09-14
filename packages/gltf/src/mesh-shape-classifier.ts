/**
 * Geometry-only "is this prop weapon-shaped" heuristic — reads nothing but a
 * built GLB's own POSITION accessors via `reader.ts`, so any project's prop
 * corpus can reuse it.
 *
 * ## Method
 *
 * For each glTF primitive with a POSITION attribute, compute its local-space
 * axis-aligned bounding box (untransformed by any node — see below for why)
 * and sort its three extents into `long >= mid >= short`. The primitive with
 * the most vertices is taken as the package's representative shape (a
 * package can combine several unrelated mesh records, and the biggest
 * submesh dominates what a viewer actually sees). A representative is
 * classified `'weapon'` when:
 *
 * - `long/mid >= WEAPON_ASPECT_THRESHOLD` — swords/daggers/spears/lances/
 *   bows read as long, thin rods or curved limbs, sharply higher than round
 *   shields, barrels, statues, books, food props, etc.
 * - `WEAPON_MIN_LENGTH <= long <= WEAPON_MAX_LENGTH` — excludes both tiny
 *   degenerate slivers and (more importantly) huge elongated environment
 *   geometry (bridges, fences, terrain ridges — real corpus items up to
 *   27,722 units long with aspect ratios as high as 11.8, which the aspect
 *   gate alone does NOT exclude).
 *
 * Local-space (not world/node-transformed) bounding boxes are used
 * deliberately: a node transform that rotates a weapon to a diagonal
 * carry/hand-attachment angle would shrink its *world*-space AABB's
 * elongation, understating the very shape signal this heuristic depends on.
 * The mesh's own authored local space is where "a sword is modeled long
 * and thin" is actually true.
 *
 * ## Calibration and known limitation
 *
 * These thresholds were picked from one real game's prop corpus (Fire
 * Emblem Warriors: Three Hopes), not guessed: `WEAPON_ASPECT_THRESHOLD=3.0`
 * sat in a clean structural gap in that corpus — every sampled prop with
 * `long` in [15,500) and aspect in [1.0,1.5) rendered as an unambiguous
 * non-weapon (food, baskets, books), the whole [3.0,5.0) band sampled 12/12
 * real weapons (swords/daggers/maces/quivers), and the ambiguous [2.0,3.0)
 * band mixed real weapons (mostly wide-headed axes/bows/polearms) with
 * non-weapons of a similarly elongated silhouette (barrels, kite shields,
 * boats, keys, gauntlets, decorative statues) with NO secondary bbox signal
 * (mid/short ratio, absolute scale) found that reliably separated them.
 * Setting the threshold at 3.0 instead of ~2.2 trades recall for precision:
 * on a 41-item hand-verified sample from that one game, this found **zero
 * false positives** (every real non-weapon prop stayed classified `'prop'`)
 * at the cost of **6/18 real weapons misclassified as `'prop'`** (all
 * wide-headed axes/a bow/a paired-blade polearm, all in the ambiguous
 * 2.1-2.9 aspect band) — 100% precision, 66.7% recall, 85.4% overall
 * accuracy on that sample. `WEAPON_MAX_LENGTH=1000` was picked from a
 * confirmed real gap in the same corpus: the largest real weapon sampled (a
 * lance/javelin) was 592 units long, and the smallest real false-positive-
 * shaped environment prop above that (a terrain patch, ~140,000 units) was
 * nowhere close — 1000 sits with wide margin on both sides.
 *
 * **These numbers are calibrated against exactly one game's art style and
 * unit scale.** A different project should re-derive them against its own
 * corpus rather than assume this threshold transfers — treat the defaults
 * as a documented starting point, not a universal constant.
 */
import { parseGLB, readAccessor, type GlbFile } from './reader.js';

/** See this file's doc comment for how these were calibrated, and against what one corpus. */
export const WEAPON_ASPECT_THRESHOLD = 3.0;
export const WEAPON_MIN_LENGTH = 10;
export const WEAPON_MAX_LENGTH = 1000;

export interface PrimitiveBBox {
  vertexCount: number;
  /** Sorted ascending: `[short, mid, long]`. */
  extents: [number, number, number];
}

/** Every glTF primitive's local-space POSITION bounding box + vertex count, across every mesh in `glb`. Degenerate (all-zero-extent, e.g. a single-point placeholder) primitives are skipped. */
export function primitiveBBoxes(glb: GlbFile): PrimitiveBBox[] {
  const out: PrimitiveBBox[] = [];
  for (const mesh of glb.json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const posIdx = prim.attributes.POSITION;
      if (posIdx === undefined) continue;
      const { values, count } = readAccessor(glb, posIdx);
      if (count === 0) continue;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < count; i++) {
        const x = values[i * 3]!, y = values[i * 3 + 1]!, z = values[i * 3 + 2]!;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
      if (Math.max(dx, dy, dz) <= 1e-3) continue; // degenerate placeholder
      const extents = [dx, dy, dz].sort((a, b) => a - b) as [number, number, number];
      out.push({ vertexCount: count, extents });
    }
  }
  return out;
}

/**
 * Classifies a built GLB's dominant (most-vertices) primitive as weapon-
 * shaped or not — see this file's doc comment for the method and
 * calibration. Returns `false` (not a weapon) for a GLB with no non-
 * degenerate primitives at all.
 */
export function isWeaponShaped(glbBytes: Uint8Array | ArrayBuffer): boolean {
  const glb = parseGLB(glbBytes);
  const boxes = primitiveBBoxes(glb);
  if (boxes.length === 0) return false;
  const rep = boxes.reduce((a, b) => (b.vertexCount > a.vertexCount ? b : a));
  const [short, mid, long] = rep.extents;
  void short;
  if (long < WEAPON_MIN_LENGTH || long > WEAPON_MAX_LENGTH) return false;
  if (mid <= 1e-6) return long / 1e-6 >= WEAPON_ASPECT_THRESHOLD; // avoid div-by-zero on a flat sliver
  return long / mid >= WEAPON_ASPECT_THRESHOLD;
}
