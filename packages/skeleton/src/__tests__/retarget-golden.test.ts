/**
 * Output-hash safety net for every algorithm this package exports, over a
 * fixed pair of synthetic humanoid rigs.
 *
 * These hashes are **the same numbers** a downstream consumer
 * (`chimera`'s `tools/__tests__/skeleton-retarget-golden.test.ts`, where
 * these algorithms were first written and are additionally pinned against a
 * real game-asset corpus) records for the identically-named cases. Keeping
 * the two in sync is deliberate: it is what proves a change here is a change
 * there, down to the last of twelve significant digits.
 *
 * It exists for **refactors**. A transposed argument, or a math helper that
 * quietly resolves to a different copy of itself, does not necessarily break
 * a behavioural assertion phrased as a tolerance band — but it always
 * changes a hash. Every exported algorithm appears below at least once, with
 * the option branches that select a different code path exercised
 * separately.
 *
 * A changed hash is a changed output: work out which, and why, before
 * touching the table.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  POSITION_TOLERANCE_FRACTION, HUMANOID_CORE_BONE_NAMES,
  computeWorldPositions, estimateUniformScale,
  resolveWithAncestorFallback, resolveWithAncestorFallbackByParents,
  buildNameCorrespondence, transferWeights, assignOptimal, buildShallowBoneCandidates,
  labelHumanoidCoreBones, buildCorrespondenceByCoreLabels, sourceCoreBonesFromCorrespondence,
  estimateCoreScale, buildBindPoseReconciliation, applyBindPoseReconciliation,
  type BoneCorrespondence, type Quat4, type Skeleton, type TrsBone,
} from '../index.js';

// ---------------------------------------------------------------------------
// Canonical serialization — one stable text form for anything these functions
// return, so a hash is comparable across machines and runs.
// ---------------------------------------------------------------------------

/**
 * 12 significant digits: tight enough that a reordered floating-point
 * accumulation (the realistic refactor hazard — a helper inlined in a
 * different order) shows up, loose enough that the last-bit noise of a
 * `Math.hypot` on a different libm does not.
 */
function num(v: number): string | number {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  const r = Number(v.toPrecision(12));
  return Object.is(r, -0) ? 0 : r;
}

/** Deterministic, type-tagged plain-JSON view: Maps/Sets become sorted entry lists, typed arrays become number lists, object keys are sorted, `undefined` survives as a marker. */
function canon(value: unknown): unknown {
  if (value === undefined) return '__undefined__';
  if (value === null) return null;
  if (typeof value === 'number') return num(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (ArrayBuffer.isView(value)) return { '__typed__': value.constructor.name, v: Array.from(value as unknown as ArrayLike<number>).map(num) };
  if (Array.isArray(value)) return value.map(canon);
  if (value instanceof Map) {
    return { '__map__': [...value.entries()].map(([k, v]) => [canon(k), canon(v)]).sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1)) };
  }
  if (value instanceof Set) return { '__set__': [...value].map(canon).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = canon((value as Record<string, unknown>)[k]);
    return out;
  }
  return `__${typeof value}__`;
}

interface CaseHash { sha256: string; chars: number }

function hashOf(value: unknown): CaseHash {
  const text = JSON.stringify(canon(value));
  return { sha256: createHash('sha256').update(text).digest('hex').slice(0, 32), chars: text.length };
}

// ---------------------------------------------------------------------------
// Synthetic fixtures.
// ---------------------------------------------------------------------------

/** Numerical Recipes LCG: same sequence on every platform, no dependency. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function bone(parent: number, x: number, y: number, z: number, rotation: Quat4 = { x: 0, y: 0, z: 0, w: 1 }): TrsBone {
  return { parent, position: { x, y, z }, rotation, scale: { x: 1, y: 1, z: 1 } };
}

interface RigOptions {
  seed?: number;
  /** Uniform multiplier on every local offset. */
  scale?: number;
  /** Arms straight out along +/-X instead of the default A-pose, same segment lengths. */
  tPose?: boolean;
  /** Uniform +/- jitter (pre-scale units) added to every local offset. */
  jitter?: number;
  /** Max bind-rotation angle, degrees, applied about a per-bone pseudo-random axis. */
  rotateDeg?: number;
  /** Where each thigh twist helper sits along its thigh. */
  twistFraction?: number;
}

