import * as THREE from 'three';

/**
 * Per-joint physics parameters. `node` names a bone in the rig (a glTF joint
 * node name); the joint's simulated "child" is either the chain's next
 * entry (when its node's actual `parent` is this one — see
 * `createSpringBoneSolver`) or, for the last joint in a chain, a synthesized
 * virtual tip continuing this bone's own parent-relative offset one more
 * segment. That virtual-tip case is a documented approximation (there is no
 * way to recover a bone's real visual extent from a skeleton alone) —
 * exactly the same honesty standard as `mesh-shading.ts`'s `'indexedRamp'`
 * mode.
 */
export interface SpringBoneJoint {
  node: string;
  /** 0..1, how strongly this joint's simulated tail is pulled back toward the animated rest pose each fixed sub-step. Higher = stiffer. Default `0.15`. */
  stiffness?: number;
  /** 0..1, fraction of last sub-step's velocity discarded each sub-step (air resistance). `1` kills all motion. Default `0.15`. */
  damping?: number;
  /** World units/second², applied along `gravityDir`. Default `9.8`. */
  gravity?: number;
  /** Unit-ish vector (normalized internally). Default `[0, -1, 0]`. */
  gravityDir?: [number, number, number];
  /** This joint's own collision radius, summed with a collider's radius when testing penetration. Default `0.02`. */
  radius?: number;
}

/** An ordered root→tip run of joints sharing one physical appendage (a cape panel, a hair lock). Joints must form an actual parent→child line in the scene graph — see `createSpringBoneSolver`. */
export interface SpringBoneChain {
  name?: string;
  joints: SpringBoneJoint[];
  /** Names into `SpringBoneConfig.colliderGroups` this chain tests against. Omit for no collision. */
  colliderGroups?: string[];
}

export type SpringBoneCollider =
  | { type: 'sphere'; node: string; offset: [number, number, number]; radius: number }
  | {
      type: 'capsule';
      node: string;
      offset: [number, number, number];
      tail: [number, number, number];
      radius: number;
    };

export interface SpringBoneColliderGroup {
  name: string;
  colliders: SpringBoneCollider[];
}

/**
 * The whole physics rig for one model. Baked into a glTF's `extras` under
 * `SEER_spring_bones` (see `readSpringBoneConfig`) or produced by
 * `deriveSpringBonesFromNames`. No field here is measured from either game's
 * real data — see the module-level doc comment.
 */
export interface SpringBoneConfig {
  chains: SpringBoneChain[];
  colliderGroups?: SpringBoneColliderGroup[];
  /** Fallback values for any joint field a chain's own joints omit. */
  defaults?: Partial<Pick<SpringBoneJoint, 'stiffness' | 'damping' | 'gravity' | 'gravityDir' | 'radius'>>;
}

export interface SpringBoneSolverOptions {
  /** Fixed sub-step size in seconds the accumulator integrates at, independent of `step()`'s own `dt` — this is what keeps the sim's behavior the same whether the host is rendering at 60fps or has dropped to the adaptive frame-limiter's 30fps fallback. Default `1/60`. */
  fixedStep?: number;
  /** Caps how many fixed sub-steps one `step()` call will run — protects against a spiral of death after a tab-backgrounding stall or a slow first frame. Extra accumulated time beyond the cap is dropped, not carried forward. Default `4`. */
  maxSubSteps?: number;
  /** 0..1 global blend between the simulated result (`1`) and the animated rest pose (`0`) — the UI-facing "how much" dial. Default `1`. */
  strength?: number;
}

export interface SpringBoneSolver {
  readonly chainCount: number;
  readonly jointCount: number;
  /** Advances the simulation by `dt` seconds via a fixed-timestep accumulator (see `SpringBoneSolverOptions.fixedStep`/`maxSubSteps`). Mutates each resolved joint node's local `quaternion` and calls `updateMatrixWorld` on it, so callers don't need to flush matrices afterward. Assumes the caller already refreshed the *unsimulated* rig this frame (i.e. this runs after `AnimationMixer.update()`, before the renderer's own `updateMatrixWorld` pass) — see the package README for the exact frame-ordering contract. */
  step(dt: number): void;
  /** Snaps every joint's stored simulation state back to whatever the rig's *current* local rotations already encode, and zeroes velocity — the next `step()` re-centers on that pose instead of interpolating from wherever the sim last left off. Does not itself change any node's rotation (there is nothing to "restore" for a rig actively driven by an `AnimationMixer`; for a static model, this leaves the bind pose one `step()` call away from being overwritten by whatever the sim then computes). */
  reset(): void;
  /** Releases the accumulator's internal state. Does not touch node transforms — the rig is left exactly as the last `step()`/`reset()` left it. */
  dispose(): void;
}

