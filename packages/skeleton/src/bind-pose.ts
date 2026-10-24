/**
 * Anatomical scale estimation and bind-pose reconciliation — the step
 * between "which source bone is which target bone" and "the skin is correct".
 *
 * A retargeting importer computes inverse bind matrices from the TARGET's
 * bind pose and skins the source mesh's vertices — which sit wherever the
 * SOURCE skeleton posed them — to those. That is only correct when every
 * mapped source joint sits at the same world position AND orientation as its
 * target bone, and it generally does not: one rig family is T-posed (arms
 * horizontal) where another is A-posed (arms ~60 deg down), so a T-posed
 * hand can sit ~58 units from the target wrist; a proportionally shorter
 * torso puts the neck ~8 units low; even two rigs of the same character
 * differ by a few percent of overall scale. The mesh then rotates about a
 * pivot that is not its own joint, and a displacement-bounded pose test
 * cannot tell.
 *
 * `buildBindPoseReconciliation` builds, per SOURCE bone, one rigid
 * correction that carries geometry authored in the source's bind pose into
 * the target's bind pose: rotate the bone's segment onto the target
 * segment's direction (shortest arc, accumulated down the hierarchy so
 * twist stays consistent along a chain), apply the uniform scale, and
 * translate so the source joint lands exactly on the target joint. A bone
 * whose segment direction is undefined (a leaf, or a bone with no mapped
 * descendant, or a zero-length segment such as a pelvis_root->hips pair)
 * inherits its nearest mapped ancestor's rotation; an unmapped bone
 * inherits its nearest mapped ancestor's whole correction (the same
 * ancestor `resolveWithAncestorFallback` sends its weights to). The
 * importer then linear-blend-skins every vertex/normal through these
 * corrections using the SOURCE joints/weights BEFORE weights are
 * transferred and IBMs computed — i.e. the mesh is re-posed into the
 * target's bind pose, not assumed to be there already. Parameterized purely
 * by (source skeleton, target skeleton, correspondence, scale): nothing
 * here knows which engine either rig came from.
 *
 * Deliberate limits, reported rather than hidden: (1) segment DIRECTIONS are
 * aligned; roll about the bone axis is whatever the accumulated shortest
 * arcs produce (a T->A swing of the arm in the frontal plane turns a
 * palm-down hand palm-inward, which is what an A-pose expects, but a rig
 * pair with a genuinely different rest roll convention is not corrected);
 * (2) with the default `boneLengths: 'keep'`, a source segment keeps its own
 * length, so where its length differs from the target's the mesh is
 * stretched/compressed across the weight-blend band at the child joint by
 * `segmentResidual` units — `'match'` scales each such segment along its
 * axis instead (only where the ratio is within `maxLengthRatio`, since a
 * hips->spine1 segment 3x longer on one rig than the other would mean
 * scaling the whole pelvis 3x tall, far worse than a 10-unit blend seam).
 */
import { mat4Inverse, mat4Multiply, quatToMatrix } from '@seer-project/gltf';
import type { Skeleton, Quat4, Vec3 } from './types.js';
import {
  boundingHeight, computePose, estimateUniformScale, mat4ApplyPoint, mat4AxisScale, mat4Translation, mat4UniformScale,
  qnormalize, qmul, qrot, quatAngleDeg, quatFromTo, subtreeSizes, vdot, vlen, vsub,
} from './math.js';
import type { BoneCorrespondence } from './correspondence.js';
import { HUMANOID_CORE_BONE_NAMES, sourceCoreBonesFromCorrespondence, type HumanoidCoreBoneName, type HumanoidCoreLabels } from './core-labels.js';

/** Core chains whose summed segment lengths make an anatomical, decoration-free height measure: the spine (hips to head) plus the mean leg (thigh to foot). */
const CORE_SCALE_CHAINS: { name: 'spine' | 'l_leg' | 'r_leg'; bones: HumanoidCoreBoneName[] }[] = [
  { name: 'spine', bones: ['hips', 'spine1', 'spine2', 'neck', 'head'] },
  { name: 'l_leg', bones: ['l_thigh', 'l_shin', 'l_foot'] },
  { name: 'r_leg', bones: ['r_thigh', 'r_shin', 'r_foot'] },
];

