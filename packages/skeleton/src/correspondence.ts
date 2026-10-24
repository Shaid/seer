/**
 * The correspondence table itself: what a `BoneCorrespondence` is, the
 * name-keyed table builder, the ancestor-fallback resolver every table is run
 * through, and the skin-weight remap that consumes the result.
 *
 * A correspondence is "source bone i plays the role of target bone j", with a
 * confidence and a never-silent `flagged` note whenever an automated check
 * disagreed with the match. The matchers that *produce* one live in
 * `./core-match.js` (structural humanoid labelling) and `./shallow.js`
 * (purely geometric); this module is what they all speak.
 */
import type { Skeleton } from './types.js';

export type CorrespondenceSource = 'index' | 'name' | 'position' | 'manual';

export interface BoneCorrespondenceEntry {
  /** Index into the SOURCE skeleton's `bones[]`. */
  sourceIndex: number;
  /** Index into the TARGET (donor) skeleton's `bones[]`. */
  targetIndex: number;
  /** 0..1. Lower when the table-vote wasn't unanimous or the bind-pose check disagreed. */
  confidence: number;
  source: CorrespondenceSource;
  /**
   * Set (never silently omitted) whenever an automated check disagreed with
   * this entry's own match — a human/caller should look at these before
   * trusting the entry for a high-stakes (shallow-bone) mapping.
   */
  flagged?: string;
}

export interface BoneCorrespondence {
  entries: BoneCorrespondenceEntry[];
  sourceBoneCount: number;
  targetBoneCount: number;
}

/**
 * Default fraction of the target skeleton's overall bind-pose height allowed
 * as bind-pose position disagreement before a proposed pair is flagged — the
 * shared default of every matcher in this package. Generous on purpose: two
 * rigs of the same character family routinely differ by a few percent
 * overall, so this is a domain-mismatch tripwire, not a tight-tolerance
 * oracle, and it must not flag correct matches on ordinary proportion
 * differences.
 */
export const POSITION_TOLERANCE_FRACTION = 0.08;

// ---------------------------------------------------------------------------
// Ancestor fallback — run over EVERY correspondence table, whichever matcher
// produced it: unmapped joints fall to the nearest mapped ancestor, and that
// is recorded (`viaAncestor`/`hops`) rather than being silent.
// ---------------------------------------------------------------------------

export interface ResolvedBone {
  targetIndex: number;
  /** True when this bone itself had no correspondence entry and inherited its parent's. */
  viaAncestor: boolean;
  /** Number of hierarchy levels walked up to find a mapped bone (0 = direct match). */
  hops: number;
  confidence: number;
}

/**
 * Resolve every source bone to a target bone, walking up the source
 * hierarchy for any bone a matcher (or a hand-curated table) left unmapped.
 * A bone with no mapped ancestor at all (including no mapped root) is left
 * absent from the returned map —
 * `transferWeights` treats that as a hard error rather than guessing, since
 * it means the correspondence table itself has a real hole at the root of
 * some subtree, not just a leaf gap.
 */
export function resolveWithAncestorFallback(correspondence: BoneCorrespondence, sourceSkeleton: Skeleton): Map<number, ResolvedBone> {
  return resolveWithAncestorFallbackByParents(
    correspondence,
    (i) => { const b = sourceSkeleton.bones[i]; return b ? b.parent : -1; },
    sourceSkeleton.bones.length,
  );
}

/**
 * Generalization of `resolveWithAncestorFallback` for a SOURCE that is not a
 * `Skeleton` at all — e.g. a glTF node hierarchy, where the "source skeleton"
 * is just a plain node-index -> parent-node-index map (`(i) => parents[i] ??
 * -1`) rather than a bone array. Identical walk/decay/documented-not-silent
 * behaviour as the skeleton-taking version above, which is now a thin wrapper
 * over this one.
 */
export function resolveWithAncestorFallbackByParents(
  correspondence: BoneCorrespondence,
  parentOf: (index: number) => number,
  sourceCount: number,
): Map<number, ResolvedBone> {
  const direct = new Map<number, BoneCorrespondenceEntry>();
  for (const e of correspondence.entries) direct.set(e.sourceIndex, e);
  const resolved = new Map<number, ResolvedBone>();
  const inProgress = new Set<number>();

  function resolve(i: number): ResolvedBone | undefined {
    const cached = resolved.get(i);
    if (cached) return cached;
    if (inProgress.has(i)) return undefined; // defensive: cyclic parent chain, never seen in real data
    inProgress.add(i);
    const own = direct.get(i);
    if (own) {
      const r: ResolvedBone = { targetIndex: own.targetIndex, viaAncestor: false, hops: 0, confidence: own.confidence };
      resolved.set(i, r);
      inProgress.delete(i);
      return r;
    }
    const parent = parentOf(i);
    if (parent < 0 || parent >= sourceCount) { inProgress.delete(i); return undefined; }
    const parentResolved = resolve(parent);
    inProgress.delete(i);
    if (!parentResolved) return undefined;
    const r: ResolvedBone = { targetIndex: parentResolved.targetIndex, viaAncestor: true, hops: parentResolved.hops + 1, confidence: parentResolved.confidence * 0.9 };
    resolved.set(i, r);
    return r;
  }

  for (let i = 0; i < sourceCount; i++) resolve(i);
  return resolved;
}