const DEFAULTS = {
  stiffness: 0.15,
  damping: 0.15,
  gravity: 9.8,
  gravityDir: [0, -1, 0] as [number, number, number],
  radius: 0.02,
};

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function isBoneLike(o: THREE.Object3D): boolean {
  return (o as unknown as { isBone?: boolean }).isBone === true || o.type === 'Bone';
}

interface ResolvedCollider {
  node: THREE.Object3D;
  offset: THREE.Vector3;
  radius: number;
  tail: THREE.Vector3 | null;
}

interface ResolvedJoint {
  node: THREE.Object3D;
  /** Node-local direction+length to this joint's simulated child, captured once at resolve time from the rig's rest pose. */
  childLocalOffset: THREE.Vector3;
  length: number;
  stiffness: number;
  damping: number;
  gravity: number;
  gravityDir: THREE.Vector3;
  radius: number;
  colliders: ResolvedCollider[];
  currTail: THREE.Vector3;
  prevTail: THREE.Vector3;
  initialized: boolean;
}

function resolveColliderGroups(
  root: THREE.Object3D,
  groups: SpringBoneColliderGroup[],
): Map<string, ResolvedCollider[]> {
  const resolved = new Map<string, ResolvedCollider[]>();
  for (const group of groups) {
    const colliders: ResolvedCollider[] = [];
    for (const c of group.colliders) {
      const node = root.getObjectByName(c.node);
      if (!node) continue;
      colliders.push({
        node,
        offset: new THREE.Vector3(...c.offset),
        radius: c.radius,
        tail: c.type === 'capsule' ? new THREE.Vector3(...c.tail) : null,
      });
    }
    resolved.set(group.name, colliders);
  }
  return resolved;
}

/**
 * Resolves `config`'s chains against real nodes under `root`, and returns a
 * solver ready to `step()` — or `null` if not a single chain resolved (an
 * unrelated config applied to the wrong model, a name typo, or a config
 * whose every chain got filtered out upstream — see `excludeAnimatedChains`).
 *
 * A chain's joints must form an actual parent→child line in `root`'s scene
 * graph: joint `i+1` must be the *sole* child of joint `i`'s node once the
 * physics is applied, since the whole technique works by rotating joint
 * `i`'s node to reposition joint `i+1`. A chain stops resolving (rather than
 * throwing) at the first joint whose node is missing or whose declared next
 * joint isn't literally its child — the resolved prefix still simulates.
 */
