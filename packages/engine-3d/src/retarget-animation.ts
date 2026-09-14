import * as THREE from 'three';

/**
 * `setExternalAnimations()`'s node-NAME binding is a stopgap: a G1M/glTF
 * export names bone nodes `bone${i}` purely by that bone's position in ITS
 * OWN file's bone array (see `src/data/formats/g1m.ts`'s `G1MBone` — no
 * name/semantic id field exists anywhere in the source format), so `bone42`
 * in one character's rig and `bone42` in a different character's rig share
 * nothing but a coincidental index. Applying a clip across two different
 * G1M exports by raw name match (three.js's own `PropertyBinding`) moves
 * REAL scene nodes — they just aren't anatomically the same joint, and
 * usually aren't referenced by the displayed mesh's own skin at all, so the
 * motion is invisible (see `docs/fe-threehouses.md`, "cross-appearance"
 * root-cause section, 2026-09-02).
 *
 * This module builds an actual bone-to-bone correspondence between two
 * skeletons using the only data a G1M bone carries — its parent-chain
 * position and local bind-pose transform (`position`/`quaternion`/`scale`,
 * which for a freshly-loaded, never-yet-posed glTF node IS the bind pose) —
 * then rewrites a clip's track target names through that correspondence
 * before it reaches `setExternalAnimations()`. A source bone with no
 * reasonable match (accessory/cloth/weapon-attach bones unique to one
 * character, or the far side of a body-type difference) is dropped rather
 * than forced onto the nearest node — a dropped bone just doesn't animate,
 * exactly like `setExternalAnimations()`'s existing "unmatched name" case,
 * which is a safe degrade for a viewer tool but NOT a claim of correctness:
 * see this module's own doc comments below for what this approximates and
 * where it can go wrong.
 */

