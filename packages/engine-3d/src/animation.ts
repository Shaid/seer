import * as THREE from 'three';

/**
 * The explicit-mixer plumbing that replaces flower's global-reach mixer
 * bookkeeping (`meshState.mixer`/`.actions`/`.currentAction`, `playMeshClip`,
 * `toggleMeshAnimPlayback` — `viewer.ts:1012-1031,1422-1452`). A host wires
 * `update` into `ViewportOptions.onFrame` and drives everything else (a clip
 * dropdown, a play/pause button) off `clipNames`/`currentClip`/`paused`.
 */
export interface AnimationController {
  readonly clipNames: string[];
  readonly currentClip: string | null;
  readonly paused: boolean;
  /** Advances the mixer by `dt` seconds. Wire into `ViewportOptions.onFrame`. */
  update(dt: number): void;
  /**
   * Plays `name`'s clip, crossfading from whatever was playing before (a
   * no-op fade if nothing was). Does nothing if `name` doesn't match a known
   * clip. `fadeSeconds` defaults to `0.2`, matching flower's original
   * `fadeOut(0.2)`/`fadeIn(0.2)` (`viewer.ts:1434,1436`).
   */
  play(name: string, fadeSeconds?: number): void;
  /** Pauses the current clip if playing, resumes it if paused. Does nothing if no clip has ever been played. */
  togglePause(): void;
  /** Stops all actions and clears `currentClip`. */
  stop(): void;
  /** Stops all actions and releases the mixer's binding to `root`. */
  dispose(): void;
}

/**
 * Builds an `AnimationController` over `root`'s bones/morph targets for
 * `clips`. Returns `null` if `clips` is empty — mirrors flower's own
 * `if (gltf.animations.length > 0)` guard (`viewer.ts:1260`): a mesh with no
 * baked clips gets no controller and no anim UI, rather than an empty one.
 */
export function createAnimationController(root: THREE.Object3D, clips: THREE.AnimationClip[]): AnimationController | null {
  if (clips.length === 0) return null;

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of clips) actions.set(clip.name, mixer.clipAction(clip));

  let currentAction: THREE.AnimationAction | null = null;
  let currentName: string | null = null;

  return {
    get clipNames() {
      return [...actions.keys()];
    },
    get currentClip() {
      return currentName;
    },
    get paused() {
      return currentAction?.paused ?? false;
    },
    update(dt) {
      mixer.update(dt);
    },
    play(name, fadeSeconds = 0.2) {
      const next = actions.get(name);
      if (!next) return;
      if (currentAction && currentAction !== next) currentAction.fadeOut(fadeSeconds);
      next.reset().fadeIn(fadeSeconds).play();
      currentAction = next;
      currentName = name;
    },
    togglePause() {
      if (!currentAction) return;
      currentAction.paused = !currentAction.paused;
    },
    stop() {
      mixer.stopAllAction();
      currentAction = null;
      currentName = null;
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      actions.clear();
      currentAction = null;
      currentName = null;
    },
  };
}
