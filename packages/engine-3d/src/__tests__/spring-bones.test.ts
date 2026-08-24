import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createSpringBoneSolver,
  deriveSpringBonesFromNames,
  excludeAnimatedChains,
  readSpringBoneConfig,
  type SpringBoneConfig,
} from '../spring-bones.js';

/**
 * A straight 4-bone chain extending sideways from `root` along +X, each bone
 * a `THREE.Bone` 0.2 units from its parent — a rest pose *perpendicular* to
 * gravity (-Y), the way a stiff ponytail or cape edge is authored before
 * physics droops it. Deliberately not aligned with gravity: a chain that
 * already hangs straight down has no torque to respond to (a pendulum at its
 * own equilibrium doesn't move), which would make every "does gravity do
 * anything" assertion vacuously true.
 */
function makeChain(names: string[], root = new THREE.Object3D()): { root: THREE.Object3D; bones: THREE.Bone[] } {
  root.name = 'root';
  const bones: THREE.Bone[] = [];
  let parent: THREE.Object3D = root;
  for (const name of names) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(0.2, 0, 0);
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }
  root.updateMatrixWorld(true);
  return { root, bones };
}

function config(joints: string[]): SpringBoneConfig {
  return { chains: [{ joints: joints.map((node) => ({ node })) }] };
}