interface BoneNode {
  name: string;
  parent: string | null;
  children: string[];
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

const BONE_NAME_RE = /^bone(\d+)$/;

/** Walks `root` and collects every `bone<N>`-named descendant with its nearest bone-named ancestor as `parent` (skipping non-bone nodes in between, e.g. a mesh/skin wrapper) and its local bind-pose transform. Ignores `bone<N>_alias<K>` duplicate-joint nodes (`g1m-gltf.ts`'s own doc comment on skin-joint uniqueness) — they share their base bone's transform, so the base name alone is enough to anchor a match. */
function collectBones(root: THREE.Object3D): Map<string, BoneNode> {
  const bones = new Map<string, BoneNode>();
  root.traverse((node) => {
    if (!BONE_NAME_RE.test(node.name)) return;
    let p: THREE.Object3D | null = node.parent;
    let parentName: string | null = null;
    while (p) {
      if (BONE_NAME_RE.test(p.name)) {
        parentName = p.name;
        break;
      }
      p = p.parent;
    }
    bones.set(node.name, {
      name: node.name,
      parent: parentName,
      children: [],
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
    });
  });
  for (const bone of bones.values()) {
    if (bone.parent !== null) bones.get(bone.parent)?.children.push(bone.name);
  }
  return bones;
}

/** Lower is a better match. Combines bind-pose offset *direction* (scale-independent — the two rigs' overall proportions can differ) with a bounded magnitude-ratio penalty, so a same-direction joint at a very different distance from its parent still loses to a closer magnitude match. */
function boneDistance(a: BoneNode, b: BoneNode): number {
  const lenA = a.position.length();
  const lenB = b.position.length();
  let directionCost = 1;
  if (lenA > 1e-6 && lenB > 1e-6) {
    const cos = a.position.dot(b.position) / (lenA * lenB);
    directionCost = 1 - Math.max(-1, Math.min(1, cos));
  } else if (lenA <= 1e-6 && lenB <= 1e-6) {
    directionCost = 0;
  }
  const magRatio = lenA > 1e-6 || lenB > 1e-6 ? Math.abs(lenA - lenB) / Math.max(lenA, lenB, 1e-6) : 0;
  const rotationCost = 1 - Math.abs(a.quaternion.dot(b.quaternion));
  return directionCost * 2 + magRatio + rotationCost * 0.5;
}

/** Root candidates: bone nodes with no bone-named parent. Real skeletons have exactly one; a corpus quirk (a detached accessory root sharing the `bone<N>` pattern) could produce more, so this pairs them positionally rather than assuming a single root. */
function findRoots(bones: Map<string, BoneNode>): string[] {
  return [...bones.values()].filter((b) => b.parent === null).map((b) => b.name);
}

const UNMATCHED_THRESHOLD = 2.2;

/**
 * Builds a `sourceName -> targetName` translation over every bone
 * reachable, top-down, by mutual nearest-neighbor matching at each level of
 * the hierarchy (greedy, not a global optimum — see module doc comment).
 * A source bone whose best available target sibling still scores above
 * `UNMATCHED_THRESHOLD`, or whose subtree has no candidates left, is
 * omitted from the map entirely.
 */
export function buildBoneCorrespondence(
  sourceRoot: THREE.Object3D,
  targetRoot: THREE.Object3D,
): Map<string, string> {
  const sourceBones = collectBones(sourceRoot);
  const targetBones = collectBones(targetRoot);
  const map = new Map<string, string>();
  if (sourceBones.size === 0 || targetBones.size === 0) return map;

  const matchChildren = (sourceParent: string | null, targetParent: string | null): void => {
    const sourceChildren = sourceParent === null ? findRoots(sourceBones) : sourceBones.get(sourceParent)!.children;
    const remainingTargets = new Set(
      targetParent === null ? findRoots(targetBones) : targetBones.get(targetParent)!.children,
    );
    const candidates: { s: string; t: string; cost: number }[] = [];
    for (const s of sourceChildren) {
      for (const t of remainingTargets) {
        candidates.push({ s, t, cost: boneDistance(sourceBones.get(s)!, targetBones.get(t)!) });
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const matchedSources = new Set<string>();
    for (const { s, t, cost } of candidates) {
      if (matchedSources.has(s) || !remainingTargets.has(t)) continue;
      if (cost > UNMATCHED_THRESHOLD) continue;
      matchedSources.add(s);
      remainingTargets.delete(t);
      map.set(s, t);
      matchChildren(s, t);
    }
  };

  matchChildren(null, null);
  return map;
}

/**
 * Rewrites `clips`' track target names from `sourceRoot`'s bone identity to
 * `targetRoot`'s via `buildBoneCorrespondence()`, for use in place of
 * passing a foreign-rig clip straight to
 * `MeshSession.setExternalAnimations()`. A track whose bone has no
 * correspondence entry is dropped (not left name-mismatched) since an
 * unmapped source bone binding to a same-numbered but unrelated target bone
 * by coincidence would be worse than not animating it at all. Non-bone
 * tracks (e.g. morph targets on a mesh node) pass through unchanged, since
 * mesh/morph node names aren't part of the `bone<N>` correspondence and are
 * typically shared verbatim only for a genuinely native clip anyway.
 */
export function retargetClipsToSkeleton(
  clips: THREE.AnimationClip[],
  sourceRoot: THREE.Object3D,
  targetRoot: THREE.Object3D,
): THREE.AnimationClip[] {
  const correspondence = buildBoneCorrespondence(sourceRoot, targetRoot);
  return clips.map((clip) => {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const nodeName = parsed.nodeName;
      if (!BONE_NAME_RE.test(nodeName)) {
        tracks.push(track.clone());
        continue;
      }
      const targetName = correspondence.get(nodeName);
      if (!targetName) continue;
      const suffix = track.name.slice(track.name.indexOf(nodeName) + nodeName.length);
      const retargeted = track.clone();
      retargeted.name = `${targetName}${suffix}`;
      tracks.push(retargeted);
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  });
}
