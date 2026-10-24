/**
 * Match two humanoid rigs' core bones by the structural LABEL
 * `labelHumanoidCoreBones` gives each of them, then match every other bone
 * within its nearest core anchor's subtree with an optimal per-fork
 * assignment.
 *
 * Why this and not `./shallow.js`'s purely geometric pass: on two real rigs
 * that pass already paired every leg bone correctly, and its single core
 * mismatch (neck -> r_clavicle) came from the GREEDY assignment at a
 * >8-child chest fork, not from any signal. Its apparent "leg failures" were
 * twist helpers, skirt leaves and cape anchors hanging off the legs and
 * hips — decoration, whose bind-pose length ratios legitimately differ (a
 * thigh twist helper sits 24% down the thigh on one rig and 50% down on the
 * other; same axis line, different fraction).
 *
 * So this pass names the ~23 core bones on EACH rig from structure alone,
 * matches core bones by name, and only then matches the deep bones — per
 * confirmed core-anchor subtree, with an optimal assignment, each pair
 * accepted only when its anchor-relative geometry agrees. Anything not
 * accepted is left OUT of the table on purpose so it falls to
 * `resolveWithAncestorFallback`, and is reported, never silently mapped.
 */
import type { Skeleton, Vec3 } from './types.js';
import {
  boundingHeight, computePose, estimateUniformScale, qdot, subtreeSizes, vdot, vlen, vsub,
  type Pose,
} from './math.js';
import { assignOptimal } from './assignment.js';
import { POSITION_TOLERANCE_FRACTION, type BoneCorrespondence, type BoneCorrespondenceEntry } from './correspondence.js';
import { HUMANOID_CORE_BONE_NAMES, labelHumanoidCoreBones, type HumanoidCoreBoneName, type HumanoidCoreLabels } from './core-labels.js';

export interface CoreLabelSignals {
  positionAgree: boolean;
  rotationAgree: boolean;
  /** Parent->bone length ratio (scaled) vs 1, within tolerance; vacuously true for zero-length bones. */
  lengthRatioAgree: boolean;
  /** For `l_*`/`r_*` names: both rigs' pairs mirror across X within tolerance; vacuously true otherwise. */
  symmetryAgree: boolean;
}

export interface CoreLabelPairReport {
  name: HumanoidCoreBoneName;
  sourceIndex: number;
  targetIndex: number;
  signals: CoreLabelSignals;
  positionDistance: number;
  rotationAngleDeg: number;
  lengthRatio: number;
  ok: boolean;
}

export interface DeepBoneSignals {
  /** Anchor-relative (scaled) world position within tolerance. */
  positionAgree: boolean;
  /** Parent->child offset direction agrees (cosine >= threshold). */
  directionAgree: boolean;
  rotationAgree: boolean;
  /**
   * Both bones are leaf "axis helpers": no children, and their offset from
   * the parent lies ALONG the parent's own main-chain axis (a twist/roll
   * helper partway down a limb, or a zero-offset helper sitting on the
   * joint). Such a bone rolls about its parent's axis line, so WHERE along
   * that line it sits (24% down the thigh on one measured rig vs 50% on
   * the other) doesn't change the motion it imparts — `positionAgree` is the
   * wrong test for this class, and this signal stands in for it. Reported
   * separately so a reviewer can see exactly which pairs were accepted on
   * this basis.
   */
  axisHelper: boolean;
  /** Subtree bone counts agree within tolerance (a hub with 11 children only pairs with a hub, not a leaf). */
  subtreeAgree: boolean;
}

export interface DeepBonePairReport {
  sourceIndex: number;
  targetIndex: number;
  anchor: HumanoidCoreBoneName;
  signals: DeepBoneSignals;
  positionDistance: number;
  rotationAngleDeg: number;
  accepted: boolean;
}

export interface CoreLabelCorrespondenceOptions {
  positionToleranceFraction?: number;
  rotationToleranceRadians?: number;
  lengthRatioToleranceFraction?: number;
  /** Deep-bone anchor-relative position tolerance, as a fraction of the target's height (floor). Default 0.03. */
  deepPositionToleranceFraction?: number;
  /** Deep-bone anchor-relative position tolerance, as a fraction of the bone's own distance from its anchor (scales with how far out on a chain it sits). Default 0.25. */
  deepPositionToleranceRelative?: number;
  /** Min cosine between parent->child offset directions for `directionAgree`. Default 0.7. */
  deepDirectionMinCosine?: number;
  /** Max fractional subtree-size difference for `subtreeAgree` (|a-b|/max(a,b)). Default 0.5. */
  deepSubtreeToleranceFraction?: number;
}