export interface CoreScaleEstimate {
  /** target-units-per-source-unit, from summed core-chain segment lengths (spine + mean leg). Falls back to `ySpan` (flagged in `method`) only when fewer than 2 chain segments exist on both rigs. */
  scale: number;
  method: 'core-chain-length' | 'y-span-fallback';
  /** Per chain: summed segment length on each rig over the segments BOTH rigs have, and the segments used. */
  chains: { name: string; segments: number; sourceLength: number; targetLength: number }[];
  /** Least-squares uniform scale over the core bones' world positions (`sum(s.t)/sum(s.s)`), reported for comparison. */
  leastSquares: number;
  /** The `estimateUniformScale` (all-bone Y span) value, reported for comparison — the number that hair and accessory bones contaminate. */
  ySpan: number;
  /** Core names used by at least one chain segment. */
  coreNamesUsed: HumanoidCoreBoneName[];
}

/**
 * Uniform source->target scale from the core skeleton only: the summed
 * lengths of the hips->spine1->spine2->neck->head chain and the mean
 * thigh->shin->foot chain, target over source. Every bone in these chains is
 * a confirmed core bone, so long hair, veils, capes and accessory bones —
 * which extend the all-bone Y span `estimateUniformScale` measures, and on
 * one measured pair skewed its factor to 0.905 against a real bone-for-bone
 * 0.962 — cannot contribute. Only segments present on BOTH rigs count.
 */
export function estimateCoreScale(
  sourceWorld: readonly Vec3[],
  targetWorld: readonly Vec3[],
  sourceCore: Partial<Record<HumanoidCoreBoneName, number>>,
  targetCore: Partial<Record<HumanoidCoreBoneName, number>>,
): CoreScaleEstimate {
  const chains: CoreScaleEstimate['chains'] = [];
  const used = new Set<HumanoidCoreBoneName>();
  let legSrc = 0, legTgt = 0, legs = 0, spineSrc = 0, spineTgt = 0, totalSegments = 0;
  for (const chain of CORE_SCALE_CHAINS) {
    let srcLen = 0, tgtLen = 0, segments = 0;
    for (let i = 0; i + 1 < chain.bones.length; i++) {
      const a = chain.bones[i]!, b = chain.bones[i + 1]!;
      const sa = sourceCore[a], sb = sourceCore[b], ta = targetCore[a], tb = targetCore[b];
      if (sa === undefined || sb === undefined || ta === undefined || tb === undefined) continue;
      const sp = sourceWorld[sa], sq = sourceWorld[sb], tp = targetWorld[ta], tq = targetWorld[tb];
      if (!sp || !sq || !tp || !tq) continue;
      srcLen += vlen(vsub(sq, sp)); tgtLen += vlen(vsub(tq, tp)); segments++;
      used.add(a); used.add(b);
    }
    chains.push({ name: chain.name, segments, sourceLength: srcLen, targetLength: tgtLen });
    if (segments === 0) continue;
    totalSegments += segments;
    if (chain.name === 'spine') { spineSrc += srcLen; spineTgt += tgtLen; } else { legSrc += srcLen; legTgt += tgtLen; legs++; }
  }
  const srcTotal = spineSrc + (legs > 0 ? legSrc / legs : 0);
  const tgtTotal = spineTgt + (legs > 0 ? legTgt / legs : 0);
  const ySpan = estimateUniformScale(sourceWorld, targetWorld);
  let num = 0, den = 0;
  for (const name of HUMANOID_CORE_BONE_NAMES) {
    const si = sourceCore[name], ti = targetCore[name];
    if (si === undefined || ti === undefined) continue;
    const s = sourceWorld[si], t = targetWorld[ti];
    if (!s || !t) continue;
    num += vdot(s, t); den += vdot(s, s);
  }
  const leastSquares = den > 0 ? num / den : ySpan;
  const usable = totalSegments >= 2 && srcTotal > 0 && tgtTotal > 0;
  return {
    scale: usable ? tgtTotal / srcTotal : ySpan,
    method: usable ? 'core-chain-length' : 'y-span-fallback',
    chains, leastSquares, ySpan, coreNamesUsed: [...used],
  };
}

