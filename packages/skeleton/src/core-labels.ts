/**
 * Structural naming of a humanoid rig's ~23 core bones — hierarchy and
 * bind-pose geometry only, no bone names (a `TrsBone` has none) and no index
 * assumptions.
 *
 * What this exists for (see `./core-match.js` for the matcher built on it):
 * two engines' core humanoid skeletons are routinely the SAME 21 bones in a
 * DIFFERENT ORDER — one numbers spine1/spine2/neck/head as 3-6 and the legs
 * as 7-14, the other numbers the legs as 3-10 and the spine as 11-14, while
 * clavicles through hands happen to be index-identical. That is a LABELING
 * problem, not a geometric-matching one.
 */
import type { Skeleton, Vec3 } from './types.js';
import { boundingHeight, computePose } from './math.js';
import type { BoneCorrespondence } from './correspondence.js';

export const HUMANOID_CORE_BONE_NAMES = [
  'root', 'pelvis_root', 'hips', 'spine1', 'spine2', 'neck', 'head',
  'l_clavicle', 'r_clavicle', 'l_upperarm', 'r_upperarm', 'l_forearm', 'r_forearm', 'l_hand', 'r_hand',
  'l_thigh', 'r_thigh', 'l_shin', 'r_shin', 'l_foot', 'r_foot', 'l_toe', 'r_toe',
] as const;
export type HumanoidCoreBoneName = (typeof HUMANOID_CORE_BONE_NAMES)[number];

export interface HumanoidCoreLabels {
  byName: Partial<Record<HumanoidCoreBoneName, number>>;
  byIndex: Map<number, HumanoidCoreBoneName>;
  /** Per labeled name: the structural evidence that named it (for a human reviewing the labeling). */
  evidence: Partial<Record<HumanoidCoreBoneName, string>>;
  /** Per name that could NOT be labeled: why. Never silently absent. */
  unlabeled: Partial<Record<HumanoidCoreBoneName, string>>;
  /** Bind-pose world position per bone (same FK as everything else here), exposed for review tooling. */
  worldPositions: Vec3[];
}

/**
 * Name a humanoid rig's core bones from structure alone. Rules (every one
 * recorded in `evidence`):
 *
 * - `root`: the parentless bone with the largest subtree.
 * - `hips`: the first bone on the root's main chain (always descending into
 *   the largest-subtree child) with lateral limb subtrees on BOTH sides
 *   (a "limb subtree" = >= 3 bones whose own main child sits >= 2% of the
 *   rig's height off the midline). `pelvis_root`: hips' parent when that
 *   isn't the root itself (the redundant control bone many rigs
 *   place directly above the functional hip).
 * - `l_thigh`/`r_thigh`: hips' limb subtrees, +X = left (the Y-up,
 *   +X-left convention this package assumes throughout). If a
 *   side has several limb subtrees the largest wins (reported).
 * - `spine1`: hips' largest non-limb, on-midline child. `spine2` (chest):
 *   the first bone on spine1's main chain that again forks into lateral
 *   limb subtrees (the arms). A rig with only one spine bone leaves spine2
 *   unlabeled; a rig with three reports the extra one in the evidence.
 * - `l_clavicle`/`r_clavicle`: the chest's limb subtrees by side. `neck`: the
 *   chest's largest non-limb on-midline child; `head`: neck's main child.
 * - `*_upperarm`/`*_forearm`/`*_hand` and `*_shin`/`*_foot`/`*_toe`: main
 *   child of main child down each limb (twist helpers and sockets are
 *   1-bone leaves, so "largest subtree" is exactly "the real joint chain").
 *
 * Purely structural — never assumes an index, which is the whole point:
 * the same function labels both sides of a cross-family correspondence.
 */