export interface CoreLabelCorrespondenceResult {
  correspondence: BoneCorrespondence;
  sourceLabels: HumanoidCoreLabels;
  targetLabels: HumanoidCoreLabels;
  scale: number;
  /** One row per core name labeled on BOTH rigs. */
  core: CoreLabelPairReport[];
  /** Core names labeled on only one side (no entry — the source bone, if any, falls to ancestor fallback). */
  coreMissing: { name: HumanoidCoreBoneName; sourceIndex?: number; targetIndex?: number }[];
  /** True only when every core pair passes every signal — the confidence bar a caller must check before building anything with this table. */
  coreConfirmed: boolean;
  deep: DeepBonePairReport[];
  /** Every source bone with NO entry in `correspondence` (rejected deep pairs, their subtrees, and never-visited bones) — these resolve via `resolveWithAncestorFallback`. */
  fallbackSourceBones: number[];
}

/**
 * Label both rigs' core bones structurally, match core bones by name, and
 * match every other bone within its nearest core anchor's subtree. See this
 * module's header doc for why this shape, and
 * `CoreLabelCorrespondenceResult.coreConfirmed` for the bar a caller must
 * check: **this function never hides a failed core pair** — a failing pair
 * still gets an entry (so a human can see what it would have been) but it
 * is `flagged`, its confidence is < 1, and `coreConfirmed` is false.
 */