/**
 * A 31-bone humanoid: root / pelvis / hips, two legs with toes and twist
 * helpers, spine / neck / head with hair leaves, two arms with fingers,
 * skirt leaves. Everything the structural labeler has to see through.
 */
function makeRig(opts: RigOptions = {}): Skeleton {
  const k = opts.scale ?? 1, tf = opts.twistFraction ?? 0.4;
  const r = rng(opts.seed ?? 1);
  const amp = opts.jitter ?? 0;
  const j = (): number => (amp === 0 ? 0 : (r() * 2 - 1) * amp);
  const rot = (): Quat4 => {
    if (!opts.rotateDeg) return { x: 0, y: 0, z: 0, w: 1 };
    const ax = r() * 2 - 1, ay = r() * 2 - 1, az = r() * 2 - 1;
    const l = Math.hypot(ax, ay, az) || 1;
    const half = ((r() * opts.rotateDeg * Math.PI) / 180) / 2;
    const s = Math.sin(half);
    return { x: (ax / l) * s, y: (ay / l) * s, z: (az / l) * s, w: Math.cos(half) };
  };
  const b = (parent: number, x: number, y: number, z: number): TrsBone => bone(parent, (x + j()) * k, (y + j()) * k, (z + j()) * k, rot());
  const fa = opts.tPose ? [22.825, 0] : [11, -20], ha = opts.tPose ? [25.060, 0] : [12, -22], fi = opts.tPose ? [4.243, 0] : [3, -3];
  const bones: TrsBone[] = [
    b(-1, 0, 0, 0), b(0, 0, 88, 0), b(1, 0, 0, 0),
    b(2, 7, 0, 0), b(2, -7, 0, 0), b(3, 0, -39, 0), b(4, 0, -39, 0), b(5, 0, -39, 0), b(6, 0, -39, 0), b(7, 0, -8, 11), b(8, 0, -8, 11),
    b(2, 0, 15, 0), b(11, 0, 14, 0), b(12, 0, 21, -2), b(13, 0, 10, 0),
    b(12, 2, 17, -2), b(12, -2, 17, -2), b(15, 12, -2, 0), b(16, -12, -2, 0), b(17, fa[0]!, fa[1]!, 0), b(18, -fa[0]!, fa[1]!, 0), b(19, ha[0]!, ha[1]!, 0), b(20, -ha[0]!, ha[1]!, 0),
    b(21, fi[0]!, fi[1]!, 0), b(22, -fi[0]!, fi[1]!, 0),
    b(2, 5, -3, 15), b(2, 5, -3, -15),
    b(3, 0, -39 * tf, 0), b(4, 0, -39 * tf, 0),
    b(14, 0, 5, 0), b(14, 0, 4, 3),
  ];
  return { bones };
}

/** Source rig: clean A-pose, the reference. */
const RIG_A = makeRig();
/** Target rig: 15% larger, T-posed, jittered and bind-rotated — exercises the quaternion paths, the length-ratio branches and the rotation signals. */
const RIG_B = makeRig({ seed: 7, scale: 1.15, tPose: true, jitter: 0.6, rotateDeg: 6 });
/** Third rig: smaller, differently jittered, no bind rotations. */
const RIG_C = makeRig({ seed: 1337, scale: 0.82, jitter: 1.2, twistFraction: 0.25 });
/** Degenerate: a 3-bone chain with no limb fork at all — the labeler's early-return branches. */
const RIG_CHAIN: Skeleton = { bones: [bone(-1, 0, 0, 0), bone(0, 0, 10, 0), bone(1, 0, 10, 0)] };

