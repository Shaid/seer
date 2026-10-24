# @seer-project/skeleton

Engine-agnostic skeleton retargeting for **offline rig conversion**: take a
mesh skinned to rig A and make it a mesh skinned to rig B, where A and B were
authored by different people for different engines and share no bone names,
no bone order and no bind pose.

Everything here operates on plain TRS bone arrays — a bone is
`{ parent, rotation, position, scale }` and a skeleton is `{ bones }`. No
renderer, no DOM, no file format, no `node:*`. An engine's own skeleton type
is *structurally* assignable with no adapter and no conversion copy, which is
the reason the types are declared this narrowly.

```ts
import {
  labelHumanoidCoreBones, buildCorrespondenceByCoreLabels,
  resolveWithAncestorFallback, estimateCoreScale,
  buildBindPoseReconciliation, applyBindPoseReconciliation, transferWeights,
} from '@seer-project/skeleton';
```

## The pipeline

| step | what | why it is separate |
|---|---|---|
| **Label** | `labelHumanoidCoreBones` | names a rig's ~23 core bones from hierarchy and bind-pose geometry alone — a `TrsBone` has no name, and even when it does the two rigs disagree |
| **Correspond** | `buildCorrespondenceByCoreLabels`, `buildNameCorrespondence`, `buildShallowBoneCandidates` | three independent ways to get a `BoneCorrespondence`; pick by what the source rig actually offers |
| **Resolve** | `resolveWithAncestorFallback` | an unmapped bone inherits its nearest mapped ancestor, with the hop count recorded |
| **Reconcile** | `estimateCoreScale`, `buildBindPoseReconciliation`, `applyBindPoseReconciliation` | re-poses geometry authored in the source's bind pose into the target's: T-pose vs A-pose, different proportions, different units |
| **Transfer** | `transferWeights` | remaps each vertex's four (joint, weight) slots onto target bone indices, consolidating duplicates |

`computeWorldPositions` / `computePose` / `computeBoneWorldMatrices` are the
shared bind-pose forward kinematics, exported because every exporter needs
them and otherwise hand-rolls a fifth copy.

## Two matchers, deliberately

`buildCorrespondenceByCoreLabels` is the one to reach for: it labels both rigs
structurally, matches the core by name, then matches each deep bone inside its
nearest confirmed core anchor's subtree with a Kuhn-Munkres optimal assignment
(`assignOptimal`).

`buildShallowBoneCandidates` is the weaker, purely geometric pass. It is kept
because it **never auto-accepts**: every candidate carries four independent
per-signal verdicts (position, rotation, relative scale, child count) and is
`flagged` the moment one disagrees, so it reports an honest partial result
instead of a confident wrong one. Its default `assignment: 'legacy'` keeps the
exact greedy-beyond-fan-out-8 behaviour its historical output was pinned
against; `'optimal'` is the better choice for new code.

## Nothing here hides a disagreement

`flagged`, `coreConfirmed`, `unresolvedSourceBones`, `fallbackSourceBones`,
`coreMissing`, the per-signal `signals` objects and the human-readable
`evidence`/`unlabeled` strings on `HumanoidCoreLabels` all exist for the same
reason: a retarget that silently produces a plausible-looking wrong rig costs
far more than one that refuses to claim a match it cannot justify.

## Conventions this package assumes

- **Y-up, +X is the rig's left.** Both are used by the structural labeler.
- Matrices are column-major `Float32Array(16)`, the glTF layout
  (`@seer-project/gltf` supplies `mat4Multiply` / `mat4Inverse` /
  `quatToMatrix`; this package adds the translation/scale constructors it
  needs on top).
- Quaternions are `{ x, y, z, w }`.

## Not here

Runtime animation retargeting against a live `THREE.Object3D` graph — that is
`@seer-project/engine-3d`'s `retargetClipsToSkeleton`. Engine-specific bone
remap tables (a format's own compact bone-index table, a global bone-id
namespace) stay in the consuming project: this package matches *bones*, not
file-format side tables.
