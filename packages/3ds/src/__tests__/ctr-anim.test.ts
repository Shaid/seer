import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sampleCtrAxis, sampleCtrSkeletalAnimation, type CtrSkeletalAnimation, type CtrBindBone } from '../ctr-anim.js';
import { sampleBchSkeletalAnimation, type BchSkeletalAnimation } from '../bch.js';
import { sampleCgfxSkeletalAnimation, type CgfxSkeletalAnimation } from '../cgfx.js';
import { CASES, BIND } from './ctr-anim-fixtures.js';

describe('sampleCtrAxis', () => {
  const ramp = { keys: [{ frame: 0, value: 0 }, { frame: 10, value: 100 }] };

  it('returns the fallback for an absent channel', () => {
    expect(sampleCtrAxis(undefined, 5, 42)).toBe(42);
  });

  it('returns the fallback for a channel with no keys', () => {
    expect(sampleCtrAxis({ keys: [] }, 5, 42)).toBe(42);
    expect(sampleCtrAxis({}, 5, 42)).toBe(42);
  });

  it('prefers a constant over everything, including the fallback', () => {
    expect(sampleCtrAxis({ constant: 7, keys: [{ frame: 0, value: 1 }] }, 99, 42)).toBe(7);
    expect(sampleCtrAxis({ constant: 0 }, 0, 42)).toBe(0);
  });

  it('interpolates linearly between bracketing keys', () => {
    expect(sampleCtrAxis(ramp, 2.5, 0)).toBe(25);
    expect(sampleCtrAxis(ramp, 10, 0)).toBe(100);
  });

  it('clamps outside the key range instead of extrapolating', () => {
    expect(sampleCtrAxis(ramp, -100, 42)).toBe(0);
    expect(sampleCtrAxis(ramp, 1000, 42)).toBe(100);
  });

  it('does not divide by zero on coincident key frames', () => {
    const flat = { keys: [{ frame: 2, value: 1 }, { frame: 2, value: 9 }] };
    expect(sampleCtrAxis(flat, 2, 0)).toBe(1);
  });
});

describe('sampleCtrSkeletalAnimation', () => {
  it('drops a bone whose tracks produce no keys at all', () => {
    const anim: CtrSkeletalAnimation = {
      name: 'a', loopMode: 0, frameSize: 4,
      bones: [{ boneName: 'root', rotation: [undefined, undefined, undefined] }],
    };
    expect(sampleCtrSkeletalAnimation(anim, [])).toEqual({ name: 'a', loopMode: 0, duration: 4 / 30, joints: [] });
  });

  it('falls back to the bind pose for an axis this clip does not animate', () => {
    const bind: CtrBindBone[] = [{ name: 'b', rotation: [0, 0, 0], translation: [1, 2, 3] }];
    const anim: CtrSkeletalAnimation = {
      name: 'a', loopMode: 0, frameSize: 1,
      bones: [{ boneName: 'b', translation: [{ constant: 9 }, undefined, undefined] }],
    };
    const [joint] = sampleCtrSkeletalAnimation(anim, bind).joints;
    // X from the track, Y and Z from the bind pose — not 0.
    expect(joint!.translationKeys![0]!.value).toEqual([9, 2, 3]);
  });

  it('uses 0 for an un-animated axis when the bone has no bind entry', () => {
    const anim: CtrSkeletalAnimation = {
      name: 'a', loopMode: 0, frameSize: 1,
      bones: [{ boneName: 'ghost', translation: [{ constant: 9 }, undefined, undefined] }],
    };
    const [joint] = sampleCtrSkeletalAnimation(anim, []).joints;
    expect(joint!.translationKeys![0]!.value).toEqual([9, 0, 0]);
  });

  it('caps the sample count and still spans the whole clip', () => {
    const anim: CtrSkeletalAnimation = {
      name: 'a', loopMode: 0, frameSize: 500,
      bones: [{ boneName: 'b', translation: [{ keys: [{ frame: 0, value: 0 }, { frame: 500, value: 5 }] }, undefined, undefined] }],
    };
    const keys = sampleCtrSkeletalAnimation(anim, [], 30, 7).joints[0]!.translationKeys!;
    expect(keys).toHaveLength(7);
    expect(keys[0]!.time).toBe(0);
    expect(keys[6]!.time).toBeCloseTo(500 / 30, 10);
    expect(keys[6]!.value[0]).toBeCloseTo(5, 10);
  });

  it('emits at least two samples even for a zero-length clip', () => {
    const anim: CtrSkeletalAnimation = {
      name: 'a', loopMode: 0, frameSize: 0,
      bones: [{ boneName: 'b', translation: [{ constant: 1 }, undefined, undefined] }],
    };
    expect(sampleCtrSkeletalAnimation(anim, []).joints[0]!.translationKeys).toHaveLength(2);
  });

  it('passes a quaternion track through without resampling it', () => {
    const anim: CtrSkeletalAnimation = {
      name: 'a', loopMode: 0, frameSize: 7,
      bones: [{ boneName: 'b', rotationQuat: { keys: [{ frame: 0, value: [0, 0, 0, 1] }, { frame: 7, value: [0.5, 0.5, 0.5, 0.5] }] } }],
    };
    expect(sampleCtrSkeletalAnimation(anim, []).joints[0]!.rotationKeys).toEqual([
      { time: 0, quat: [0, 0, 0, 1] },
      { time: 7 / 30, quat: [0.5, 0.5, 0.5, 0.5] },
    ]);
  });
});

