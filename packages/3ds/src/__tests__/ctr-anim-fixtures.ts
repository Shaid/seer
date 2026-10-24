/**
 * Synthetic animation fixtures for `ctr-anim.test.ts`'s before/after golden.
 *
 * Hand-built rather than extracted from a real BCH/CGFX, so the suite needs
 * no copyrighted game asset and can cover the cases a real clip rarely has
 * all at once: Euler and quaternion tracks, constant channels, missing
 * axes, an empty key list, a bone with no matching bind entry, coincident
 * key frames (the zero-width-span branch), and a clip long enough to hit the
 * `maxSamples` cap.
 */
type Vec3 = [number, number, number];

/** Satisfies `CtrBindBone`, `BchBone` and `CgfxBone` alike. */
export const BIND: { name: string; parentId: number; scale: Vec3; rotation: Vec3; translation: Vec3 }[] = [
  { name: 'root', parentId: -1, scale: [1, 1, 1], rotation: [0.1, 0.2, 0.3], translation: [1, 2, 3] },
  { name: 'arm', parentId: 0, scale: [1, 1, 1], rotation: [-0.5, 0, 0.25], translation: [0, 10, 0] },
];
const axis = (keys: [number, number][]) => ({ keys: keys.map(([frame, value]) => ({ frame, value })) });
export const CASES = [
  { name: 'empty', loopMode: 0, frameSize: 0, bones: [] },
  {
    name: 'euler', loopMode: 1, frameSize: 10,
    bones: [{
      boneName: 'root',
      rotation: [axis([[0, 0], [5, 1.5], [10, -0.25]]), undefined, { constant: 0.75 }],
      translation: [axis([[0, 0], [10, 4]]), { constant: -2 }, undefined],
    }],
  },
  {
    name: 'quat', loopMode: 2, frameSize: 7,
    bones: [{
      boneName: 'arm',
      rotationQuat: { keys: [{ frame: 0, value: [0, 0, 0, 1] }, { frame: 7, value: [0.5, 0.5, 0.5, 0.5] }] },
      translationQuat: { constant: [1, 2, 3, 0] },
    }],
  },
  {
    name: 'constant-quat', loopMode: 0, frameSize: 3,
    bones: [{ boneName: 'root', rotationQuat: { constant: [0, 0.7071, 0, 0.7071] } }],
  },
  {
    name: 'unknown-bone-and-empty-track', loopMode: 0, frameSize: 5,
    bones: [
      { boneName: 'nope', rotation: [axis([[0, 1], [5, 2]]), undefined, undefined] },
      { boneName: 'arm', rotation: [undefined, undefined, undefined], translation: [undefined, undefined, undefined] },
      { boneName: 'arm', translation: [{ keys: [] }, undefined, undefined] },
    ],
  },
  {
    name: 'degenerate-frames', loopMode: 0, frameSize: 1,
    bones: [{ boneName: 'root', rotation: [axis([[2, 1], [2, 9]]), undefined, undefined] }],
  },
  {
    name: 'long', loopMode: 0, frameSize: 500,
    bones: [{ boneName: 'arm', translation: [axis([[0, 0], [250, 5], [500, -5]]), axis([[0, 1]]), undefined] }],
  },
];