function identityTable(n: number): BoneCorrespondence {
  return { entries: Array.from({ length: n }, (_, i) => ({ sourceIndex: i, targetIndex: i, confidence: 1, source: 'manual' as const })), sourceBoneCount: n, targetBoneCount: n };
}

/** Deterministic `count`-vertex 4-wide skin over `boneCount` bones. */
function skin(count: number, boneCount: number, seed: number): { joints: Uint32Array; weights: Float32Array; positions: Float32Array; normals: Float32Array } {
  const r = rng(seed);
  const joints = new Uint32Array(count * 4), weights = new Float32Array(count * 4);
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const raw = [r(), r() * 0.5, r() * 0.25, 0];
    const sum = raw.reduce((a, x) => a + x, 0) || 1;
    for (let k = 0; k < 4; k++) {
      joints[v * 4 + k] = Math.floor(r() * boneCount);
      weights[v * 4 + k] = raw[k]! / sum;
    }
    positions[v * 3] = (r() * 2 - 1) * 30; positions[v * 3 + 1] = r() * 160; positions[v * 3 + 2] = (r() * 2 - 1) * 20;
    const nx = r() * 2 - 1, ny = r() * 2 - 1, nz = r() * 2 - 1, nl = Math.hypot(nx, ny, nz) || 1;
    normals[v * 3] = nx / nl; normals[v * 3 + 1] = ny / nl; normals[v * 3 + 2] = nz / nl;
  }
  return { joints, weights, positions, normals };
}

/** Deterministic `rows x cols` cost matrix. */
function costs(rows: number, cols: number, seed: number): number[][] {
  const r = rng(seed);
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => Number((r() * 2).toFixed(6))));
}

// ---------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------