describe('createSpringBoneSolver', () => {
  it('returns null when no chain resolves', () => {
    const { root } = makeChain(['A', 'B']);
    expect(createSpringBoneSolver(root, config(['nope']))).toBeNull();
  });

  it('resolves a partial prefix when a later joint is missing, rather than failing entirely', () => {
    const { root } = makeChain(['A', 'B', 'C']);
    const solver = createSpringBoneSolver(root, config(['A', 'B', 'missing', 'C']));
    expect(solver).not.toBeNull();
    expect(solver!.jointCount).toBe(2); // A, B — the chain stops at the unresolved joint
  });

  it('a chain at rest (zero gravity) stays at rest', () => {
    const { root, bones } = makeChain(['A', 'B', 'C']);
    const solver = createSpringBoneSolver(root, {
      chains: [{ joints: ['A', 'B', 'C'].map((node) => ({ node, gravity: 0 })) }],
    })!;
    const before = bones.map((b) => b.quaternion.clone());
    for (let i = 0; i < 30; i++) solver.step(1 / 60);
    const after = bones.map((b) => b.quaternion.clone());
    before.forEach((q, i) => expect(q.angleTo(after[i]!)).toBeCloseTo(0, 5));
  });

  it('gravity deflects the chain downward from its rest pose', () => {
    const { root, bones } = makeChain(['A', 'B', 'C']);
    const solver = createSpringBoneSolver(root, config(['A', 'B', 'C']))!;
    const tipRestY = bones[2]!.getWorldPosition(new THREE.Vector3()).y;
    for (let i = 0; i < 120; i++) solver.step(1 / 60);
    const tipY = bones[2]!.getWorldPosition(new THREE.Vector3()).y;
    expect(tipY).toBeLessThan(tipRestY);
  });

  it('settles to a stable pose under constant gravity (energy dissipates)', () => {
    const { root, bones } = makeChain(['A', 'B', 'C', 'D']);
    const solver = createSpringBoneSolver(root, config(['A', 'B', 'C', 'D']))!;
    for (let i = 0; i < 300; i++) solver.step(1 / 60);
    const posBefore = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    for (let i = 0; i < 60; i++) solver.step(1 / 60);
    const posAfter = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    posBefore.forEach((p, i) => expect(p.distanceTo(posAfter[i]!)).toBeLessThan(0.01));
  });

  it('stiffness holds a shape against gravity instead of drooping to the same fully-collapsed pose regardless of its value', () => {
    // Regression test for a bug where `restWorldDir` (the "pull back toward
    // rest" target) was derived from the joint's own CURRENT world
    // quaternion — the exact value the sim itself had just written the
    // previous sub-step. That made "rest" self-referential: whatever a
    // joint drooped to became its own new rest, so stiffness < 1 could never
    // actually pull back toward anything, and every chain — regardless of
    // its configured stiffness — settled to the same fully-collapsed,
    // hanging-straight-down-under-gravity-and-damping-alone pose. A fixed
    // rest reference (captured once at resolve time, rotated rigidly with
    // the parent each step) means stiffness should visibly matter: a
    // high-stiffness chain should settle much closer to its rest pose than
    // a nearly-limp one simulated under the identical gravity/damping.
    const buildAndSettle = (stiffness: number) => {
      const { root, bones } = makeChain(['A', 'B', 'C', 'D']);
      const solver = createSpringBoneSolver(root, {
        chains: [{ joints: ['A', 'B', 'C', 'D'].map((node) => ({ node, stiffness })) }],
      })!;
      for (let i = 0; i < 300; i++) solver.step(1 / 60);
      return bones[3]!.getWorldPosition(new THREE.Vector3());
    };

    const restTipY = makeChain(['A', 'B', 'C', 'D']).bones[3]!.getWorldPosition(new THREE.Vector3()).y;
    const stiffTip = buildAndSettle(0.8);
    const limpTip = buildAndSettle(0.02);

    const stiffDrop = restTipY - stiffTip.y;
    const limpDrop = restTipY - limpTip.y;

    expect(stiffDrop).toBeGreaterThan(0); // stiffness isn't 1 — it still deflects some
    expect(stiffDrop).toBeLessThan(limpDrop * 0.5); // ...but far less than the nearly-limp chain
  });

  it('stiffness=1 pins the chain to its animated rest pose regardless of gravity', () => {
    const { root, bones } = makeChain(['A', 'B', 'C']);
    const solver = createSpringBoneSolver(root, {
      chains: [{ joints: ['A', 'B', 'C'].map((node) => ({ node, stiffness: 1 })) }],
    })!;
    const restPositions = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    for (let i = 0; i < 60; i++) solver.step(1 / 60);
    const afterPositions = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    restPositions.forEach((p, i) => expect(p.distanceTo(afterPositions[i]!)).toBeCloseTo(0, 5));
  });

  it('higher damping settles to a lower residual per-step motion than lower damping, given the same forcing', () => {
    const build = (damping: number) => {
      const { root, bones } = makeChain(['A', 'B', 'C']);
      const solver = createSpringBoneSolver(root, {
        chains: [{ joints: ['A', 'B', 'C'].map((node) => ({ node, damping, stiffness: 0.05 })) }],
      })!;
      return { solver, tip: bones[2]! };
    };
    const low = build(0.02);
    const high = build(0.6);

    for (let i = 0; i < 20; i++) {
      low.solver.step(1 / 60);
      high.solver.step(1 / 60);
    }
    const beforeLow = low.tip.getWorldPosition(new THREE.Vector3());
    const beforeHigh = high.tip.getWorldPosition(new THREE.Vector3());
    low.solver.step(1 / 60);
    high.solver.step(1 / 60);
    const movedLow = beforeLow.distanceTo(low.tip.getWorldPosition(new THREE.Vector3()));
    const movedHigh = beforeHigh.distanceTo(high.tip.getWorldPosition(new THREE.Vector3()));
    expect(movedHigh).toBeLessThan(movedLow);
  });

  it('reset() causes the next step() to re-center on the current pose instead of continuing prior motion', () => {
    const { root, bones } = makeChain(['A', 'B', 'C']);
    const solver = createSpringBoneSolver(root, config(['A', 'B', 'C']))!;
    for (let i = 0; i < 60; i++) solver.step(1 / 60);
    const midY = bones[2]!.getWorldPosition(new THREE.Vector3()).y;
    solver.reset();
    solver.step(1 / 60);
    const afterResetY = bones[2]!.getWorldPosition(new THREE.Vector3()).y;
    // One step after reset should be much closer to the (still-deflected,
    // since we didn't touch node.quaternion) current pose than a
    // from-scratch chain would be after 60 steps — i.e. it didn't keep
    // accelerating downward the way an un-reset solver does.
    expect(Math.abs(afterResetY - midY)).toBeLessThan(0.01);
  });

  it('fixed-timestep determinism: two 1/60 steps match one 1/30 step', () => {
    const chainA = makeChain(['A', 'B', 'C']);
    const chainB = makeChain(['A', 'B', 'C']);
    const solverA = createSpringBoneSolver(chainA.root, config(['A', 'B', 'C']), { fixedStep: 1 / 60 })!;
    const solverB = createSpringBoneSolver(chainB.root, config(['A', 'B', 'C']), { fixedStep: 1 / 60 })!;

    for (let i = 0; i < 10; i++) {
      solverA.step(1 / 60);
      solverA.step(1 / 60);
      solverB.step(1 / 30);
    }
    const tipA = chainA.bones[2]!.getWorldPosition(new THREE.Vector3());
    const tipB = chainB.bones[2]!.getWorldPosition(new THREE.Vector3());
    expect(tipA.distanceTo(tipB)).toBeCloseTo(0, 6);
  });

  it('a long stall is clamped to maxSubSteps rather than simulating the whole gap', () => {
    const { root, bones } = makeChain(['A', 'B', 'C']);
    const solver = createSpringBoneSolver(root, config(['A', 'B', 'C']), { maxSubSteps: 4 })!;
    solver.step(0.25); // 15 sub-steps' worth at 1/60 — must clamp to 4
    const clampedY = bones[2]!.getWorldPosition(new THREE.Vector3()).y;

    const { root: root2, bones: bones2 } = makeChain(['A', 'B', 'C']);
    const solver2 = createSpringBoneSolver(root2, config(['A', 'B', 'C']), { maxSubSteps: 4 })!;
    for (let i = 0; i < 4; i++) solver2.step(1 / 60);
    const fourStepY = bones2[2]!.getWorldPosition(new THREE.Vector3()).y;

    expect(clampedY).toBeCloseTo(fourStepY, 6);
  });

  it('strength=0 leaves the rig at its animated rest pose', () => {
    const { root, bones } = makeChain(['A', 'B', 'C']);
    const solver = createSpringBoneSolver(root, config(['A', 'B', 'C']), { strength: 0 })!;
    const restY = bones[2]!.getWorldPosition(new THREE.Vector3()).y;
    for (let i = 0; i < 60; i++) solver.step(1 / 60);
    const afterY = bones[2]!.getWorldPosition(new THREE.Vector3()).y;
    expect(afterY).toBeCloseTo(restY, 5);
  });

  it('a tip joint with no declared child still simulates via a synthesized virtual tip', () => {
    const { root, bones } = makeChain(['A']);
    const solver = createSpringBoneSolver(root, config(['A']))!;
    expect(solver.jointCount).toBe(1);
    const restPos = bones[0]!.getWorldPosition(new THREE.Vector3());
    expect(restPos.x).toBeCloseTo(0.2, 5);
    for (let i = 0; i < 60; i++) solver.step(1 / 60);
    // `A` itself never moves (its position is fixed relative to `root`), but
    // its quaternion should have rotated away from identity under gravity —
    // that rotation is what visibly droops whatever mesh is skinned to it.
    expect(bones[0]!.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0);
  });

  describe('sphere collider', () => {
    it('keeps a chain outside a sphere it would otherwise swing through', () => {
      const { root, bones } = makeChain(['A', 'B', 'C', 'D']);
      const obstacle = new THREE.Object3D();
      obstacle.name = 'Obstacle';
      obstacle.position.set(0, -0.5, 0);
      root.add(obstacle);
      root.updateMatrixWorld(true);

      // Near-zero stiffness — this test is about the collider mechanic, not
      // about stiffness (which, correctly fixed elsewhere, now holds a
      // chain much closer to its rest pose under gravity by default and
      // wouldn't swing down far enough to reach this obstacle at all).
      const solver = createSpringBoneSolver(root, {
        chains: [
          {
            joints: ['A', 'B', 'C', 'D'].map((node) => ({ node, radius: 0.01, stiffness: 0 })),
            colliderGroups: ['body'],
          },
        ],
        colliderGroups: [
          { name: 'body', colliders: [{ type: 'sphere', node: 'Obstacle', offset: [0, 0, 0], radius: 0.3 }] },
        ],
      })!;

      for (let i = 0; i < 180; i++) solver.step(1 / 60);
      const tip = bones[3]!.getWorldPosition(new THREE.Vector3());
      const center = obstacle.getWorldPosition(new THREE.Vector3());
      // A settled chain resting against a collider under constant gravity
      // sits right at the surface (touching, not clear of it) — the pass
      // pushes out to exactly `minDist` each time it detects penetration,
      // but gravity pulls back in before the next check, so the true
      // steady-state distance oscillates just under `minDist` by a small
      // per-substep amount rather than converging to it exactly. Assert
      // "at the surface, not through it", not "strictly outside with margin".
      expect(tip.distanceTo(center)).toBeGreaterThanOrEqual(0.3 + 0.01 - 0.01);

      // Prove the collider actually did something: the same chain with no
      // collider group attached swings well inside the sphere.
      const { root: rootNoCollide, bones: bonesNoCollide } = makeChain(['A', 'B', 'C', 'D']);
      const solverNoCollide = createSpringBoneSolver(rootNoCollide, {
        chains: [{ joints: ['A', 'B', 'C', 'D'].map((node) => ({ node, radius: 0.01, stiffness: 0 })) }],
      })!;
      for (let i = 0; i < 180; i++) solverNoCollide.step(1 / 60);
      const tipNoCollide = bonesNoCollide[3]!.getWorldPosition(new THREE.Vector3());
      expect(tipNoCollide.distanceTo(center)).toBeLessThan(0.3);
    });

    it('a chain that never reaches a collider is unaffected by its presence', () => {
      const { root: rootA, bones: bonesA } = makeChain(['A', 'B']);
      const solverA = createSpringBoneSolver(rootA, config(['A', 'B']))!;

      const { root: rootB, bones: bonesB } = makeChain(['A', 'B']);
      const farObstacle = new THREE.Object3D();
      farObstacle.name = 'Far';
      farObstacle.position.set(100, 100, 100);
      rootB.add(farObstacle);
      rootB.updateMatrixWorld(true);
      const solverB = createSpringBoneSolver(rootB, {
        chains: [{ joints: [{ node: 'A' }, { node: 'B' }], colliderGroups: ['far'] }],
        colliderGroups: [{ name: 'far', colliders: [{ type: 'sphere', node: 'Far', offset: [0, 0, 0], radius: 1 }] }],
      })!;

      for (let i = 0; i < 90; i++) {
        solverA.step(1 / 60);
        solverB.step(1 / 60);
      }
      const tipA = bonesA[1]!.getWorldPosition(new THREE.Vector3());
      const tipB = bonesB[1]!.getWorldPosition(new THREE.Vector3());
      expect(tipA.distanceTo(tipB)).toBeCloseTo(0, 6);
    });
  });
});