export interface BindPoseReconciliationOptions {
  /** `'keep'` (default): rigid per-bone correction, source bone lengths preserved. `'match'`: additionally scale each bone with a defined segment along that segment so its mapped child lands on the target child joint. */
  boneLengths?: 'keep' | 'match';
  /** For `'match'`: segments whose target/source length ratio falls outside `[1/max, max]` are left rigid (and reported). Default 1.5. */
  maxLengthRatio?: number;
}

export interface BindPoseBoneCorrection {
  sourceIndex: number;
  targetIndex: number;
  /** Target core label, when the target bone has one. */
  name?: HumanoidCoreBoneName;
  /** Local shortest-arc rotation applied on top of the inherited one, degrees (0 when inherited). */
  rotationDeg: number;
  /** Accumulated world rotation applied to this bone's geometry, degrees. */
  totalRotationDeg: number;
  /** The mapped source descendant (and its target) whose joint defines this bone's segment direction; absent when the rotation was inherited. */
  directionChild?: { sourceIndex: number; targetIndex: number };
  /** `|scale * p_source - p_target|` — the review's own per-bone metric, before correction. */
  offsetBefore: number;
  /** The same metric after applying `correction` to `p_source` — 0 by construction, computed as a self-check. */
  offsetAfter: number;
  /** `|scale * segmentLength_source - segmentLength_target|` for the direction segment — the residual blend seam at the child joint under `boneLengths: 'keep'`; 0 under `'match'` when applied. */
  segmentResidual?: number;
  /** target/source segment length ratio (after uniform scale). */
  lengthRatio?: number;
  /** True when `'match'` scaled this segment. */
  lengthMatched: boolean;
  /** True when this bone's rotation was inherited from its nearest mapped ancestor (no usable segment). */
  inheritedRotation: boolean;
}

export interface BindPoseReconciliation {
  scale: number;
  /** One 4x4 (column-major, glTF convention) per SOURCE bone: source bind-pose model space -> target bind-pose model space, uniform scale included. Unmapped bones carry their nearest mapped ancestor's matrix; a bone with no mapped ancestor at all carries plain uniform scale. */
  perSourceBone: Float32Array[];
  /** One row per correspondence entry (every mapped source bone). */
  mapped: BindPoseBoneCorrection[];
  /** Source bones with no entry that inherited an ancestor's correction. */
  inheritedCount: number;
  /** Source bones with no mapped ancestor at all (plain scale only). */
  unreconciledCount: number;
  summary: {
    /** Over `mapped`: mean/max of `offsetBefore` and `offsetAfter`. */
    offsetBefore: { mean: number; max: number };
    offsetAfter: { mean: number; max: number };
    /** Over mapped bones with a segment: mean/max `segmentResidual`. */
    segmentResidual: { mean: number; max: number; count: number };
    /** Mapped bones whose local rotation exceeded 5 degrees. */
    rotatedBones: number;
    maxRotationDeg: number;
  };
}

/**
 * See this module's header doc. `scale` is the uniform source->target unit
 * factor (`estimateCoreScale(...).scale`, or `1` when the rigs share units
 * and proportions exactly). `targetLabels` only annotates the report.
 */