describe('the BCH and CGFX samplers are one implementation', () => {
  // `sampleBchSkeletalAnimation` and `sampleCgfxSkeletalAnimation` used to be
  // two copies of the same 67 lines, differing only in five type-name lines
  // (confirmed by diff). Both now delegate to `sampleCtrSkeletalAnimation`.
  // These two assertions are what proves that was a safe move:
  //
  //  1. the two entry points agree with each other and with the shared
  //     implementation, on every fixture, at three fps/maxSamples settings;
  //  2. the serialized result still hashes to the value captured by running
  //     the ORIGINAL, pre-extraction bch.ts and cgfx.ts over these same
  //     fixtures — so the shared body is not merely self-consistent, it
  //     produces the bytes the duplicated bodies produced.
  const SETTINGS: [number, number][] = [[30, 120], [60, 7], [24, 3]];

  it('bch, cgfx and the shared sampler agree on every fixture', () => {
    for (const c of CASES) {
      for (const [fps, maxSamples] of SETTINGS) {
        for (const bind of [BIND, [] as typeof BIND]) {
          const shared = sampleCtrSkeletalAnimation(c as CtrSkeletalAnimation, bind, fps, maxSamples);
          expect(sampleBchSkeletalAnimation(c as BchSkeletalAnimation, bind, fps, maxSamples), c.name).toEqual(shared);
          expect(sampleCgfxSkeletalAnimation(c as CgfxSkeletalAnimation, bind, fps, maxSamples), c.name).toEqual(shared);
        }
      }
    }
  });

  it('output matches the digest captured from the pre-extraction decoders', () => {
    const out: unknown[] = [];
    for (const c of CASES) {
      out.push(sampleBchSkeletalAnimation(c as BchSkeletalAnimation, BIND));
      out.push(sampleCgfxSkeletalAnimation(c as CgfxSkeletalAnimation, BIND));
      out.push(sampleBchSkeletalAnimation(c as BchSkeletalAnimation, BIND, 60, 7));
      out.push(sampleCgfxSkeletalAnimation(c as CgfxSkeletalAnimation, BIND, 60, 7));
      out.push(sampleBchSkeletalAnimation(c as BchSkeletalAnimation, [], 24, 3));
      out.push(sampleCgfxSkeletalAnimation(c as CgfxSkeletalAnimation, [], 24, 3));
    }
    const digest = createHash('sha256').update(JSON.stringify(out, null, 1)).digest('hex');
    expect(digest).toBe('cd58c8e6d7b15e950fd862f54aeb356d5d22179bbbd2aaa20e530ad74f713751');
  });
});