describe('readSpringBoneConfig', () => {
  it('reads a valid config from userData.SEER_spring_bones', () => {
    const object = new THREE.Object3D();
    const cfg: SpringBoneConfig = { chains: [{ joints: [{ node: 'A' }] }] };
    object.userData.SEER_spring_bones = cfg;
    expect(readSpringBoneConfig(object)).toEqual(cfg);
  });

  it('returns null when absent', () => {
    expect(readSpringBoneConfig(new THREE.Object3D())).toBeNull();
  });

  it('returns null (never throws) for a malformed blob', () => {
    const object = new THREE.Object3D();
    object.userData.SEER_spring_bones = { chains: 'not an array' };
    expect(readSpringBoneConfig(object)).toBeNull();

    const object2 = new THREE.Object3D();
    object2.userData.SEER_spring_bones = 'garbage';
    expect(readSpringBoneConfig(object2)).toBeNull();
  });

  it('degrades to null (never throws) for deeply-malformed chain entries', () => {
    const emptyChain = new THREE.Object3D();
    emptyChain.userData.SEER_spring_bones = { chains: [{}] };
    expect(() => readSpringBoneConfig(emptyChain)).not.toThrow();
    expect(readSpringBoneConfig(emptyChain)).toBeNull();

    const nullChain = new THREE.Object3D();
    nullChain.userData.SEER_spring_bones = { chains: [null] };
    expect(() => readSpringBoneConfig(nullChain)).not.toThrow();
    expect(readSpringBoneConfig(nullChain)).toBeNull();

    // A malformed chain dropped alongside a valid one degrades to just the
    // valid chain surviving, rather than the whole config being discarded.
    const mixed = new THREE.Object3D();
    mixed.userData.SEER_spring_bones = {
      chains: [{}, { joints: [{ node: 'A' }] }],
    };
    const result = readSpringBoneConfig(mixed);
    expect(result).not.toBeNull();
    expect(result!.chains).toHaveLength(1);
    expect(result!.chains[0]!.joints).toEqual([{ node: 'A' }]);
  });

  it('drops a colliderGroup with a non-numeric collider offset instead of poisoning the sim with NaN', () => {
    const object = new THREE.Object3D();
    object.userData.SEER_spring_bones = {
      chains: [{ joints: [{ node: 'A' }] }],
      colliderGroups: [
        {
          name: 'bad',
          colliders: [{ type: 'sphere', node: 'Obstacle', offset: ['a', 'b', 'c'], radius: 1 }],
        },
      ],
    };
    expect(() => readSpringBoneConfig(object)).not.toThrow();
    const result = readSpringBoneConfig(object)!;
    expect(result).not.toBeNull();
    // The chain itself is fine — only the malformed collider group is
    // dropped, so the config still describes usable (collision-less) physics
    // rather than being discarded wholesale.
    expect(result.chains).toHaveLength(1);
    expect(result.colliderGroups ?? []).toHaveLength(0);
  });

  it('createSpringBoneSolver never throws for a malformed chain/colliderGroups shape passed directly (bypassing readSpringBoneConfig)', () => {
    const { root } = makeChain(['A', 'B']);
    expect(() =>
      createSpringBoneSolver(root, {
        // @ts-expect-error deliberately malformed, simulating untyped/JSON-sourced input
        chains: [{}, null, { joints: [{ node: 'A' }, { node: 'B' }] }],
        // @ts-expect-error deliberately malformed
        colliderGroups: [null, { name: 'ok', colliders: [{ type: 'sphere', node: 'A', offset: [0, 0, 0], radius: 1 }] }],
      }),
    ).not.toThrow();
  });
});