export function buildBindPoseReconciliation(
  source: Skeleton,
  target: Skeleton,
  correspondence: BoneCorrespondence,
  scale: number,
  targetLabels?: HumanoidCoreLabels,
  opts: BindPoseReconciliationOptions = {},
): BindPoseReconciliation {
  const boneLengths = opts.boneLengths ?? 'keep';
  const maxRatio = opts.maxLengthRatio ?? 1.5;
  const sp = computePose(source.bones);
  const tp = computePose(target.bones);
  const height = boundingHeight(tp.position);
  const zeroLen = Math.max(1e-6, 1e-4 * height);
  const targetOf = new Map<number, number>();
  for (const e of correspondence.entries) if (!targetOf.has(e.sourceIndex)) targetOf.set(e.sourceIndex, e.targetIndex);
  const sSize = subtreeSizes(sp.children);
  /** A segment shorter than this on either rig has no usable direction (the same 2%-of-height floor `buildCorrespondenceByCoreLabels`'s deep matcher uses — a face hub 1 unit from the head joint is the same bone on both rigs, its "direction" is not). */
  const minSegment = 0.02 * height;

  /** Nearest mapped descendants of `i` (BFS that stops at the first mapped bone on each branch), largest subtree first. */
  const mappedDescendants = (i: number): number[] => {
    const out: number[] = [];
    const stack = [...sp.children[i]!];
    while (stack.length) {
      const c = stack.pop()!;
      if (targetOf.has(c)) out.push(c);
      else stack.push(...sp.children[c]!);
    }
    return out.sort((a, b) => sSize[b]! - sSize[a]!);
  };
  /** Source bone mapped to target core bone `name`, if any. */
  const sourceCoreByName = targetLabels ? sourceCoreBonesFromCorrespondence(correspondence, targetLabels) : {};
  /**
   * Which mapped descendant defines a bone's segment direction:
   * - a CORE bone follows the anatomical chain (hips -> spine1 -> spine2 ->
   *   neck -> head; clavicle -> upperarm -> forearm -> hand; thigh -> shin ->
   *   foot -> toe; the root/pelvis_root reach for the first of pelvis_root/
   *   hips/spine1 with a real length) and a chain END (head, hands, toes)
   *   inherits its parent's rotation — its orientation is already fixed by
   *   the segment leading INTO it, and hair/finger/decoration descendants
   *   are placed differently on different rigs;
   * - any other bone takes its largest mapped descendant, provided the
   *   segment is at least `minSegment` on both rigs AND continues the
   *   incoming direction (cosine >= 0.5 against the target's own parent
   *   segment), so a lateral decoration cannot steer a chain bone.
   */
  const CORE_CHAIN: Partial<Record<HumanoidCoreBoneName, HumanoidCoreBoneName[]>> = {
    root: ['pelvis_root', 'hips', 'spine1'], pelvis_root: ['hips', 'spine1'], hips: ['spine1'], spine1: ['spine2'], spine2: ['neck'], neck: ['head'], head: [],
    l_clavicle: ['l_upperarm'], l_upperarm: ['l_forearm'], l_forearm: ['l_hand'], l_hand: [],
    r_clavicle: ['r_upperarm'], r_upperarm: ['r_forearm'], r_forearm: ['r_hand'], r_hand: [],
    l_thigh: ['l_shin'], l_shin: ['l_foot'], l_foot: ['l_toe'], l_toe: [],
    r_thigh: ['r_shin'], r_shin: ['r_foot'], r_foot: ['r_toe'], r_toe: [],
  };
  const segmentOk = (si: number, c: number): boolean => {
    const tc = targetOf.get(c)!, ti = targetOf.get(si)!;
    return vlen(vsub(sp.position[c]!, sp.position[si]!)) * scale >= minSegment && vlen(vsub(tp.position[tc]!, tp.position[ti]!)) >= minSegment;
  };
  const directionChildFor = (si: number): number | undefined => {
    const ti = targetOf.get(si)!;
    const coreName = targetLabels?.byIndex.get(ti);
    if (coreName !== undefined && CORE_CHAIN[coreName] !== undefined) {
      for (const childName of CORE_CHAIN[coreName]!) {
        const c = sourceCoreByName[childName];
        if (c !== undefined && targetOf.get(c) === targetLabels!.byName[childName] && segmentOk(si, c)) return c;
      }
      return undefined;
    }
    // Incoming direction on the target: from the nearest mapped ancestor at a different position.
    let incoming: Vec3 | undefined;
    for (let a = mappedAncestor(si); a >= 0; a = mappedAncestor(a)) {
      const d = vsub(tp.position[ti]!, tp.position[targetOf.get(a)!]!);
      if (vlen(d) >= minSegment) { incoming = { x: d.x / vlen(d), y: d.y / vlen(d), z: d.z / vlen(d) }; break; }
    }
    for (const c of mappedDescendants(si)) {
      if (!segmentOk(si, c)) continue;
      if (incoming) {
        const d = vsub(tp.position[targetOf.get(c)!]!, tp.position[ti]!);
        if (vdot(d, incoming) / vlen(d) < 0.5) continue;
      }
      return c;
    }
    return undefined;
  };
  /** Nearest mapped strict ancestor of `i`, or -1. */
  const mappedAncestor = (i: number): number => {
    let cur = source.bones[i]!.parent;
    const seen = new Set<number>();
    while (cur >= 0 && cur < source.bones.length && !seen.has(cur)) {
      if (targetOf.has(cur)) return cur;
      seen.add(cur);
      cur = source.bones[cur]!.parent;
    }
    return -1;
  };

  // Parent-first order over the source hierarchy.
  const order: number[] = [];
  const visit = (i: number): void => { order.push(i); for (const c of sp.children[i]!) visit(c); };
  for (const r of sp.roots) visit(r);

  const rotation = new Array<Quat4>(source.bones.length);          // accumulated world rotation per mapped bone
  const perSourceBone = new Array<Float32Array>(source.bones.length);
  const mapped: BindPoseBoneCorrection[] = [];
  const scaleM = mat4UniformScale(scale);
  let inheritedCount = 0, unreconciledCount = 0;

  for (const si of order) {
    const ti = targetOf.get(si);
    if (ti === undefined) {
      const anc = mappedAncestor(si);
      if (anc >= 0) { perSourceBone[si] = perSourceBone[anc]!; inheritedCount++; } else { perSourceBone[si] = scaleM; unreconciledCount++; }
      continue;
    }
    const anc = mappedAncestor(si);
    const parentRot: Quat4 = anc >= 0 ? rotation[anc]! : { x: 0, y: 0, z: 0, w: 1 };
    const pSrc = sp.position[si]!, pTgt = tp.position[ti]!;

    // Segment direction: this bone -> the descendant `directionChildFor` picks, on both rigs.
    let localRot: Quat4 = { x: 0, y: 0, z: 0, w: 1 };
    let directionChild: BindPoseBoneCorrection['directionChild'];
    let segmentResidual: number | undefined, lengthRatio: number | undefined, srcDir: Vec3 | undefined;
    let inheritedRotation = true;
    const c = directionChildFor(si);
    if (c !== undefined) {
      const tc = targetOf.get(c)!;
      const sd = vsub(sp.position[c]!, pSrc), td = vsub(tp.position[tc]!, tp.position[ti]!);
      const sl = vlen(sd) * scale, tl = vlen(td);
      if (sl >= zeroLen && tl >= zeroLen) {
        const sUnit = { x: sd.x / vlen(sd), y: sd.y / vlen(sd), z: sd.z / vlen(sd) };
        const rotatedSrc = qrot(parentRot, sUnit);
        const tUnit = { x: td.x / tl, y: td.y / tl, z: td.z / tl };
        localRot = quatFromTo(rotatedSrc, tUnit);
        directionChild = { sourceIndex: c, targetIndex: tc };
        segmentResidual = Math.abs(sl - tl);
        lengthRatio = tl / sl;
        srcDir = sUnit;
        inheritedRotation = false;
      }
    }
    const worldRot = qnormalize(qmul(localRot, parentRot));
    rotation[si] = worldRot;

    let lengthMatched = false;
    let inner = scaleM;
    if (boneLengths === 'match' && srcDir && lengthRatio !== undefined && lengthRatio >= 1 / maxRatio && lengthRatio <= maxRatio) {
      inner = mat4Multiply(scaleM, mat4AxisScale(srcDir, lengthRatio));
      lengthMatched = true;
      segmentResidual = 0;
    }
    const R = quatToMatrix(worldRot);
    const correction = mat4Multiply(mat4Translation(pTgt.x, pTgt.y, pTgt.z), mat4Multiply(R, mat4Multiply(inner, mat4Translation(-pSrc.x, -pSrc.y, -pSrc.z))));
    perSourceBone[si] = correction;

    const after = mat4ApplyPoint(correction, pSrc);
    mapped.push({
      sourceIndex: si, targetIndex: ti, name: targetLabels?.byIndex.get(ti),
      rotationDeg: quatAngleDeg(localRot), totalRotationDeg: quatAngleDeg(worldRot), directionChild,
      offsetBefore: Math.hypot(pSrc.x * scale - pTgt.x, pSrc.y * scale - pTgt.y, pSrc.z * scale - pTgt.z),
      offsetAfter: Math.hypot(after.x - pTgt.x, after.y - pTgt.y, after.z - pTgt.z),
      segmentResidual, lengthRatio, lengthMatched, inheritedRotation,
    });
  }
  for (let i = 0; i < source.bones.length; i++) if (!perSourceBone[i]) { perSourceBone[i] = scaleM; unreconciledCount++; }

  const stat = (xs: number[]): { mean: number; max: number } => ({ mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, max: xs.length ? Math.max(...xs) : 0 });
  const residuals = mapped.filter((m) => m.segmentResidual !== undefined).map((m) => m.segmentResidual!);
  return {
    scale, perSourceBone, mapped, inheritedCount, unreconciledCount,
    summary: {
      offsetBefore: stat(mapped.map((m) => m.offsetBefore)),
      offsetAfter: stat(mapped.map((m) => m.offsetAfter)),
      segmentResidual: { ...stat(residuals), count: residuals.length },
      rotatedBones: mapped.filter((m) => m.rotationDeg > 5).length,
      maxRotationDeg: mapped.reduce((a, m) => Math.max(a, m.totalRotationDeg), 0),
    },
  };
}