function syntheticCases(): Record<string, unknown> {
  const worldA = computeWorldPositions(RIG_A.bones);
  const worldB = computeWorldPositions(RIG_B.bones);
  const worldC = computeWorldPositions(RIG_C.bones);

  // A table with holes at the root, a mid-chain bone and two leaves — the
  // ancestor walk, the hop decay and the "no mapped ancestor at all" case.
  const holed: BoneCorrespondence = { ...identityTable(31), entries: identityTable(31).entries.filter((e) => ![0, 19, 23, 27].includes(e.sourceIndex)) };
  const resolvedFull = resolveWithAncestorFallback(identityTable(31), RIG_A);
  const resolvedHoled = resolveWithAncestorFallback(holed, RIG_A);
  // Same walk over a plain parent-index array (a glTF node graph).
  const parents = [-1, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8];
  const byParents = resolveWithAncestorFallbackByParents(
    { entries: [{ sourceIndex: 1, targetIndex: 40, confidence: 0.8, source: 'name' }, { sourceIndex: 4, targetIndex: 44, confidence: 1, source: 'name' }], sourceBoneCount: parents.length, targetBoneCount: 64 },
    (i) => parents[i] ?? -1,
    parents.length,
  );

  const names = ['c_hip_jnt', 'c_spine1_jnt', undefined, 'l_arm_jnt', 'r_arm_jnt', 'c_unknown_jnt', 'c_spine2_jnt'];
  const nameCorr = buildNameCorrespondence(
    names,
    { c_hip_jnt: 'hips', c_spine1_jnt: 'spine1', c_spine2_jnt: 'spine2', l_arm_jnt: 'l_upperarm', r_arm_jnt: 'r_upperarm' },
    { hips: 2, spine1: 11, l_upperarm: 17, r_upperarm: 18 }, // 'spine2' deliberately absent -> unresolvedCanonicalNames
    31,
  );

  const s = skin(64, 31, 99);
  // Collapse every joint onto three targets so the duplicate-slot consolidation runs.
  const collapsing = new Map([...resolvedFull].map(([k, v]) => [k, { ...v, targetIndex: v.targetIndex % 3 }]));

  const labelsA = labelHumanoidCoreBones(RIG_A);
  const labelsB = labelHumanoidCoreBones(RIG_B);
  const coreAB = buildCorrespondenceByCoreLabels(RIG_A, RIG_B);
  const coreAC = buildCorrespondenceByCoreLabels(RIG_A, RIG_C, {
    positionToleranceFraction: 0.02, rotationToleranceRadians: 0.05, lengthRatioToleranceFraction: 0.05,
    deepPositionToleranceFraction: 0.01, deepPositionToleranceRelative: 0.05, deepDirectionMinCosine: 0.95, deepSubtreeToleranceFraction: 0.1,
  });

  const coreScale = estimateCoreScale(worldA, worldB, labelsA.byName, labelsB.byName);
  const coreScaleFallback = estimateCoreScale(worldA, worldC, {}, {});

  const recKeep = buildBindPoseReconciliation(RIG_A, RIG_B, identityTable(31), coreScale.scale, labelsB);
  const recMatch = buildBindPoseReconciliation(RIG_A, RIG_B, identityTable(31), coreScale.scale, labelsB, { boneLengths: 'match' });
  const recStrict = buildBindPoseReconciliation(RIG_A, RIG_B, identityTable(31), coreScale.scale, labelsB, { boneLengths: 'match', maxLengthRatio: 1.44 });
  const recHoled = buildBindPoseReconciliation(RIG_A, RIG_B, holed, 1, undefined);
  const g = skin(48, 31, 2024);

  return {
    'const/POSITION_TOLERANCE_FRACTION': POSITION_TOLERANCE_FRACTION,
    'const/HUMANOID_CORE_BONE_NAMES': HUMANOID_CORE_BONE_NAMES,

    'computeWorldPositions/rigA': worldA,
    'computeWorldPositions/rigB': worldB,
    'computeWorldPositions/rigC': worldC,
    'estimateUniformScale/A->B': estimateUniformScale(worldA, worldB),
    'estimateUniformScale/B->A': estimateUniformScale(worldB, worldA),
    'estimateUniformScale/empty': estimateUniformScale([], worldA),

    'resolveWithAncestorFallback/complete': resolvedFull,
    'resolveWithAncestorFallback/holed': resolvedHoled,
    'resolveWithAncestorFallbackByParents/node-graph': byParents,

    'buildNameCorrespondence/engage-style': nameCorr,

    'transferWeights/direct': transferWeights(s.joints, s.weights, 64, resolvedFull),
    'transferWeights/collapsing-duplicates': transferWeights(s.joints, s.weights, 64, collapsing),
    'transferWeights/unresolved': transferWeights(s.joints, s.weights, 64, new Map([...resolvedFull].filter(([k]) => k % 4 !== 0))),

    'assignOptimal/square-6x6': assignOptimal(costs(6, 6, 11)),
    'assignOptimal/wide-4x9': assignOptimal(costs(4, 9, 12)),
    'assignOptimal/tall-11x5': assignOptimal(costs(11, 5, 13)),
    'assignOptimal/ties': assignOptimal([[1, 1, 1], [1, 1, 1], [1, 1, 1]]),
    'assignOptimal/empty': assignOptimal([]),

    'buildShallowBoneCandidates/legacy': buildShallowBoneCandidates(RIG_A, RIG_B),
    'buildShallowBoneCandidates/optimal': buildShallowBoneCandidates(RIG_A, RIG_B, { assignment: 'optimal' }),
    'buildShallowBoneCandidates/deep-and-strict': buildShallowBoneCandidates(RIG_A, RIG_C, {
      maxDepth: 12, positionToleranceFraction: 0.01, rotationToleranceRadians: 0.02, scaleToleranceFraction: 0.05, maxChildCountDelta: 0,
    }),

    'labelHumanoidCoreBones/rigA': labelsA,
    'labelHumanoidCoreBones/rigB': labelsB,
    'labelHumanoidCoreBones/rigC': labelHumanoidCoreBones(RIG_C),
    'labelHumanoidCoreBones/no-fork-chain': labelHumanoidCoreBones(RIG_CHAIN),
    'labelHumanoidCoreBones/no-bones': labelHumanoidCoreBones({ bones: [] }),

    'buildCorrespondenceByCoreLabels/A->B defaults': coreAB,
    'buildCorrespondenceByCoreLabels/A->C strict': coreAC,

    'sourceCoreBonesFromCorrespondence/core-table': sourceCoreBonesFromCorrespondence(coreAB.correspondence, labelsB),
    'sourceCoreBonesFromCorrespondence/name-table': sourceCoreBonesFromCorrespondence(nameCorr.correspondence, labelsB),

    'estimateCoreScale/core-chain': coreScale,
    'estimateCoreScale/y-span-fallback': coreScaleFallback,

    'buildBindPoseReconciliation/keep': recKeep,
    'buildBindPoseReconciliation/match': recMatch,
    'buildBindPoseReconciliation/match-strict-ratio': recStrict,
    'buildBindPoseReconciliation/holed-table-no-labels': recHoled,

    'applyBindPoseReconciliation/keep+normals': applyBindPoseReconciliation(recKeep, g.positions, g.normals, g.joints, g.weights, 48),
    'applyBindPoseReconciliation/match-no-normals': applyBindPoseReconciliation(recMatch, g.positions, undefined, g.joints, g.weights, 48),
    'applyBindPoseReconciliation/zero-weight-vertices': applyBindPoseReconciliation(recKeep, g.positions, g.normals, g.joints, new Float32Array(48 * 4), 48),
  };
}