export function createSpringBoneSolver(
  root: THREE.Object3D,
  config: SpringBoneConfig,
  opts: SpringBoneSolverOptions = {},
): SpringBoneSolver | null {
  const fixedStep = opts.fixedStep ?? 1 / 60;
  const maxSubSteps = opts.maxSubSteps ?? 4;
  const strength = clamp01(opts.strength ?? 1);

  const colliderGroups = resolveColliderGroups(root, config.colliderGroups ?? []);
  const defaults = { ...DEFAULTS, ...config.defaults };

  const joints: ResolvedJoint[] = [];
  const chains: ResolvedJoint[][] = [];

  for (const chain of config.chains) {
    const chainColliders = (chain.colliderGroups ?? []).flatMap((name) => colliderGroups.get(name) ?? []);
    const resolvedChain: ResolvedJoint[] = [];

    for (let i = 0; i < chain.joints.length; i++) {
      const spec = chain.joints[i]!;
      const node = root.getObjectByName(spec.node);
      if (!node) break;

      const nextSpec = chain.joints[i + 1];
      let childLocalOffset: THREE.Vector3;
      // A joint whose declared next joint doesn't resolve to a real child
      // still simulates — it just becomes this chain's effective tip (via
      // the same virtual-offset approximation a true end-of-chain joint
      // gets), and the chain stops growing past it rather than trusting
      // whatever came after an already-broken link.
      let brokenLink = false;
      if (nextSpec) {
        const nextNode = root.getObjectByName(nextSpec.node);
        if (nextNode && nextNode.parent === node) {
          childLocalOffset = nextNode.position.clone();
        } else {
          childLocalOffset = node.position.lengthSq() > 0 ? node.position.clone() : new THREE.Vector3(0, -0.05, 0);
          brokenLink = true;
        }
      } else {
        childLocalOffset = node.position.lengthSq() > 0 ? node.position.clone() : new THREE.Vector3(0, -0.05, 0);
      }
      const length = childLocalOffset.length();
      if (length === 0) break;

      resolvedChain.push({
        node,
        childLocalOffset,
        length,
        stiffness: clamp01(spec.stiffness ?? defaults.stiffness),
        damping: clamp01(spec.damping ?? defaults.damping),
        gravity: spec.gravity ?? defaults.gravity,
        gravityDir: new THREE.Vector3(...(spec.gravityDir ?? defaults.gravityDir)).normalize(),
        radius: spec.radius ?? defaults.radius,
        colliders: chainColliders,
        currTail: new THREE.Vector3(),
        prevTail: new THREE.Vector3(),
        initialized: false,
      });
      if (brokenLink) break;
    }

    if (resolvedChain.length > 0) {
      chains.push(resolvedChain);
      joints.push(...resolvedChain);
    }
  }

  if (joints.length === 0) return null;

  let accumulator = 0;
  let disposed = false;

  const nodeWorldPos = new THREE.Vector3();
  const nodeWorldQuat = new THREE.Quaternion();
  const restWorldDir = new THREE.Vector3();
  const restWorldPos = new THREE.Vector3();
  const desiredDir = new THREE.Vector3();
  const nextTail = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const deltaQuat = new THREE.Quaternion();
  const parentWorldQuat = new THREE.Quaternion();

  const simulateJoint = (joint: ResolvedJoint, dt: number): void => {
    const { node } = joint;
    node.getWorldPosition(nodeWorldPos);
    node.getWorldQuaternion(nodeWorldQuat);

    restWorldDir.copy(joint.childLocalOffset).normalize().applyQuaternion(nodeWorldQuat);
    restWorldPos.copy(nodeWorldPos).addScaledVector(restWorldDir, joint.length);

    if (!joint.initialized) {
      joint.currTail.copy(restWorldPos);
      joint.prevTail.copy(restWorldPos);
      joint.initialized = true;
    }

    // Verlet inertia: carry last sub-step's displacement forward, damped.
    velocity.copy(joint.currTail).sub(joint.prevTail).multiplyScalar(1 - joint.damping);
    nextTail.copy(joint.currTail).add(velocity);
    nextTail.addScaledVector(joint.gravityDir, joint.gravity * dt * dt);

    // Stiffness pulls back toward the animated rest pose.
    nextTail.lerp(restWorldPos, joint.stiffness);
    if (strength < 1) nextTail.lerp(restWorldPos, 1 - strength);

    for (const collider of joint.colliders) resolveCollision(nextTail, joint.radius, collider);

    // Re-anchor to the fixed bone length, preserving whichever direction
    // survived gravity/stiffness/collision.
    desiredDir.copy(nextTail).sub(nodeWorldPos);
    if (desiredDir.lengthSq() === 0) desiredDir.copy(restWorldDir);
    else desiredDir.normalize();
    nextTail.copy(nodeWorldPos).addScaledVector(desiredDir, joint.length);

    // The length re-anchor can walk the tail back into a collider it was
    // just pushed out of (their two directions rarely agree exactly) — one
    // more collision pass is cheap positional-constraint-style iteration,
    // not a second physical effect. This doesn't reintroduce the drift the
    // first pass fixed, since only the direction can change relative to the
    // (fixed) `node.getWorldPosition()` origin.
    for (const collider of joint.colliders) resolveCollision(nextTail, joint.radius, collider);

    joint.prevTail.copy(joint.currTail);
    joint.currTail.copy(nextTail);

    // Rotate `node` in world space by the delta from its animated rest
    // direction to the simulated one, then convert back to local so
    // `AnimationMixer.update()` (which only ever writes local TRS) composes
    // cleanly with this on the next frame.
    deltaQuat.setFromUnitVectors(restWorldDir, desiredDir);
    nodeWorldQuat.premultiply(deltaQuat);

    if (node.parent) {
      node.parent.getWorldQuaternion(parentWorldQuat);
      node.quaternion.copy(parentWorldQuat).invert().multiply(nodeWorldQuat);
    } else {
      node.quaternion.copy(nodeWorldQuat);
    }
    node.updateMatrixWorld(true);
  };

  return {
    get chainCount() {
      return chains.length;
    },
    get jointCount() {
      return joints.length;
    },
    step(dt) {
      if (disposed) return;
      accumulator += dt;
      let subSteps = 0;
      while (accumulator >= fixedStep && subSteps < maxSubSteps) {
        root.updateMatrixWorld(true);
        for (const chain of chains) {
          for (const joint of chain) simulateJoint(joint, fixedStep);
        }
        accumulator -= fixedStep;
        subSteps++;
      }
      if (subSteps === maxSubSteps) accumulator = 0;
    },
    reset() {
      accumulator = 0;
      for (const joint of joints) joint.initialized = false;
    },
    dispose() {
      disposed = true;
    },
  };
}