export function buildCorrespondenceByCoreLabels(
  source: Skeleton,
  target: Skeleton,
  opts: CoreLabelCorrespondenceOptions = {},
): CoreLabelCorrespondenceResult {
  const posTolFrac = opts.positionToleranceFraction ?? POSITION_TOLERANCE_FRACTION;
  const rotTol = opts.rotationToleranceRadians ?? (30 * Math.PI) / 180;
  const lenTolFrac = opts.lengthRatioToleranceFraction ?? 0.35;
  const deepTolFrac = opts.deepPositionToleranceFraction ?? 0.03;
  const deepTolRel = opts.deepPositionToleranceRelative ?? 0.25;
  const deepMinCos = opts.deepDirectionMinCosine ?? 0.7;
  const deepSubtreeTol = opts.deepSubtreeToleranceFraction ?? 0.5;

  const sourceLabels = labelHumanoidCoreBones(source);
  const targetLabels = labelHumanoidCoreBones(target);
  const sp = computePose(source.bones);
  const tp = computePose(target.bones);
  const scale = estimateUniformScale(sp.position, tp.position);
  const height = boundingHeight(tp.position);
  const posTol = height * posTolFrac;

  const scaled = (v: Vec3): Vec3 => ({ x: v.x * scale, y: v.y * scale, z: v.z * scale });
  const rotAngle = (si: number, ti: number): number => Math.acos(Math.min(1, qdot(sp.rotation[si]!, tp.rotation[ti]!)));
  const mirrorAgree = (a: Vec3, b: Vec3, tol: number): boolean => Math.abs(a.x + b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol;

  const entries: BoneCorrespondenceEntry[] = [];
  const core: CoreLabelPairReport[] = [];
  const coreMissing: CoreLabelCorrespondenceResult['coreMissing'] = [];
  const corePairs = new Map<number, number>(); // source core idx -> target core idx
  for (const name of HUMANOID_CORE_BONE_NAMES) {
    const si = sourceLabels.byName[name], ti = targetLabels.byName[name];
    if (si === undefined || ti === undefined) {
      if (si !== undefined || ti !== undefined) coreMissing.push({ name, sourceIndex: si, targetIndex: ti });
      continue;
    }
    corePairs.set(si, ti);
    const sPos = scaled(sp.position[si]!), tPos = tp.position[ti]!;
    const positionDistance = vlen(vsub(sPos, tPos));
    const angle = rotAngle(si, ti);
    const sParent = source.bones[si]!.parent, tParent = target.bones[ti]!.parent;
    const sLen = sParent >= 0 ? vlen(vsub(sp.position[si]!, sp.position[sParent]!)) * scale : 0;
    const tLen = tParent >= 0 ? vlen(vsub(tp.position[ti]!, tp.position[tParent]!)) : 0;
    const lengthRatio = sLen < 1e-6 && tLen < 1e-6 ? 1 : tLen < 1e-6 ? Infinity : sLen / tLen;
    const lengthRatioAgree = sLen < 1e-6 && tLen < 1e-6 ? true : Number.isFinite(lengthRatio) && Math.abs(lengthRatio - 1) <= lenTolFrac;
    let symmetryAgree = true;
    if (name.startsWith('l_') || name.startsWith('r_')) {
      const mirrorName = (name.startsWith('l_') ? `r_${name.slice(2)}` : `l_${name.slice(2)}`) as HumanoidCoreBoneName;
      const sm = sourceLabels.byName[mirrorName], tm = targetLabels.byName[mirrorName];
      if (sm !== undefined && tm !== undefined) {
        symmetryAgree = mirrorAgree(sp.position[si]!, sp.position[sm]!, posTol / scale) && mirrorAgree(tp.position[ti]!, tp.position[tm]!, posTol);
      }
    }
    const signals: CoreLabelSignals = { positionAgree: positionDistance <= posTol, rotationAgree: angle <= rotTol, lengthRatioAgree, symmetryAgree };
    const ok = signals.positionAgree && signals.rotationAgree && signals.lengthRatioAgree && signals.symmetryAgree;
    core.push({ name, sourceIndex: si, targetIndex: ti, signals, positionDistance, rotationAngleDeg: (angle * 180) / Math.PI, lengthRatio, ok });
    const agree = Number(signals.positionAgree) + Number(signals.rotationAgree) + Number(signals.lengthRatioAgree) + Number(signals.symmetryAgree);
    const entry: BoneCorrespondenceEntry = { sourceIndex: si, targetIndex: ti, confidence: ok ? 1 : agree / 4, source: 'name' };
    if (!ok) {
      const failed = (Object.keys(signals) as (keyof CoreLabelSignals)[]).filter((k) => !signals[k]);
      entry.flagged = `core bone "${name}" (source ${si} -> target ${ti}) failed signal(s) [${failed.join(', ')}] — NOT confirmed`;
    }
    entries.push(entry);
  }
  const coreConfirmed = core.length > 0 && core.every((c) => c.ok);

  // Deep bones: optimal assignment per fork, descending from each core pair,
  // never crossing into another core bone (those are matched by name above),
  // and never descending below a rejected pair.
  const deep: DeepBonePairReport[] = [];
  const sourceCore = new Set(corePairs.keys()), targetCore = new Set(corePairs.values());
  const sSize = subtreeSizes(sp.children), tSize = subtreeSizes(tp.children);
  const nearZero = 0.01 * height;
  const shortOffset = 0.02 * height;
  /** Unit direction of `i`'s main-chain axis: parent(i) -> its largest-subtree child (the real joint chain), or undefined for a leaf. */
  const mainAxis = (pose: Pose, sizes: Int32Array, i: number): Vec3 | undefined => {
    let best = -1, bestSize = -1;
    for (const c of pose.children[i]!) if (sizes[c]! > bestSize) { bestSize = sizes[c]!; best = c; }
    if (best < 0) return undefined;
    const d = vsub(pose.position[best]!, pose.position[i]!);
    const l = vlen(d);
    return l < 1e-6 ? undefined : { x: d.x / l, y: d.y / l, z: d.z / l };
  };
  const alongAxis = (off: Vec3, axis: Vec3 | undefined): boolean => {
    const l = vlen(off);
    if (l < nearZero) return true; // sits on the joint itself
    if (!axis) return false;
    return Math.abs(vdot(off, axis)) / l >= 0.95;
  };
  function matchBelow(si: number, ti: number, anchorName: HumanoidCoreBoneName, anchorS: number, anchorT: number): void {
    const sc = sp.children[si]!.filter((c) => !sourceCore.has(c));
    const tc = tp.children[ti]!.filter((c) => !targetCore.has(c));
    if (sc.length === 0 || tc.length === 0) return;
    const costs = sc.map((cs) => tc.map((ct) => {
      // Same angle+length shape as `childCost`, but with a REAL zero-length
      // epsilon: a helper bone sitting exactly on its parent's joint comes out
      // of float FK as e.g. (-0.00, -0.00, 0.00), not < 1e-6, and the
      // "direction" of such a vector is pure noise — on one measured rig
      // pair that noise paired the source's left upper-arm twist helper with
      // a zero-offset socket while the right side (same geometry, different
      // noise) paired correctly. 1% of the rig's height is the same
      // near-zero threshold the acceptance signals below use.
      const offL = scaled(vsub(sp.position[cs]!, sp.position[si]!)), offB = vsub(tp.position[ct]!, tp.position[ti]!);
      const lenL = vlen(offL), lenB = vlen(offB);
      let geometric: number;
      if (lenL < nearZero && lenB < nearZero) geometric = 0;
      else if (lenL < nearZero || lenB < nearZero) geometric = 2;
      else geometric = (1 - vdot(offL, offB) / (lenL * lenB)) + 0.5 * (Math.abs(lenL - lenB) / Math.max(lenL, lenB));
      const a = sSize[cs]!, b = tSize[ct]!;
      return geometric + 0.5 * (Math.abs(a - b) / Math.max(a, b)); // subtree-shape term: a hub only pairs with a hub
    }));
    const sAxis = mainAxis(sp, sSize, si), tAxis = mainAxis(tp, tSize, ti);
    for (const [li, bi] of assignOptimal(costs)) {
      const cs = sc[li]!, ct = tc[bi]!;
      const sRel = scaled(vsub(sp.position[cs]!, sp.position[anchorS]!)), tRel = vsub(tp.position[ct]!, tp.position[anchorT]!);
      const positionDistance = vlen(vsub(sRel, tRel));
      const tol = Math.max(height * deepTolFrac, deepTolRel * vlen(tRel));
      const sOff = scaled(vsub(sp.position[cs]!, sp.position[si]!)), tOff = vsub(tp.position[ct]!, tp.position[ti]!);
      const sl = vlen(sOff), tl = vlen(tOff);
      // Direction is only a meaningful signal when BOTH offsets are long enough
      // for their direction to be more than noise (a face hub sitting 2 units
      // below the head joint on one rig and 0.7 above it on the other is the
      // same bone; its "direction" isn't). Short offsets defer to position/
      // rotation/subtree, which must still all pass.
      const directionAgree = sl < shortOffset || tl < shortOffset ? true : vdot(sOff, tOff) / (sl * tl) >= deepMinCos;
      const angle = rotAngle(cs, ct);
      const a = sSize[cs]!, b = tSize[ct]!;
      const subtreeAgree = Math.abs(a - b) / Math.max(a, b) <= deepSubtreeTol;
      const axisHelper = a === 1 && b === 1 && alongAxis(sOff, sAxis) && alongAxis(tOff, tAxis);
      const signals: DeepBoneSignals = { positionAgree: positionDistance <= tol, directionAgree, rotationAgree: angle <= rotTol, axisHelper, subtreeAgree };
      const accepted = (signals.positionAgree || signals.axisHelper) && signals.directionAgree && signals.rotationAgree && signals.subtreeAgree;
      deep.push({ sourceIndex: cs, targetIndex: ct, anchor: anchorName, signals, positionDistance, rotationAngleDeg: (angle * 180) / Math.PI, accepted });
      if (!accepted) continue;
      entries.push({ sourceIndex: cs, targetIndex: ct, confidence: 1, source: 'position' });
      matchBelow(cs, ct, anchorName, anchorS, anchorT);
    }
  }
  for (const [si, ti] of corePairs) matchBelow(si, ti, sourceLabels.byIndex.get(si)!, si, ti);

  entries.sort((a, b) => a.sourceIndex - b.sourceIndex);
  const mapped = new Set(entries.map((e) => e.sourceIndex));
  const fallbackSourceBones: number[] = [];
  for (let i = 0; i < source.bones.length; i++) if (!mapped.has(i)) fallbackSourceBones.push(i);

  return {
    correspondence: { entries, sourceBoneCount: source.bones.length, targetBoneCount: target.bones.length },
    sourceLabels, targetLabels, scale, core, coreMissing, coreConfirmed, deep, fallbackSourceBones,
  };
}
