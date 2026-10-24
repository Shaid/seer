/**
 * The CTR SDK skeletal-animation layer shared by BCH and CGFX.
 *
 * `bch.ts` and `cgfx.ts` decode two different *container* formats, but both
 * wrap the same CTR/PICA200 animation structures, and the code above the
 * byte level was duplicated function-for-function with only the type names
 * changed. `cgfx.ts` even said so at its own `sampleCgfxSkeletalAnimation`:
 * "Renamed from the original `sampleSkeletalAnimation` (both bch.ts and
 * cgfx.ts independently used that name) to avoid a barrel export collision"
 * — the rename worked around the duplication instead of removing it. This is
 * the removal, the same move `mat4-ctr.ts` already made for the matrix math.
 *
 * Scope is deliberately the part that is container-independent: the decoded
 * track shapes, axis sampling, and the resample-to-a-uniform-grid pass.
 * Everything that reads bytes stays in its own container's file, because the
 * two formats' headers, bit layouts and offset conventions genuinely differ
 * (see `readAxisKeyFrameGroup` vs `readCgfxAxisKeyFrameGroup`).
 *
 * `BchAnimAxis`/`CgfxAnimAxis` and friends remain exported from their own
 * modules as aliases of the types here, so the package's published surface
 * is unchanged.
 */

import { matMul, matRotX, matRotY, matRotZ, matToQuaternion } from './mat4-ctr.js';

/** A single float channel's keyframes, already scaled to (frame, value). */
export interface CtrAnimAxis {
  constant?: number;
  keys?: { frame: number; value: number }[];
}

/** A vec3/vec4 channel (transformQuaternion segment) — constant or a dense per-frame array. */
export interface CtrAnimVec4 {
  constant?: [number, number, number, number];
  keys?: { frame: number; value: [number, number, number, number] }[];
}

export interface CtrAnimBoneTrack {
  boneName: string;
  /** 'transform' segment: independent Euler-angle rotation, one track per axis (X,Y,Z). */
  rotation?: [CtrAnimAxis | undefined, CtrAnimAxis | undefined, CtrAnimAxis | undefined];
  /** 'transform' segment: independent translation, one track per axis (X,Y,Z). */
  translation?: [CtrAnimAxis | undefined, CtrAnimAxis | undefined, CtrAnimAxis | undefined];
  /** 'transformQuaternion' segment (rare in practice — most real bone tracks use 'transform' above). */
  scaleQuat?: CtrAnimVec4;
  rotationQuat?: CtrAnimVec4;
  translationQuat?: CtrAnimVec4;
}

export interface CtrSkeletalAnimation {
  name: string;
  loopMode: number;
  frameSize: number;
  bones: CtrAnimBoneTrack[];
}

/**
 * The part of a skeleton's bind pose resampling needs: a name to match a
 * track against, and the resting rotation/translation to fall back to for an
 * axis this clip doesn't animate. Both `BchBone` and `CgfxBone` satisfy it.
 */
export interface CtrBindBone {
  name: string;
  rotation: [number, number, number];
  translation: [number, number, number];
}

export interface CtrSampledJointAnimation {
  boneName: string;
  rotationKeys?: { time: number; quat: [number, number, number, number] }[];
  translationKeys?: { time: number; value: [number, number, number] }[];
}

export interface CtrSampledAnimation {
  name: string;
  loopMode: number;
  duration: number;
  joints: CtrSampledJointAnimation[];
}

/**
 * One axis channel's value at `frame`: its constant if it has one, otherwise
 * a linear interpolation between the bracketing keys, clamped at both ends,
 * and `fallback` when the channel is absent or empty.
 */