function resolveCollision(tail: THREE.Vector3, jointRadius: number, collider: ResolvedCollider): void {
  const worldPos = collider.node.localToWorld(collider.offset.clone());
  const minDist = collider.radius + jointRadius;

  let center = worldPos;
  if (collider.tail) {
    const worldTail = collider.node.localToWorld(collider.tail.clone());
    center = closestPointOnSegment(tail, worldPos, worldTail);
  }

  const delta = tail.clone().sub(center);
  const dist = delta.length();
  if (dist >= minDist) return;
  if (dist === 0) {
    tail.copy(center).add(new THREE.Vector3(0, minDist, 0));
    return;
  }
  tail.copy(center).addScaledVector(delta.normalize(), minDist);
}

function closestPointOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq === 0) return a;
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / lenSq));
  return a.clone().addScaledVector(ab, t);
}

/**
 * Reads a baked cloth/hair config from a loaded model's glTF `extras`, under
 * the key `SEER_spring_bones` — a plain custom-data key, not a registered
 * glTF extension, so it needs no `extensionsUsed` entry and survives
 * unmodified through any tool that round-trips `extras` (three's
 * `GLTFLoader` copies scene-level `extras` verbatim into `scene.userData`).
 * Returns `null` if absent or structurally invalid (never throws — a
 * malformed blob should degrade to "no physics", not break model loading).
 */
export function readSpringBoneConfig(object: THREE.Object3D): SpringBoneConfig | null {
  const raw = (object.userData as { SEER_spring_bones?: unknown }).SEER_spring_bones;
  if (!raw || typeof raw !== 'object') return null;
  const chains = (raw as { chains?: unknown }).chains;
  if (!Array.isArray(chains)) return null;
  return raw as SpringBoneConfig;
}

/** Drops any chain containing at least one joint the active clip already animates — the caller-facing shape is `session.setSpringBones({ skipAnimatedBones: true })`, wired against `AnimationController.animatedNodeNames()`. Pure and exported directly so the exclusion rule itself is unit-testable without a session. */
export function excludeAnimatedChains(
  config: SpringBoneConfig,
  animatedNodeNames: ReadonlySet<string>,
): SpringBoneConfig {
  return {
    ...config,
    chains: config.chains.filter((chain) => !chain.joints.some((j) => animatedNodeNames.has(j.node))),
  };
}

export interface DeriveSpringBonesOptions {
  /** Matched case-insensitively against each node's `name`. Default covers the common English dangly-appendage vocabulary seen across every surveyed corpus (hair/cape/mantle/skirt/sleeve/tail/wing/scarf/cloth/ribbon/chain/belt/rope/swing/jiggle). */
  pattern?: RegExp;
  /** Safety cap on how many joints one derived chain can grow to. Default `8`. */
  maxChainLength?: number;
}

const DEFAULT_PATTERN =
  /hair|mant|cape|skirt|sleeve|tail|wing|scarf|cloth|ribbon|chain|belt|rope|swing|jiggle/i;

/**
 * Guesses a `SpringBoneConfig` from bone names alone — no authored data from
 * either source game informs this, and it is exactly as reliable as the
 * rig's own naming convention. Correctly returns `null` for a rig with no
 * semantic bone names (e.g. Koei Tecmo G1M skeletons, which the corresponding
 * exporter names `bone0`, `bone1`, ... — see chimera's `g1m-gltf.ts`): there
 * is nothing here to pattern-match, and guessing off pure indices would be a
 * coin flip, not an approximation. Never applied automatically by
 * `MeshSession` — a host opts in via `setSpringBones({ autoDerive: true })`
 * and can inspect or edit the result before using it.
 *
 * A chain root is a name-matching node whose parent does *not* also match
 * (so a matching parent's own forward walk already owns it); the chain then
 * follows single-child `THREE.Bone` descent regardless of whether each
 * further link's own name matches, stopping at a branch, a non-bone child,
 * or `maxChainLength`.
 */
export function deriveSpringBonesFromNames(
  root: THREE.Object3D,
  opts: DeriveSpringBonesOptions = {},
): SpringBoneConfig | null {
  const pattern = opts.pattern ?? DEFAULT_PATTERN;
  const maxChainLength = opts.maxChainLength ?? 8;
  const matches = (o: THREE.Object3D): boolean => !!o.name && pattern.test(o.name);

  const visited = new Set<THREE.Object3D>();
  const chains: SpringBoneChain[] = [];

  root.traverse((node) => {
    if (visited.has(node) || !matches(node)) return;
    if (node.parent && matches(node.parent)) return;

    const joints: SpringBoneJoint[] = [];
    let current: THREE.Object3D | null = node;
    while (current && joints.length < maxChainLength) {
      visited.add(current);
      joints.push({ node: current.name });
      const boneChildren: THREE.Object3D[] = current.children.filter(isBoneLike);
      current = boneChildren.length === 1 ? boneChildren[0]! : null;
    }
    chains.push({ name: node.name, joints });
  });

  return chains.length > 0 ? { chains } : null;
}
