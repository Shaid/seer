import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createAnimationController } from '../animation.js';

function makeClip(name: string): THREE.AnimationClip {
  // A minimal, harmless track — AnimationMixer/AnimationClip don't care that
  // '.rotation' isn't a bindable property on a bare Object3D root for these
  // tests, since nothing here ever calls update()/play() through to a real
  // render.
  const track = new THREE.NumberKeyframeTrack('.scale[x]', [0, 1], [1, 1]);
  return new THREE.AnimationClip(name, 1, [track]);
}

describe('createAnimationController — duplicate clip names', () => {
  it('disambiguates duplicate clip names instead of letting a later clip silently clobber an earlier one', () => {
    const root = new THREE.Object3D();
    const clips = [makeClip('Walk'), makeClip('Walk'), makeClip('Run')];
    const controller = createAnimationController(root, clips)!;

    expect(controller.clipNames).toEqual(['Walk', 'Walk (2)', 'Run']);
  });

  it('every disambiguated name is independently playable', () => {
    const root = new THREE.Object3D();
    const clips = [makeClip('Walk'), makeClip('Walk'), makeClip('Walk')];
    const controller = createAnimationController(root, clips)!;

    controller.play('Walk (3)');
    expect(controller.currentClip).toBe('Walk (3)');
  });

  it('leaves unique clip names untouched', () => {
    const root = new THREE.Object3D();
    const clips = [makeClip('Idle'), makeClip('Walk'), makeClip('Run')];
    const controller = createAnimationController(root, clips)!;

    expect(controller.clipNames).toEqual(['Idle', 'Walk', 'Run']);
  });
});