export function sampleCtrAxis(axis: CtrAnimAxis | undefined, frame: number, fallback: number): number {
  if (!axis) return fallback;
  if (axis.constant !== undefined) return axis.constant;
  const keys = axis.keys;
  if (!keys || keys.length === 0) return fallback;
  if (frame <= keys[0]!.frame) return keys[0]!.value;
  const last = keys[keys.length - 1]!;
  if (frame >= last.frame) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!,
      b = keys[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const t = b.frame === a.frame ? 0 : (frame - a.frame) / (b.frame - a.frame);
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

/**
 * Resample one skeletal animation onto a uniform time grid (assumed 30fps —
 * the format doesn't carry an explicit frame rate, but the 3DS's fixed
 * 60Hz/2 vsync-locked engines conventionally animate at 30; this matches the
 * plausible-duration check used to verify the decode, not an
 * independently-sourced constant) so every bone's samples share the same
 * timestamps, which LINEAR-interpolation glTF samplers need.
 *
 * `bindBones` supplies each animated bone's bind-pose rotation/translation so
 * an axis with no track for this particular clip (e.g. a bone whose Y
 * rotation never changes) still contributes its resting value instead of 0.
 */
export function sampleCtrSkeletalAnimation(
  animation: CtrSkeletalAnimation,
  bindBones: CtrBindBone[],
  fps = 30,
  maxSamples = 120,
): CtrSampledAnimation {
  const totalFrames = Math.max(animation.frameSize, 1);
  const sampleCount = Math.max(2, Math.min(Math.ceil(totalFrames) + 1, maxSamples));
  const bindByName = new Map(bindBones.map((b) => [b.name, b]));

  const joints: CtrSampledJointAnimation[] = [];
  for (const bone of animation.bones) {
    const bind = bindByName.get(bone.boneName);
    const rotationKeys: { time: number; quat: [number, number, number, number] }[] = [];
    const translationKeys: { time: number; value: [number, number, number] }[] = [];

    if (bone.rotation && bone.rotation.some((a) => a)) {
      for (let i = 0; i < sampleCount; i++) {
        const frame = (i / (sampleCount - 1)) * totalFrames;
        const rx = sampleCtrAxis(bone.rotation[0], frame, bind?.rotation[0] ?? 0);
        const ry = sampleCtrAxis(bone.rotation[1], frame, bind?.rotation[1] ?? 0);
        const rz = sampleCtrAxis(bone.rotation[2], frame, bind?.rotation[2] ?? 0);
        const m = matMul(matMul(matRotX(rx), matRotY(ry)), matRotZ(rz));
        rotationKeys.push({ time: frame / fps, quat: matToQuaternion(m) });
      }
    } else if (bone.rotationQuat) {
      if (bone.rotationQuat.constant) {
        rotationKeys.push({ time: 0, quat: bone.rotationQuat.constant });
      } else if (bone.rotationQuat.keys) {
        for (const k of bone.rotationQuat.keys) rotationKeys.push({ time: k.frame / fps, quat: k.value });
      }
    }

    if (bone.translation && bone.translation.some((a) => a)) {
      for (let i = 0; i < sampleCount; i++) {
        const frame = (i / (sampleCount - 1)) * totalFrames;
        translationKeys.push({
          time: frame / fps,
          value: [
            sampleCtrAxis(bone.translation[0], frame, bind?.translation[0] ?? 0),
            sampleCtrAxis(bone.translation[1], frame, bind?.translation[1] ?? 0),
            sampleCtrAxis(bone.translation[2], frame, bind?.translation[2] ?? 0),
          ],
        });
      }
    } else if (bone.translationQuat) {
      if (bone.translationQuat.constant) {
        const c = bone.translationQuat.constant;
        translationKeys.push({ time: 0, value: [c[0], c[1], c[2]] });
      } else if (bone.translationQuat.keys) {
        for (const k of bone.translationQuat.keys) {
          translationKeys.push({ time: k.frame / fps, value: [k.value[0], k.value[1], k.value[2]] });
        }
      }
    }

    if (rotationKeys.length > 0 || translationKeys.length > 0) {
      joints.push({
        boneName: bone.boneName,
        ...(rotationKeys.length > 0 ? { rotationKeys } : {}),
        ...(translationKeys.length > 0 ? { translationKeys } : {}),
      });
    }
  }

  return { name: animation.name, loopMode: animation.loopMode, duration: totalFrames / fps, joints };
}