/**
 * Recorded against this package's first release, and byte-identical to the
 * same-named rows of chimera's own fixture — see this file's header doc.
 */
const GOLDEN: Record<string, CaseHash> = {
  "applyBindPoseReconciliation/keep+normals": { sha256: '621c9ac2057e84aae53185ba5fe8faca', chars: 4375 },
  "applyBindPoseReconciliation/match-no-normals": { sha256: '948f04e1b363b32ffbfd4e451da1f886', chars: 2124 },
  "applyBindPoseReconciliation/zero-weight-vertices": { sha256: 'b0f5d734009e18422a68b772be2d4443', chars: 4370 },
  "assignOptimal/empty": { sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5', chars: 2 },
  "assignOptimal/square-6x6": { sha256: 'e22981eb52f621dd2cb8993aa3ca94ee', chars: 37 },
  "assignOptimal/tall-11x5": { sha256: 'dc9706515be99397bb9d409bf1db93ea', chars: 31 },
  "assignOptimal/ties": { sha256: 'f89ed23f7770dcd75032c0a6b3a33d98', chars: 19 },
  "assignOptimal/wide-4x9": { sha256: '7bfbf353587895f75ec20d3d8a88877c', chars: 25 },
  "buildBindPoseReconciliation/holed-table-no-labels": { sha256: '103a8910daf229406a275eded310977e', chars: 15919 },
  "buildBindPoseReconciliation/keep": { sha256: 'ec75bc0506d64b7692a34b63f8005bd5', chars: 17492 },
  "buildBindPoseReconciliation/match": { sha256: 'cb05170b96429933640f94762fc93422', chars: 17262 },
  "buildBindPoseReconciliation/match-strict-ratio": { sha256: '163cc074affed756935492be09337a46', chars: 17341 },
  "buildCorrespondenceByCoreLabels/A->B defaults": { sha256: 'b69d6881538c8f6fae069daca08869f7', chars: 14085 },
  "buildCorrespondenceByCoreLabels/A->C strict": { sha256: '5b89934ec0f7ff87ee09eedc7b6839b6', chars: 18478 },
  "buildNameCorrespondence/engage-style": { sha256: 'd1944c9b628dfcce752d2e7b205ef16d', chars: 374 },
  "buildShallowBoneCandidates/deep-and-strict": { sha256: 'a06375b7cb2c859c78476ecde41cbead', chars: 8586 },
  "buildShallowBoneCandidates/legacy": { sha256: 'f385c786cb619f3174c613d0f0e83e01', chars: 4409 },
  "buildShallowBoneCandidates/optimal": { sha256: 'f385c786cb619f3174c613d0f0e83e01', chars: 4409 },
  "computeWorldPositions/rigA": { sha256: '57341142e6f602e8e7dfc82eef894936', chars: 719 },
  "computeWorldPositions/rigB": { sha256: 'bc4bfdafddf8e8b6cb0123828c1d1961', chars: 1752 },
  "computeWorldPositions/rigC": { sha256: '278a2418ba1ecb300fd7d925aa8e24b3', chars: 1785 },
  "const/HUMANOID_CORE_BONE_NAMES": { sha256: 'e10321f99346c04ed13c4f07134a9459', chars: 227 },
  "const/POSITION_TOLERANCE_FRACTION": { sha256: '36819111cffb9e1e90eb1fb7c0c29b56', chars: 4 },
  "estimateCoreScale/core-chain": { sha256: 'bf73156dd2db11f02e49aabf63c08e28', chars: 407 },
  "estimateCoreScale/y-span-fallback": { sha256: 'cc25edb65d480137e36558043bfd0747', chars: 323 },
  "estimateUniformScale/A->B": { sha256: '9f0e622b26b62b68399d31304e7599d8', chars: 13 },
  "estimateUniformScale/B->A": { sha256: 'b849fb876ecd94ce030090ccf5d88e95', chars: 14 },
  "estimateUniformScale/empty": { sha256: '6b86b273ff34fce19d6b804eff5a3f57', chars: 1 },
  "labelHumanoidCoreBones/no-bones": { sha256: 'b68adb7caac7a974060d2490e9ec0734', chars: 956 },
  "labelHumanoidCoreBones/no-fork-chain": { sha256: '904a3bacf8c9002ee44881b386106262', chars: 3330 },
  "labelHumanoidCoreBones/rigA": { sha256: '09ce30ba78dab8b0206e98857474ab48', chars: 3235 },
  "labelHumanoidCoreBones/rigB": { sha256: 'ef6e7836f9d743c33e985457dd97ebe1', chars: 3976 },
  "labelHumanoidCoreBones/rigC": { sha256: '5d08a5eb4d340b0d22c1576d17e724d6', chars: 4327 },
  "resolveWithAncestorFallback/complete": { sha256: '3cbe9d7f3c4f27b5dfba14d41076e1b8', chars: 2101 },
  "resolveWithAncestorFallback/holed": { sha256: 'f39a72d3d946587e2a3493524abe4ea5', chars: 2037 },
  "resolveWithAncestorFallbackByParents/node-graph": { sha256: '8abb6d28a48e0476e6979f315f9c73dd', chars: 712 },
  "sourceCoreBonesFromCorrespondence/core-table": { sha256: '9eb99483b655c9664678fd0a3bc2e4a5', chars: 124 },
  "sourceCoreBonesFromCorrespondence/name-table": { sha256: '8f19b89d582195d2b2c176c70e66361c', chars: 32 },
  "transferWeights/collapsing-duplicates": { sha256: 'cd2095173a0a829b9c55bc5ac8447378', chars: 2753 },
  "transferWeights/direct": { sha256: '9e185e27e11d9dcb20101b140eba54ab', chars: 3688 },
  "transferWeights/unresolved": { sha256: '59c3864476d03402dff562988be6dfb0', chars: 2949 },
};

const recorded: Record<string, CaseHash> = Object.fromEntries(
  Object.entries(syntheticCases()).map(([name, value]) => [name, hashOf(value)]),
);

describe('skeleton retarget golden output hashes', () => {
  it('records every case the table knows about, and no others', () => {
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  for (const name of Object.keys(GOLDEN)) {
    it(`${name} is byte-identical to the recorded hash`, () => {
      expect(recorded[name]).toEqual(GOLDEN[name]);
    });
  }
});