// ---------------------------------------------------------------------------
// Name-keyed correspondence.
//
// For a source rig that has real, human-authored joint names but shares no
// structural or index relationship with the target: source node NAME -> one
// canonical bone name -> that name's bone INDEX in the target skeleton. The
// `sourceIndex` of the resulting `BoneCorrespondence` is whatever index space
// `sourceNames` is in (a glTF NODE index, typically), which is also what the
// caller then resolves ancestor fallback against via
// `resolveWithAncestorFallbackByParents`.
// ---------------------------------------------------------------------------

export interface NameCorrespondenceResult {
  correspondence: BoneCorrespondence;
  /** Every source name present in `nameToCanonical` whose canonical target has no entry in `canonicalToTargetIndex` — a config error in the caller's own two tables, reported rather than silently dropped. */
  unresolvedCanonicalNames: string[];
}

/**
 * Build a name-keyed `BoneCorrespondence` for a named source skeleton.
 * `sourceNames[i]` is node `i`'s own name (`undefined`/unlisted names are
 * simply not given an entry — they fall to
 * `resolveWithAncestorFallbackByParents`, which is the right answer for
 * anything not worth a dedicated dictionary entry: twist helpers, finger
 * segments beyond the mapped root, spring-bone cape chains, physics bones).
 */
export function buildNameCorrespondence(
  sourceNames: readonly (string | undefined)[],
  nameToCanonical: Readonly<Record<string, string>>,
  canonicalToTargetIndex: Readonly<Record<string, number>>,
  targetBoneCount: number,
): NameCorrespondenceResult {
  const entries: BoneCorrespondenceEntry[] = [];
  const unresolvedCanonicalNames = new Set<string>();
  sourceNames.forEach((name, i) => {
    if (!name) return;
    const canonical = nameToCanonical[name];
    if (canonical === undefined) return; // not in the dictionary — ancestor fallback handles it
    const targetIndex = canonicalToTargetIndex[canonical];
    if (targetIndex === undefined) { unresolvedCanonicalNames.add(canonical); return; }
    entries.push({ sourceIndex: i, targetIndex, confidence: 1, source: 'name' });
  });
  return {
    correspondence: { entries, sourceBoneCount: sourceNames.length, targetBoneCount },
    unresolvedCanonicalNames: [...unresolvedCanonicalNames].sort(),
  };
}

// ---------------------------------------------------------------------------
// Weight transfer — remap a vertex's (joint, weight) pairs through a
// resolved correspondence. Deliberately independent of any mesh I/O so it is
// directly unit-testable; an importer calls it once per mesh primitive.
// ---------------------------------------------------------------------------

export interface TransferredWeights {
  /** Flat `count * 4` target-skeleton bone indices, duplicate slots (from ancestor-fallback collisions) already consolidated. */
  joints: Uint32Array;
  /** Flat `count * 4` weights, renormalized to sum to 1 per vertex (0 for an unused slot). */
  weights: Float32Array;
  /** Every DISTINCT source bone index that had no resolved target at all (hard error condition — see `resolveWithAncestorFallback`). Empty on success. */
  unresolvedSourceBones: number[];
}

/**
 * Remap `count` vertices' 4-wide (joint, weight) pairs from SOURCE skeleton
 * bone indices to TARGET skeleton bone indices via `resolved`
 * (`resolveWithAncestorFallback`'s output). Two source joint slots that
 * resolve to the same target bone (a real, expected outcome of ancestor
 * fallback — several unmapped source leaf bones can share one mapped
 * ancestor) are summed into one slot rather than kept as duplicate entries,
 * since duplicate joint indices within one vertex's 4 slots would otherwise
 * double-count that bone's influence under any palette-slot encoding.
 *
 * Does NOT touch `positions`/`normals` — weight transfer only changes which
 * bones a vertex's existing local-space attributes are skinned to, not the
 * attributes themselves; they pass through the caller's own vertex-buffer
 * assembly unchanged. (`applyBindPoseReconciliation` in `./bind-pose.js` is
 * the step that does move geometry.)
 */
export function transferWeights(
  joints: Uint32Array,
  weights: Float32Array,
  count: number,
  resolved: Map<number, ResolvedBone>,
): TransferredWeights {
  const outJoints = new Uint32Array(count * 4);
  const outWeights = new Float32Array(count * 4);
  const unresolved = new Set<number>();

  for (let vi = 0; vi < count; vi++) {
    const perTarget = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      const w = weights[vi * 4 + k] ?? 0;
      if (w <= 0) continue;
      const sourceBone = joints[vi * 4 + k]!;
      const r = resolved.get(sourceBone);
      if (!r) { unresolved.add(sourceBone); continue; }
      perTarget.set(r.targetIndex, (perTarget.get(r.targetIndex) ?? 0) + w);
    }
    const ranked = [...perTarget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = ranked.reduce((s, [, w]) => s + w, 0);
    ranked.forEach(([bone, w], k) => {
      outJoints[vi * 4 + k] = bone;
      outWeights[vi * 4 + k] = sum > 0 ? w / sum : 0;
    });
  }

  return { joints: outJoints, weights: outWeights, unresolvedSourceBones: [...unresolved].sort((a, b) => a - b) };
}