export function labelHumanoidCoreBones(skeleton: Skeleton): HumanoidCoreLabels {
  const bones = skeleton.bones;
  const pose = computePose(bones);
  const height = boundingHeight(pose.position);
  const lateralMin = Math.max(1e-3, 0.02 * height);
  const size = new Int32Array(bones.length);
  const sizeOf = (i: number): number => {
    if (size[i]! > 0) return size[i]!;
    let n = 1;
    for (const c of pose.children[i]!) n += sizeOf(c);
    size[i] = n;
    return n;
  };
  for (let i = 0; i < bones.length; i++) sizeOf(i);
  const mainChild = (i: number): number | undefined => {
    let best: number | undefined, bestSize = -1;
    for (const c of pose.children[i]!) { const s = sizeOf(c); if (s > bestSize) { bestSize = s; best = c; } }
    return best;
  };
  const lateral = (i: number): number => {
    const own = Math.abs(pose.position[i]!.x);
    const mc = mainChild(i);
    return mc === undefined ? own : Math.max(own, Math.abs(pose.position[mc]!.x));
  };
  const side = (i: number): number => {
    const mc = mainChild(i);
    const x = Math.abs(pose.position[i]!.x) >= lateralMin || mc === undefined ? pose.position[i]!.x : pose.position[mc]!.x;
    return Math.sign(x);
  };
  const isLimb = (i: number): boolean => sizeOf(i) >= 3 && lateral(i) >= lateralMin;

  const byName: Partial<Record<HumanoidCoreBoneName, number>> = {};
  const evidence: Partial<Record<HumanoidCoreBoneName, string>> = {};
  const unlabeled: Partial<Record<HumanoidCoreBoneName, string>> = {};
  const set = (name: HumanoidCoreBoneName, index: number | undefined, why: string): void => {
    if (index === undefined) { unlabeled[name] = why; return; }
    byName[name] = index; evidence[name] = why;
  };
  const p = (i: number): string => { const v = pose.position[i]!; return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`; };

  // root
  let root = -1, rootSize = -1;
  for (const r of pose.roots) { const s = sizeOf(r); if (s > rootSize) { rootSize = s; root = r; } }
  if (root < 0) {
    for (const n of HUMANOID_CORE_BONE_NAMES) unlabeled[n] = 'skeleton has no root bone';
    return { byName, byIndex: new Map(), evidence, unlabeled, worldPositions: pose.position };
  }
  set('root', root, `parentless bone with the largest subtree (${rootSize} of ${bones.length} bones)`);

  /** Walk the main chain from `from` until a bone forks into limb subtrees on both sides; returns that bone, the limbs by side, and the chain walked. */
  const findFork = (from: number, maxSteps: number): { at: number; left: number[]; right: number[]; chain: number[] } | undefined => {
    let cur: number | undefined = from;
    const chain: number[] = [];
    for (let step = 0; cur !== undefined && step <= maxSteps; step++) {
      const limbs = pose.children[cur]!.filter(isLimb);
      const left = limbs.filter((c) => side(c) > 0).sort((a, b) => sizeOf(b) - sizeOf(a));
      const right = limbs.filter((c) => side(c) < 0).sort((a, b) => sizeOf(b) - sizeOf(a));
      if (left.length > 0 && right.length > 0) return { at: cur, left, right, chain };
      chain.push(cur);
      cur = mainChild(cur);
    }
    return undefined;
  };

  const hipFork = findFork(root, 8);
  if (!hipFork) {
    for (const n of HUMANOID_CORE_BONE_NAMES) if (n !== 'root') unlabeled[n] = 'no bone on the root\'s main chain forks into lateral limb subtrees on both sides (not a bipedal humanoid rig, or a head/prop rig)';
    return { byName, byIndex: indexMap(byName), evidence, unlabeled, worldPositions: pose.position };
  }
  const hips = hipFork.at;
  set('hips', hips, `first bone on the root's main chain with lateral limb subtrees on both sides: +X ${hipFork.left.map((c) => `${c} (${sizeOf(c)} bones)`).join(', ')}; -X ${hipFork.right.map((c) => `${c} (${sizeOf(c)} bones)`).join(', ')}; ${pose.children[hips]!.length} children total; world ${p(hips)}`);
  const hipsParent = bones[hips]!.parent;
  if (hipsParent >= 0 && hipsParent !== root) {
    set('pelvis_root', hipsParent, `hips' parent, not the root itself (${hipFork.chain.length - 1 > 1 ? `${hipFork.chain.length - 1} bones between root and hips — only the immediate parent is labeled` : 'exactly one bone between root and hips'}); world ${p(hipsParent)}`);
  } else {
    unlabeled.pelvis_root = 'hips hang directly off the root — no intermediate control bone on this rig';
  }
  set('l_thigh', hipFork.left[0], `hips' largest +X limb subtree${hipFork.left.length > 1 ? ` (of ${hipFork.left.length} on that side)` : ''}; world ${p(hipFork.left[0]!)}`);
  set('r_thigh', hipFork.right[0], `hips' largest -X limb subtree${hipFork.right.length > 1 ? ` (of ${hipFork.right.length} on that side)` : ''}; world ${p(hipFork.right[0]!)}`);
  for (const [sideName, thigh] of [['l', hipFork.left[0]!], ['r', hipFork.right[0]!]] as const) {
    const shin = mainChild(thigh);
    set(`${sideName}_shin`, shin, shin === undefined ? `${sideName}_thigh has no children` : `main (largest-subtree) child of ${sideName}_thigh; world ${p(shin)}`);
    const foot = shin === undefined ? undefined : mainChild(shin);
    set(`${sideName}_foot`, foot, foot === undefined ? `${sideName}_shin has no children` : `main child of ${sideName}_shin; world ${p(foot)}`);
    const toe = foot === undefined ? undefined : mainChild(foot);
    set(`${sideName}_toe`, toe, toe === undefined ? `${sideName}_foot has no children` : `main child of ${sideName}_foot; world ${p(toe)}`);
  }

  // spine
  const spineCandidates = pose.children[hips]!.filter((c) => !isLimb(c) && Math.abs(pose.position[c]!.x) < lateralMin && sizeOf(c) >= 5).sort((a, b) => sizeOf(b) - sizeOf(a));
  const spine1: number | undefined = spineCandidates[0];
  if (spine1 === undefined) {
    for (const n of ['spine1', 'spine2', 'neck', 'head', 'l_clavicle', 'r_clavicle', 'l_upperarm', 'r_upperarm', 'l_forearm', 'r_forearm', 'l_hand', 'r_hand'] as const) unlabeled[n] = 'hips have no on-midline non-limb child with >= 5 bones (no spine)';
    return { byName, byIndex: indexMap(byName), evidence, unlabeled, worldPositions: pose.position };
  }
  set('spine1', spine1, `hips' largest on-midline non-limb child (${sizeOf(spine1)} bones); world ${p(spine1)}`);
  const chestFork = findFork(mainChild(spine1) ?? -1, 6);
  if (!chestFork || chestFork.at < 0) {
    for (const n of ['spine2', 'neck', 'head', 'l_clavicle', 'r_clavicle', 'l_upperarm', 'r_upperarm', 'l_forearm', 'r_forearm', 'l_hand', 'r_hand'] as const) unlabeled[n] = 'no bone on spine1\'s main chain forks into lateral limb subtrees on both sides (no arms)';
    return { byName, byIndex: indexMap(byName), evidence, unlabeled, worldPositions: pose.position };
  }
  const chest = chestFork.at;
  set('spine2', chest, `first bone on spine1's main chain that forks into lateral limb subtrees (the arms)${chestFork.chain.length > 0 ? `; NOTE ${chestFork.chain.length} extra spine bone(s) between spine1 and it (${chestFork.chain.join(',')}) left unlabeled` : ''}; ${pose.children[chest]!.length} children total; world ${p(chest)}`);
  set('l_clavicle', chestFork.left[0], `chest's largest +X limb subtree${chestFork.left.length > 1 ? ` (of ${chestFork.left.length} on that side)` : ''}; world ${p(chestFork.left[0]!)}`);
  set('r_clavicle', chestFork.right[0], `chest's largest -X limb subtree${chestFork.right.length > 1 ? ` (of ${chestFork.right.length} on that side)` : ''}; world ${p(chestFork.right[0]!)}`);
  for (const [sideName, clav] of [['l', chestFork.left[0]!], ['r', chestFork.right[0]!]] as const) {
    const upper = mainChild(clav);
    set(`${sideName}_upperarm`, upper, upper === undefined ? `${sideName}_clavicle has no children` : `main child of ${sideName}_clavicle; world ${p(upper)}`);
    const fore = upper === undefined ? undefined : mainChild(upper);
    set(`${sideName}_forearm`, fore, fore === undefined ? `${sideName}_upperarm has no children` : `main child of ${sideName}_upperarm; world ${p(fore)}`);
    const hand = fore === undefined ? undefined : mainChild(fore);
    set(`${sideName}_hand`, hand, hand === undefined ? `${sideName}_forearm has no children` : `main child of ${sideName}_forearm; world ${p(hand)}`);
  }
  const neckCandidates = pose.children[chest]!.filter((c) => !isLimb(c) && Math.abs(pose.position[c]!.x) < lateralMin && sizeOf(c) >= 2 && pose.position[c]!.y > pose.position[chest]!.y).sort((a, b) => sizeOf(b) - sizeOf(a));
  const neck: number | undefined = neckCandidates[0];
  set('neck', neck, neck === undefined ? 'chest has no on-midline, upward, >= 2-bone non-limb child' : `chest's largest on-midline upward non-limb child (${sizeOf(neck)} bones); world ${p(neck)}`);
  const head = neck === undefined ? undefined : mainChild(neck);
  set('head', head, head === undefined ? 'neck has no children' : `main child of neck (${sizeOf(head)} bones); world ${p(head)}`);

  return { byName, byIndex: indexMap(byName), evidence, unlabeled, worldPositions: pose.position };
}

function indexMap(byName: Partial<Record<HumanoidCoreBoneName, number>>): Map<number, HumanoidCoreBoneName> {
  const m = new Map<number, HumanoidCoreBoneName>();
  for (const [name, idx] of Object.entries(byName) as [HumanoidCoreBoneName, number][]) m.set(idx, name);
  return m;
}

/**
 * The source rig's core bones by canonical name, read off a correspondence
 * table through the TARGET's structural labels — works for a source with no
 * labeler of its own (one matched by a name-keyed table, say) as well as for
 * one that has one. A core name whose target bone has no correspondence entry is
 * simply absent.
 */
export function sourceCoreBonesFromCorrespondence(correspondence: BoneCorrespondence, targetLabels: HumanoidCoreLabels): Partial<Record<HumanoidCoreBoneName, number>> {
  const out: Partial<Record<HumanoidCoreBoneName, number>> = {};
  for (const e of correspondence.entries) {
    const name = targetLabels.byIndex.get(e.targetIndex);
    if (name !== undefined && out[name] === undefined) out[name] = e.sourceIndex;
  }
  return out;
}
