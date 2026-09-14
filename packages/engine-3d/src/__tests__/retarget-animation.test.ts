import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBoneCorrespondence, retargetClipsToSkeleton } from '../retarget-animation.js';

/** A tiny 3-bone chain (root -> mid -> tip), each bone named `bone<index>` per the source array position passed in (mimicking two DIFFERENT G1M exports whose own bone arrays assign the same anatomical joint a different index). */
function makeChain(root: THREE.Object3D, names: string[], offsets: [number, number, number][]): THREE.Object3D[] {
  const bones: THREE.Object3D[] = [];
  let parent: THREE.Object3D = root;
  for (let i = 0; i < names.length; i++) {
    const bone = new THREE.Object3D();
    bone.name = names[i]!;
    bone.position.set(...offsets[i]!);
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }
  return bones;
}

describe('buildBoneCorrespondence', () => {
  it('matches bones by bind-pose topology even when the two rigs number them differently', () => {
    // Source: bone0 (root) -> bone1 (+1,0,0) -> bone2 (+1,0,0)
    const sourceRoot = new THREE.Object3D();
    makeChain(sourceRoot, ['bone0', 'bone1', 'bone2'], [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);

    // Target: same chain, same bind pose, but the SAME anatomical joints
    // sit at different array indices (bone5/bone9/bone12) — as they would
    // across two independently-exported G1M packs.
    const targetRoot = new THREE.Object3D();
    makeChain(targetRoot, ['bone5', 'bone9', 'bone12'], [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);

    const map = buildBoneCorrespondence(sourceRoot, targetRoot);
    expect(map.get('bone0')).toBe('bone5');
    expect(map.get('bone1')).toBe('bone9');
    expect(map.get('bone2')).toBe('bone12');
  });

  it('drops a source bone with no reasonable target match instead of forcing a coincidental index match', () => {
    const sourceRoot = new THREE.Object3D();
    makeChain(sourceRoot, ['bone0', 'bone1'], [
      [0, 0, 0],
      [0, 1, 0], // straight up
    ]);

    const targetRoot = new THREE.Object3D();
    // Target's "bone1" sits in the OPPOSITE direction from source bone1's
    // straight-up offset — so it should NOT be accepted as a match just
    // because it's the only candidate at that level.
    makeChain(targetRoot, ['bone1', 'bone0'], [
      [0, 0, 0],
      [0, -1, 0],
    ]);

    const map = buildBoneCorrespondence(sourceRoot, targetRoot);
    expect(map.get('bone0')).toBe('bone1'); // roots always pair, regardless of name
    expect(map.has('bone1')).toBe(false); // straight-up vs. sideways: rejected
  });

  it('handles skeletons of different sizes without matching leftover bones on either side', () => {
    const sourceRoot = new THREE.Object3D();
    makeChain(sourceRoot, ['bone0', 'bone1'], [
      [0, 0, 0],
      [1, 0, 0],
    ]);

    const targetRoot = new THREE.Object3D();
    // Target has an extra branch off the root that the source rig has no
    // counterpart for (e.g. a cape bone unique to one character).
    const root = new THREE.Object3D();
    root.name = 'bone3';
    targetRoot.add(root);
    const arm = new THREE.Object3D();
    arm.name = 'bone4';
    arm.position.set(1, 0, 0);
    root.add(arm);
    const cape = new THREE.Object3D();
    cape.name = 'bone7';
    cape.position.set(0, -1, 0);
    root.add(cape);

    const map = buildBoneCorrespondence(sourceRoot, targetRoot);
    expect(map.get('bone0')).toBe('bone3');
    expect(map.get('bone1')).toBe('bone4');
    expect([...map.values()]).not.toContain('bone7');
  });
});

describe('retargetClipsToSkeleton', () => {
  it('rewrites a clip authored against the source rig to target the corresponding bones on a different rig', () => {
    const sourceRoot = new THREE.Object3D();
    makeChain(sourceRoot, ['bone0', 'bone1'], [
      [0, 0, 0],
      [1, 0, 0],
    ]);
    const targetRoot = new THREE.Object3D();
    makeChain(targetRoot, ['bone8', 'bone9'], [
      [0, 0, 0],
      [1, 0, 0],
    ]);

    const track = new THREE.VectorKeyframeTrack('bone1.position', [0, 1], [0, 0, 0, 1, 1, 1]);
    const clip = new THREE.AnimationClip('wave', 1, [track]);

    const [retargeted] = retargetClipsToSkeleton([clip], sourceRoot, targetRoot);
    expect(retargeted!.tracks).toHaveLength(1);
    expect(retargeted!.tracks[0]!.name).toBe('bone9.position');
  });

  it('drops tracks for bones with no correspondence rather than leaving them mismatched', () => {
    const sourceRoot = new THREE.Object3D();
    makeChain(sourceRoot, ['bone0', 'bone1'], [
      [0, 0, 0],
      [0, 1, 0],
    ]);
    const targetRoot = new THREE.Object3D();
    makeChain(targetRoot, ['bone0', 'bone1'], [
      [0, 0, 0],
      [0, -1, 0], // opposite direction — rejected by buildBoneCorrespondence
    ]);

    const track = new THREE.VectorKeyframeTrack('bone1.position', [0, 1], [0, 0, 0, 1, 1, 1]);
    const clip = new THREE.AnimationClip('wave', 1, [track]);

    const [retargeted] = retargetClipsToSkeleton([clip], sourceRoot, targetRoot);
    expect(retargeted!.tracks).toHaveLength(0);
  });

  it('passes non-bone tracks through unchanged', () => {
    const sourceRoot = new THREE.Object3D();
    makeChain(sourceRoot, ['bone0'], [[0, 0, 0]]);
    const targetRoot = new THREE.Object3D();
    makeChain(targetRoot, ['bone3'], [[0, 0, 0]]);

    const track = new THREE.NumberKeyframeTrack('mesh0.morphTargetInfluences[0]', [0, 1], [0, 1]);
    const clip = new THREE.AnimationClip('blink', 1, [track]);

    const [retargeted] = retargetClipsToSkeleton([clip], sourceRoot, targetRoot);
    expect(retargeted!.tracks).toHaveLength(1);
    expect(retargeted!.tracks[0]!.name).toBe('mesh0.morphTargetInfluences[0]');
  });
});