/**
 * Linear-blend `positions`/`normals` through `perSourceBone` corrections
 * using each vertex's SOURCE joints/weights — re-poses geometry authored in
 * the source bind pose into the target bind pose. Normals use the
 * inverse-transpose of each correction's linear part (exact for rigid +
 * uniform scale; also right for `'match'`'s axis scale) and are
 * renormalized after blending.
 */
export function applyBindPoseReconciliation(
  rec: BindPoseReconciliation,
  positions: Float32Array,
  normals: Float32Array | undefined,
  sourceJoints: Uint32Array,
  weights: Float32Array,
  count: number,
): { positions: Float32Array; normals: Float32Array | undefined } {
  const outP = new Float32Array(count * 3);
  const outN = normals ? new Float32Array(count * 3) : undefined;
  const normalMats = new Map<Float32Array, Float32Array>();
  const normalMatFor = (m: Float32Array): Float32Array => {
    let nm = normalMats.get(m);
    if (nm) return nm;
    const lin = new Float32Array(16);
    lin[0] = m[0]!; lin[1] = m[1]!; lin[2] = m[2]!; lin[4] = m[4]!; lin[5] = m[5]!; lin[6] = m[6]!; lin[8] = m[8]!; lin[9] = m[9]!; lin[10] = m[10]!; lin[15] = 1;
    const inv = mat4Inverse(lin);
    nm = new Float32Array(16);
    // transpose of the 3x3 part
    nm[0] = inv[0]!; nm[1] = inv[4]!; nm[2] = inv[8]!; nm[4] = inv[1]!; nm[5] = inv[5]!; nm[6] = inv[9]!; nm[8] = inv[2]!; nm[9] = inv[6]!; nm[10] = inv[10]!; nm[15] = 1;
    normalMats.set(m, nm);
    return nm;
  };
  for (let vi = 0; vi < count; vi++) {
    const px = positions[vi * 3]!, py = positions[vi * 3 + 1]!, pz = positions[vi * 3 + 2]!;
    const nx = normals?.[vi * 3] ?? 0, ny = normals?.[vi * 3 + 1] ?? 0, nz = normals?.[vi * 3 + 2] ?? 0;
    let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[vi * 4 + k] ?? 0;
      if (w <= 0) continue;
      const m = rec.perSourceBone[sourceJoints[vi * 4 + k]!];
      if (!m) continue;
      wsum += w;
      ax += w * (m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!);
      ay += w * (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!);
      az += w * (m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!);
      if (outN) {
        const nm = normalMatFor(m);
        bx += w * (nm[0]! * nx + nm[4]! * ny + nm[8]! * nz);
        by += w * (nm[1]! * nx + nm[5]! * ny + nm[9]! * nz);
        bz += w * (nm[2]! * nx + nm[6]! * ny + nm[10]! * nz);
      }
    }
    if (wsum <= 0) {
      // No weighted source bone at all: plain uniform scale, so the vertex at least lands in target units.
      outP[vi * 3] = px * rec.scale; outP[vi * 3 + 1] = py * rec.scale; outP[vi * 3 + 2] = pz * rec.scale;
      if (outN) { outN[vi * 3] = nx; outN[vi * 3 + 1] = ny; outN[vi * 3 + 2] = nz; }
      continue;
    }
    outP[vi * 3] = ax / wsum; outP[vi * 3 + 1] = ay / wsum; outP[vi * 3 + 2] = az / wsum;
    if (outN) {
      const l = Math.hypot(bx, by, bz) || 1;
      outN[vi * 3] = bx / l; outN[vi * 3 + 1] = by / l; outN[vi * 3 + 2] = bz / l;
    }
  }
  return { positions: outP, normals: outN };
}