describe('excludeAnimatedChains', () => {
  it('drops a chain with any animated joint, keeps the rest', () => {
    const cfg: SpringBoneConfig = {
      chains: [
        { name: 'animated', joints: [{ node: 'A' }, { node: 'B' }] },
        { name: 'free', joints: [{ node: 'C' }] },
      ],
    };
    const result = excludeAnimatedChains(cfg, new Set(['B']));
    expect(result.chains.map((c) => c.name)).toEqual(['free']);
  });

  it('is a no-op when nothing is animated', () => {
    const cfg: SpringBoneConfig = { chains: [{ joints: [{ node: 'A' }] }] };
    expect(excludeAnimatedChains(cfg, new Set())).toEqual(cfg);
  });
});

describe('deriveSpringBonesFromNames', () => {
  it('finds a real dangly chain by name and follows single-child descent', () => {
    const { root } = makeChain(['C_MANT1', 'C_MANT2', 'C_MANT3', 'C_MANT4']);
    const result = deriveSpringBonesFromNames(root);
    expect(result).not.toBeNull();
    expect(result!.chains).toHaveLength(1);
    expect(result!.chains[0]!.joints.map((j) => j.node)).toEqual(['C_MANT1', 'C_MANT2', 'C_MANT3', 'C_MANT4']);
  });

  it('splits at a fork into independent chains, not one branching chain', () => {
    const root = new THREE.Object3D();
    root.name = 'Head';
    const left = new THREE.Bone();
    left.name = 'L_HAIR1';
    left.position.set(-0.1, -0.1, 0);
    const right = new THREE.Bone();
    right.name = 'R_HAIR1';
    right.position.set(0.1, -0.1, 0);
    root.add(left, right);
    root.updateMatrixWorld(true);

    const result = deriveSpringBonesFromNames(root)!;
    expect(result.chains.map((c) => c.name).sort()).toEqual(['L_HAIR1', 'R_HAIR1']);
  });

  it('returns null for a rig with no semantic bone names (e.g. bone0..N)', () => {
    const { root } = makeChain(['bone0', 'bone1', 'bone2']);
    expect(deriveSpringBonesFromNames(root)).toBeNull();
  });

  it('does not walk past a non-bone child (e.g. an attached mesh)', () => {
    const { root, bones } = makeChain(['TAIL1', 'TAIL2']);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    bones[1]!.add(mesh);
    const result = deriveSpringBonesFromNames(root)!;
    expect(result.chains[0]!.joints.map((j) => j.node)).toEqual(['TAIL1', 'TAIL2']);
  });

  it('respects maxChainLength', () => {
    const { root } = makeChain(['HAIR1', 'HAIR2', 'HAIR3', 'HAIR4', 'HAIR5']);
    const result = deriveSpringBonesFromNames(root, { maxChainLength: 2 })!;
    expect(result.chains[0]!.joints).toHaveLength(2);
  });
});
