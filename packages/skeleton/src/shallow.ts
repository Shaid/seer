/**
 * Purely geometric/topological matching of the SHALLOW bones, with four
 * independent agreement signals per candidate and no auto-acceptance.
 *
 * This is the weaker of the two matchers in this package and it is kept
 * deliberately: on two rigs that are the same 21 core bones in a DIFFERENT
 * ORDER it reports an honest partial result rather than a confident wrong
 * one, which is exactly what you want from a first pass. `./core-match.js`
 * is the labelling-based matcher that supersedes it for humanoids.
 */
import type { Skeleton } from './types.js';
import {
  boneDepth, boundingHeight, computePose, estimateUniformScale, qdot, vlen, vsub,
} from './math.js';
import { assignOptimal, childCost, matchChildren } from './assignment.js';
import { POSITION_TOLERANCE_FRACTION, type BoneCorrespondenceEntry } from './correspondence.js';

export interface ShallowBoneSignals {
  positionAgree: boolean;
  rotationAgree: boolean;
  scaleAgree: boolean;
  childCountAgree: boolean;
}

export interface ShallowBoneCandidate extends BoneCorrespondenceEntry {
  sourceDepth: number;
  signals: ShallowBoneSignals;
}

export interface ShallowBoneCandidateOptions {
  /** Only source bones this shallow or shallower are reported at all. Default 6. */
  maxDepth?: number;
  positionToleranceFraction?: number;
  /** Max angle (radians) between source and target WORLD bind-pose orientation for `rotationAgree`. Generous by design — see this function's own header doc for why cross-family bone-roll conventions make tight rotation agreement unreliable. */
  rotationToleranceRadians?: number;
  /** Max fractional difference between a candidate pair's own parent->child offset LENGTH ratio and the skeleton-wide estimated uniform scale, for `scaleAgree`. */
  scaleToleranceFraction?: number;
  /** Max absolute difference in immediate child count for `childCountAgree`. */
  maxChildCountDelta?: number;
  /**
   * How each fork's children are paired. `'legacy'` (the default) is exact
   * for fan-out <= 8 and GREEDY beyond it; `'optimal'` uses `assignOptimal`
   * (Kuhn-Munkres) at every fork. The greedy fallback is what mis-pairs
   * neck/clavicle on real humanoid rigs whose chest fork has more than 8
   * children (see `assignOptimal`'s doc) — `'optimal'` is opt-in only so
   * this function's shipped default behaviour, and any output pinned
   * against it, stays unchanged.
   */
  assignment?: 'legacy' | 'optimal';
}

/**
 * Automated topological/geometric matching restricted to depth <=
 * `maxDepth`, then FOUR independent signals per candidate — position,
 * ROTATION, relative scale and child-count agreement.
 *
 * **This function never auto-accepts a shallow bone**: every candidate is
 * returned with its own per-signal verdict, and `flagged` is set (not merely
 * a low confidence number) the moment any one of the four disagrees, so a
 * caller cannot mistake a 3-of-4 pass for a confirmed match.
 */
export function buildShallowBoneCandidates(
  source: Skeleton,
  target: Skeleton,
  opts: ShallowBoneCandidateOptions = {},
): ShallowBoneCandidate[] {
  const maxDepth = opts.maxDepth ?? 6;
  const posTolFrac = opts.positionToleranceFraction ?? POSITION_TOLERANCE_FRACTION;
  const rotTol = opts.rotationToleranceRadians ?? (30 * Math.PI) / 180;
  const scaleTolFrac = opts.scaleToleranceFraction ?? 0.35;
  const maxChildDelta = opts.maxChildCountDelta ?? 1;
  const assign = opts.assignment === 'optimal' ? assignOptimal : matchChildren;

  const sp = computePose(source.bones);
  const tp = computePose(target.bones);
  const scale = estimateUniformScale(sp.position, tp.position);
  const tol = boundingHeight(tp.position) * posTolFrac;

  function subtreeSize(children: number[][], i: number): number {
    let n = 1;
    for (const c of children[i]!) n += subtreeSize(children, c);
    return n;
  }
  const sourceRootsSorted = [...sp.roots].sort((a, b) => subtreeSize(sp.children, b) - subtreeSize(sp.children, a));
  const targetRootsSorted = [...tp.roots].sort((a, b) => subtreeSize(tp.children, b) - subtreeSize(tp.children, a));

  const rawMatch = new Map<number, number>(); // sourceIdx -> targetIdx, every depth
  function recurse(si: number, ti: number): void {
    rawMatch.set(si, ti);
    const sc = sp.children[si]!, tc = tp.children[ti]!;
    if (sc.length === 0 || tc.length === 0) return;
    const costs = sc.map((cs) => tc.map((ct) => childCost(vsub(sp.position[cs]!, sp.position[si]!), vsub(tp.position[ct]!, tp.position[ti]!))));
    for (const [li, bi] of assign(costs)) recurse(sc[li]!, tc[bi]!);
  }
  for (let i = 0; i < Math.min(sourceRootsSorted.length, targetRootsSorted.length); i++) recurse(sourceRootsSorted[i]!, targetRootsSorted[i]!);

  const out: ShallowBoneCandidate[] = [];
  for (const [si, ti] of rawMatch) {
    const depth = boneDepth(source.bones, si);
    if (depth > maxDepth) continue;

    const sPos = sp.position[si]!, tPos = tp.position[ti]!;
    const dist = Math.hypot(sPos.x * scale - tPos.x, sPos.y * scale - tPos.y, sPos.z * scale - tPos.z);
    const positionAgree = dist <= tol;

    const rotAngle = Math.acos(Math.min(1, qdot(sp.rotation[si]!, tp.rotation[ti]!)));
    const rotationAgree = rotAngle <= rotTol;

    const sBone = source.bones[si]!, tBone = target.bones[ti]!;
    const sParentPos = sBone.parent >= 0 ? sp.position[sBone.parent]! : { x: 0, y: 0, z: 0 };
    const tParentPos = tBone.parent >= 0 ? tp.position[tBone.parent]! : { x: 0, y: 0, z: 0 };
    const sLen = vlen(vsub(sPos, sParentPos)), tLen = vlen(vsub(tPos, tParentPos));
    const scaleAgree = sLen < 1e-6 && tLen < 1e-6 ? true : sLen < 1e-6 || tLen < 1e-6 ? false : Math.abs((sLen * scale) / tLen - 1) <= scaleTolFrac;

    const childCountAgree = Math.abs(sp.children[si]!.length - tp.children[ti]!.length) <= maxChildDelta;

    const signals: ShallowBoneSignals = { positionAgree, rotationAgree, scaleAgree, childCountAgree };
    const agreeCount = Number(positionAgree) + Number(rotationAgree) + Number(scaleAgree) + Number(childCountAgree);
    const entry: ShallowBoneCandidate = {
      sourceIndex: si, targetIndex: ti, sourceDepth: depth,
      confidence: agreeCount / 4,
      source: 'position',
      signals,
    };
    if (agreeCount < 4) {
      const failed = (Object.keys(signals) as (keyof ShallowBoneSignals)[]).filter((k) => !signals[k]);
      entry.flagged = `shallow-bone candidate disagreement at depth ${depth}: signal(s) [${failed.join(', ')}] did not agree — NOT auto-accepted`;
    }
    out.push(entry);
  }
  out.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return out;
}
