/**
 * Engine-agnostic skeleton retargeting: take a mesh skinned to rig A and make
 * it a mesh skinned to rig B, where A and B were authored by different people
 * for different engines and share no bone names, no bone order and no bind
 * pose.
 *
 * This is an **offline rig-conversion** library, not a runtime
 * animation-playback one: it operates on plain TRS bone arrays (see
 * `./types.js`), never on a live scene graph, and it has no renderer, no DOM
 * and no file-format dependency. `@seer-project/engine-3d`'s
 * `retargetClipsToSkeleton` is the runtime counterpart.
 *
 * The pipeline, in the order a converter uses it:
 *
 * 1. **Label** — `labelHumanoidCoreBones` names a rig's ~23 core bones from
 *    hierarchy and bind-pose geometry alone, no bone names required.
 * 2. **Correspond** — `buildCorrespondenceByCoreLabels` (structural, works
 *    across renamed and reordered rigs), `buildNameCorrespondence` (when the
 *    source has authored joint names and a dictionary exists), or
 *    `buildShallowBoneCandidates` (geometry only; reports rather than
 *    accepts). All produce a `BoneCorrespondence`.
 * 3. **Resolve** — `resolveWithAncestorFallback` fills the gaps: an unmapped
 *    bone inherits its nearest mapped ancestor, recorded in `hops`, never
 *    silently.
 * 4. **Reconcile the bind pose** — `estimateCoreScale`, then
 *    `buildBindPoseReconciliation` / `applyBindPoseReconciliation`, re-pose
 *    the geometry from the source's bind pose into the target's (T-pose vs
 *    A-pose, different proportions, different units).
 * 5. **Transfer the skin** — `transferWeights` remaps each vertex's four
 *    (joint, weight) slots onto target bone indices, consolidating
 *    duplicates.
 *
 * Every step reports its own disagreements (`flagged`, `coreConfirmed`,
 * `unresolvedSourceBones`, `fallbackSourceBones`, per-signal verdicts)
 * rather than quietly producing a plausible-looking wrong rig.
 */

export type { Vec3, Quat4, TrsBone, Skeleton, TrsNodeLike } from './types.js';

export type { BoneTraversal } from './fk.js';
export { boneTraversalOrder, computeBoneWorldMatrices } from './fk.js';

export type { Pose } from './math.js';
export {
  vsub, vlen, vdot, qdot, qmul, qconj, qrot, qnormalize, quatFromTo, quatAngleDeg,
  mat4Translation, mat4UniformScale, mat4AxisScale, mat4ApplyPoint,
  computeWorldPositions, boundingHeight, estimateUniformScale, computePose, subtreeSizes, boneDepth,
} from './math.js';

export type {
  CorrespondenceSource, BoneCorrespondenceEntry, BoneCorrespondence,
  ResolvedBone, NameCorrespondenceResult, TransferredWeights,
} from './correspondence.js';
export {
  POSITION_TOLERANCE_FRACTION,
  resolveWithAncestorFallback, resolveWithAncestorFallbackByParents,
  buildNameCorrespondence, transferWeights,
} from './correspondence.js';

export { childCost, matchChildren, assignOptimal } from './assignment.js';

export type { ShallowBoneSignals, ShallowBoneCandidate, ShallowBoneCandidateOptions } from './shallow.js';
export { buildShallowBoneCandidates } from './shallow.js';

export type { HumanoidCoreBoneName, HumanoidCoreLabels } from './core-labels.js';
export { HUMANOID_CORE_BONE_NAMES, labelHumanoidCoreBones, sourceCoreBonesFromCorrespondence } from './core-labels.js';

export type {
  CoreLabelSignals, CoreLabelPairReport, DeepBoneSignals, DeepBonePairReport,
  CoreLabelCorrespondenceOptions, CoreLabelCorrespondenceResult,
} from './core-match.js';
export { buildCorrespondenceByCoreLabels } from './core-match.js';

export type { CoreScaleEstimate, BindPoseReconciliationOptions, BindPoseBoneCorrection, BindPoseReconciliation } from './bind-pose.js';
export { estimateCoreScale, buildBindPoseReconciliation, applyBindPoseReconciliation } from './bind-pose.js';
