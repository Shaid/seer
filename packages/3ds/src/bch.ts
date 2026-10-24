/**
 * 3DS BCH model parser (Fire Emblem Fates / Echoes — the FE3DS engine's
 * character/battle models, `*.bch.lz`).
 *
 * BCH is the raw 3DS model format (as opposed to the CGFX container used by
 * Awakening/Bravely). Its geometry is stored as PICA200 GPU command buffers
 * that configure the vertex-shader attribute layout, plus interleaved vertex
 * buffers and index buffers. Parsing requires:
 *   1. applying the relocation table (rewrites relative pointers to absolute
 *      file offsets);
 *   2. the content header → model header → object (mesh) table;
 *   3. a PICA command reader for the attribute config + uniform scales;
 *   4. vertex decode via the index buffer.
 *
 * Ported from Ohana3DS-Rebirth's `Models/BCH.cs` (gdkchan), scoped to static
 * geometry. Skinning uses the reference's rigid/fallback transform (a
 * first-bone approximation for smooth skinning). Material *diffuse colors*
 * are not decoded — the material struct layout isn't verified against real
 * output the way the geometry path is, so every mesh gets a flat placeholder
 * gray (see `readModel` below) rather than a guessed-and-possibly-wrong
 * color. CGFX models (`cgfx.ts`) do have real diffuse colors.
 *
 * Embedded textures and UV coordinates *are* decoded (`readTextures`, the
 * `ATTRIBUTE_UV` case in `readMesh`) — confidence there is lower than CGFX's
 * (no independent cross-reference like CGFX's material→texture-name match
 * was available; the UV scale was derived and cross-checked batch-wise,
 * ~65% of decoded UVs landing in [-0.2, 1.2] with clean-looking extremes near
 * ±1/±2 rather than random noise — a real-but-imperfect result).
 */
import {
  sampleCtrSkeletalAnimation,
  type CtrAnimAxis,
  type CtrAnimVec4,
  type CtrAnimBoneTrack,
  type CtrSampledAnimation,
  type CtrSampledJointAnimation,
} from './ctr-anim.js';
import { u16At } from './le.js';
import { ctrTextureByteSize } from './ctr-texture.js';
import {
  matApply,
  matIdentity,
  matMul,
  matRotX,
  matRotY,
  matRotZ,
  matScale,
  matTranslate,
  type Mat4,
} from './mat4-ctr.js';

export interface BchTexture {
  name: string;
  format: number;
  width: number;
  height: number;
  dataOffset: number;
  dataLength: number;
}

export interface BchFace {
  verts: number[];
}

export interface BchMesh {
  name: string;
  vertices: [number, number, number][];
  faces: BchFace[];
  materialId: number;
  vertexColors?: [number, number, number, number][];
  uvs?: [number, number][];
  /** Rigid (single-influence) skinning bone per vertex, -1 if unskinned. Parallel to `vertices`. */
  boneIndices?: number[];
}

export interface BchBone {
  name: string;
  parentId: number;
  /** Bind-pose local TRS (radians for rotation), same convention as the skeletal-animation tracks. */
  scale: [number, number, number];
  rotation: [number, number, number];
  translation: [number, number, number];
}

export interface BchModel {
  name: string;
  materials: { name: string; diffuse: [number, number, number, number] }[];
  meshes: BchMesh[];
  bones: BchBone[];
  /** Accumulated (bone-to-model-space) bind matrices, one 16-element row-major Mat4 per bone, parallel to `bones`. */
  bindMatrices: number[][];
}

// BCH and CGFX wrap the *same* CTR SDK animation structures, so these are
// aliases of the shared shapes in `ctr-anim.ts` rather than a second
// declaration of them. Kept exported under their original names: they are
// part of this package's published surface.
/** A single float channel's keyframes, already scaled to (frame, value). */
export type BchAnimAxis = CtrAnimAxis;
/** A vec3/vec4 channel (transformQuaternion segment) — constant or a dense per-frame array. */
export type BchAnimVec4 = CtrAnimVec4;
export type BchAnimBoneTrack = CtrAnimBoneTrack;

export interface BchSkeletalAnimation {
  name: string;
  loopMode: number;
  frameSize: number;
  bones: BchAnimBoneTrack[];
}

export interface Bch {
  models: BchModel[];
  textures: BchTexture[];
  skeletalAnimations: BchSkeletalAnimation[];
}

// PICA200 register ids (see Ohana3DS PICACommand.cs)
const VSH_ATTRS_BUFFER_FORMAT_LOW = 0x201;
const VSH_ATTRS_BUFFER_FORMAT_HIGH = 0x202;
const VSH_ATTRS_BUFFER_ADDRESS = 0x200;
const VSH_BUFFER0_ADDRESS = 0x203;
const VSH_BUFFER0_PERMUTATION = 0x204;
const VSH_BUFFER0_STRIDE = 0x205;
const INDEX_BUFFER_CONFIG = 0x227;
const INDEX_BUFFER_TOTAL_VERTICES = 0x228;
const BLOCK_END = 0x23d;
const VSH_PERMUTATION_LOW = 0x2bb;
const VSH_PERMUTATION_HIGH = 0x2bc;
const VSH_FLOAT_UNIFORM_CONFIG = 0x2c0;
const VSH_FLOAT_UNIFORM_DATA = 0x2c1;
const TEX_UNIT0_SIZE = 0x82;
const TEX_UNIT0_ADDRESS = 0x85;
const TEX_UNIT0_TYPE = 0x8e;

const ATTRIBUTE_POSITION = 0;
const ATTRIBUTE_COLOR = 3;
const ATTRIBUTE_UV = 4;
const ATTRIBUTE_BONE_INDEX = 7;
const ATTRIBUTE_BONE_WEIGHT = 8;

// ---------------------------------------------------------------------------
// PICA command buffer reader
// ---------------------------------------------------------------------------

interface AttributeFormat {
  type: number; // 0 = i8, 1 = u8, 2 = i16, 3 = f32
  length: number;
}

function readFloat(view: DataView, off: number): number {
  return view.byteLength >= off + 4 ? view.getFloat32(off, true) : 0;
}

function u32(view: DataView, off: number): number {
  return view.byteLength >= off + 4 ? view.getUint32(off, true) : 0;
}

function u16(view: DataView, off: number): number {
  return view.byteLength >= off + 2 ? view.getUint16(off, true) : 0;
}

function u8(view: DataView, off: number): number {
  return view.byteLength >= off + 1 ? view.getUint8(off) : 0;
}

function i8(view: DataView, off: number): number {
  return view.byteLength >= off + 1 ? view.getInt8(off) : 0;
}

function i16(view: DataView, off: number): number {
  return view.byteLength >= off + 2 ? view.getInt16(off, true) : 0;
}

function sliceView(view: DataView, off: number, length: number): DataView {
  const start = Math.min(Math.max(off, 0), view.byteLength);
  const end = Math.min(start + length, view.byteLength);
  return new DataView(view.buffer, view.byteOffset + start, end - start);
}

class PicaCommandReader {
  private readonly commands = new Uint32Array(0x10000);
  private readonly floatUniform: number[][] = [];
  private readonly currentUniforms: number[] = [];

  constructor(view: DataView, wordCount: number) {
    let read = 0;
    let pos = 0;
    let currentUniform = 0;
    while (read < wordCount) {
      if (pos + 8 > view.byteLength) break;
      const parameter = u32(view, pos);
      const header = u32(view, pos + 4);
      pos += 8;
      read += 2;

      const id = header & 0xffff;
      const mask = (header >> 16) & 0xf;
      const extraParameters = (header >> 20) & 0x7ff;
      const consecutive = (header & 0x80000000) !== 0;

      this.writeCommand(id, mask, parameter);
      if (id === BLOCK_END) break;
      if (id === VSH_FLOAT_UNIFORM_CONFIG) currentUniform = parameter & 0x7fffffff;
      else if (id === VSH_FLOAT_UNIFORM_DATA) this.currentUniforms.push(f32(parameter));

      for (let i = 0; i < extraParameters; i++) {
        if (pos + 4 > view.byteLength) break;
        const nextId = consecutive ? id + 1 + i : id;
        const next = view.getUint32(pos, true);
        pos += 4;
        read++;
        this.writeCommand(nextId, mask, next);
        if (nextId > VSH_FLOAT_UNIFORM_CONFIG && nextId < VSH_FLOAT_UNIFORM_DATA + 8) {
          this.currentUniforms.push(f32(this.commands[nextId]!));
        }
      }

      if (this.currentUniforms.length > 0) {
        const list = this.floatUniform[currentUniform] ?? (this.floatUniform[currentUniform] = []);
        list.push(...this.currentUniforms);
        this.currentUniforms.length = 0;
      }
      if (pos % 8 !== 0) pos += 8 - (pos % 8);
      if (read === 0) break;
    }
  }

  private writeCommand(id: number, mask: number, parameter: number): void {
    const prev = this.commands[id]!;
    this.commands[id] = (prev & ~mask) | (parameter & (0xfffffff0 | mask));
  }

  parameter(id: number): number {
    return this.commands[id]!;
  }

  getFloatUniform(register: number): number[] {
    return this.floatUniform[register] ?? [];
  }

  indexBufferAddress(): number {
    return this.parameter(INDEX_BUFFER_CONFIG) & 0x7fffffff;
  }

  indexBufferFormat(): number {
    return (this.parameter(INDEX_BUFFER_CONFIG) >> 31) & 1;
  }

  indexBufferTotalVertices(): number {
    return this.parameter(INDEX_BUFFER_TOTAL_VERTICES);
  }

  attributesBufferAddress(buffer: number): number {
    return this.parameter(VSH_BUFFER0_ADDRESS + buffer * 3);
  }

  attributesBufferStride(buffer: number): number {
    return (this.parameter(VSH_BUFFER0_STRIDE + buffer * 3) >> 16) & 0xff;
  }

  attributesBufferTotalAttributes(buffer: number): number {
    return this.parameter(VSH_BUFFER0_STRIDE + buffer * 3) >> 28;
  }

  attributesBufferPermutation(buffer: number): number[] {
    let perm = this.parameter(VSH_BUFFER0_PERMUTATION + buffer * 3);
    perm |= (this.parameter(VSH_BUFFER0_STRIDE + buffer * 3) & 0xffff) << 32;
    const out: number[] = [];
    for (let a = 0; a < 23; a++) out.push(Number((BigInt(perm) >> BigInt(a * 4)) & 0xfn));
    return out;
  }

  mainPermutation(): number[] {
    let perm = this.parameter(VSH_PERMUTATION_LOW);
    perm |= this.parameter(VSH_PERMUTATION_HIGH) * 0x1_0000_0000;
    const out: number[] = [];
    for (let a = 0; a < 23; a++) out.push(Number((BigInt(perm) >> BigInt(a * 4)) & 0xfn));
    return out;
  }

  formats(): AttributeFormat[] {
    let fmt = this.parameter(VSH_ATTRS_BUFFER_FORMAT_LOW);
    fmt |= this.parameter(VSH_ATTRS_BUFFER_FORMAT_HIGH) * 0x1_0000_0000;
    const out: AttributeFormat[] = [];
    for (let a = 0; a < 23; a++) {
      const value = Number((BigInt(fmt) >> BigInt(a * 4)) & 0xfn);
      out.push({ type: value & 3, length: value >> 2 });
    }
    return out;
  }
}

function f32(value: number): number {
  const buf = new Uint8Array(4);
  buf[0] = value & 0xff;
  buf[1] = (value >> 8) & 0xff;
  buf[2] = (value >> 16) & 0xff;
  buf[3] = (value >> 24) & 0xff;
  return new DataView(buf.buffer).getFloat32(0, true);
}

// ---------------------------------------------------------------------------
// Matrices (rigid-skinning transforms) — see mat4-ctr.ts for the shared
// matrix math; `accumulateBone` stays local (see mat4-ctr.ts's doc comment
// for why: it takes this file's own `Bone` shape and, as of this package's
// extraction, has diverged from cgfx.ts's version by two safety guards).
// ---------------------------------------------------------------------------

interface Bone {
  name: string;
  parentId: number;
  scale: [number, number, number];
  rotation: [number, number, number];
  translation: [number, number, number];
}

function accumulateBone(bones: Bone[], index: number): Mat4 {
  const b = bones[index];
  if (!b) return matIdentity();
  const local = matMul(
    matMul(
      matMul(matMul(matScale(b.scale), matRotX(b.rotation[0])), matRotY(b.rotation[1])),
      matRotZ(b.rotation[2]),
    ),
    matTranslate(b.translation),
  );
  const parent = b.parentId;
  if (parent >= 0 && parent < bones.length && parent !== index)
    return matMul(local, accumulateBone(bones, parent));
  return local;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function readCString(view: DataView, off: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let end = off;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder('utf8').decode(bytes.subarray(off, end));
}

/** Parse a BCH buffer (relocation applied on a copy). Throws on a bad magic. */
export function parseBch(data: Uint8Array): Bch {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 4 || data[0] !== 0x42 || data[1] !== 0x43 || data[2] !== 0x48) {
    throw new Error('Not a BCH file');
  }
  const bc = data[4]!;
  const mainHeaderOffset = u32(view, 8);
  const stringTableOffset = u32(view, 12);
  const gpuCommandsOffset = u32(view, 16);
  const dataOffset = u32(view, 20);
  const dataExtendedOffset = bc > 0x20 ? u32(view, 24) : 0;
  const relocationTableOffset = u32(view, bc > 0x20 ? 28 : 24);
  const relocationTableLength = u32(view, bc > 0x20 ? 52 : 44);

  // Relocation: rewrite relative pointers to absolute file offsets.
  const relocated = new Uint8Array(data);
  const rv = new DataView(relocated.buffer, relocated.byteOffset, relocated.byteLength);
  const peek = (off: number): number => rv.getUint32(off, true);
  const write = (off: number, value: number): void => {
    if (off >= 0 && off + 4 <= rv.byteLength) rv.setUint32(off, value >>> 0, true);
  };

  for (
    let o = relocationTableOffset;
    o + 4 <= relocationTableOffset + Math.min(relocationTableLength, 0x4000) &&
    o + 4 <= rv.byteLength;
    o += 4
  ) {
    const value = rv.getUint32(o, true);
    const offset = value & 0x1ffffff;
    const flags = value >>> 25;
    if (flags === 0)
      write(offset * 4 + mainHeaderOffset, peek(offset * 4 + mainHeaderOffset) + mainHeaderOffset);
    else if (flags === 1)
      write(offset + mainHeaderOffset, peek(offset + mainHeaderOffset) + stringTableOffset);
    else if (flags === 2)
      write(offset * 4 + mainHeaderOffset, peek(offset * 4 + mainHeaderOffset) + gpuCommandsOffset);
    else if (flags === 7 || flags === 0xc)
      write(offset * 4 + mainHeaderOffset, peek(offset * 4 + mainHeaderOffset) + dataOffset);

    const gc = offset * 4 + gpuCommandsOffset;
    if (bc < 0x21) continue; // older revisions use different pointer flags — skip
    if (flags === 0x25 || flags === 0x26 || flags === 0x2e) write(gc, peek(gc) + dataOffset);
    else if (flags === 0x27) write(gc, ((peek(gc) + dataOffset) & 0x7fffffff) | 0x80000000);
    else if (flags === 0x28) write(gc, (peek(gc) + dataOffset) & 0x7fffffff);
    else if (flags === 0x2b) write(gc, peek(gc) + dataExtendedOffset);
    else if (flags === 0x2c) write(gc, ((peek(gc) + dataExtendedOffset) & 0x7fffffff) | 0x80000000);
    else if (flags === 0x2d) write(gc, (peek(gc) + dataExtendedOffset) & 0x7fffffff);
  }

  const textures = readTextures(rv, mainHeaderOffset);
  const models = readModels(rv, mainHeaderOffset);
  const skeletalAnimations = readSkeletalAnimations(rv, mainHeaderOffset);
  return { models, textures, skeletalAnimations };
}

/**
 * Content-header layout (Ohana3DS-Rebirth `Models/BCH.cs`'s `bchContentHeader`):
 * models(0/4/8), materials(12/16/20), shaders(24/28/32), textures(36/40/44), ...
 * — each a (pointerTableOffset, pointerTableEntries, nameOffset) triple.
 */
function readTextures(view: DataView, mainHeaderOffset: number): BchTexture[] {
  const texturesPointerTableOffset = u32(view, mainHeaderOffset + 36);
  const texturesPointerTableEntries = Math.min(u32(view, mainHeaderOffset + 40), 0x400);

  const textures: BchTexture[] = [];
  for (let i = 0; i < texturesPointerTableEntries; i++) {
    const entryOffset = u32(view, texturesPointerTableOffset + i * 4);
    if (entryOffset >= view.byteLength) continue;
    // Per entry: texUnit0/1/2 commands (offset, wordCount) pairs, an unused
    // u32, then a name-string offset (see BCH.cs's texture-table reader).
    const texUnit0CommandsOffset = u32(view, entryOffset);
    const texUnit0CommandsWordCount = Math.min(u32(view, entryOffset + 4), 0x1000);
    const nameOffset = u32(view, entryOffset + 28);
    const name = nameOffset && nameOffset < view.byteLength ? readCString(view, nameOffset) : `texture${i}`;
    if (texUnit0CommandsOffset >= view.byteLength) continue;

    const commands = new PicaCommandReader(
      sliceView(view, texUnit0CommandsOffset, texUnit0CommandsWordCount * 4),
      texUnit0CommandsWordCount,
    );
    const dataOffset = commands.parameter(TEX_UNIT0_ADDRESS);
    const sizeReg = commands.parameter(TEX_UNIT0_SIZE);
    const width = (sizeReg >>> 16) & 0xffff;
    const height = sizeReg & 0xffff;
    const format = commands.parameter(TEX_UNIT0_TYPE);
    if (width === 0 || height === 0 || width > 4096 || height > 4096) continue;
    if (dataOffset >= view.byteLength) continue;
    let dataLength: number;
    try {
      dataLength = ctrTextureByteSize(format, width, height);
    } catch {
      continue; // unsupported/garbage format id
    }
    textures.push({ name, format, width, height, dataOffset, dataLength });
  }
  return textures;
}

// ---------------------------------------------------------------------------
// Skeletal animations (`ba/*.bch.lz` per-animation files in FE Fates/Echoes)
// ---------------------------------------------------------------------------

const SEGMENT_TRANSFORM = 4;
const SEGMENT_TRANSFORM_QUATERNION = 7;

/**
 * Decode one `getAnimationKeyFrame` group (Ohana3DS-Rebirth `Models/BCH.cs`).
 * `groupOffset` is the already-relocated absolute offset of the group header
 * (startFrame/endFrame/frameFlags/segmentFlags/scale+offset floats/dataOffset).
 * Only `frame`/`value` are decoded — the Hermite in/out slopes are parsed
 * (to keep the byte cursor aligned) but discarded, since playback here
 * resamples with linear interpolation rather than reproducing the original
 * curve exactly (undocumented in any reference; a pragmatic simplification
 * in the same spirit as this file's UV-scale derivation, see module doc).
 */
function readAxisKeyFrameGroup(view: DataView, groupOffset: number): BchAnimAxis {
  const segmentFlags = u32(view, groupOffset + 12);
  const quantization = (segmentFlags >> 8) & 0xff;
  const entries = Math.min(segmentFlags >>> 16, 0x4000);
  const valueScale = readFloat(view, groupOffset + 16);
  const valueOffset = readFloat(view, groupOffset + 20);
  const frameScale = readFloat(view, groupOffset + 24);
  const frameOffset = readFloat(view, groupOffset + 28);
  const dataOffset = u32(view, groupOffset + 32);

  const keys: { frame: number; value: number }[] = [];
  let p = dataOffset;
  for (let k = 0; k < entries; k++) {
    if (p >= view.byteLength) break;
    let frame = 0;
    let value = 0;
    switch (quantization) {
      case 0: // hermite128: f32 frame, f32 value, f32 inSlope, f32 outSlope
        frame = readFloat(view, p);
        value = readFloat(view, p + 4);
        p += 16;
        break;
      case 1: { // hermite64: u32(frame:12 | value:20), i16 inSlope, i16 outSlope
        const packed = u32(view, p);
        frame = packed & 0xfff;
        value = packed >>> 12;
        p += 8;
        break;
      }
      case 2: // hermite48: u8 frame, u16 value, 3 packed slope bytes
        frame = u8(view, p);
        value = u16(view, p + 1);
        p += 6;
        break;
      case 3: // unifiedHermite96: f32 frame, f32 value, f32 slope (shared in/out)
        frame = readFloat(view, p);
        value = readFloat(view, p + 4);
        p += 12;
        break;
      case 4: // unifiedHermite48: u16 frame/32, u16 value, i16 slope
        frame = u16(view, p) / 32;
        value = u16(view, p + 2);
        p += 6;
        break;
      case 5: // unifiedHermite32: u8 frame, u16+u8 packed value/slope
        frame = u8(view, p);
        value = u16(view, p + 1) & 0xfff;
        p += 4;
        break;
      case 6: // stepLinear64: f32 frame, f32 value
        frame = readFloat(view, p);
        value = readFloat(view, p + 4);
        p += 8;
        break;
      case 7: { // stepLinear32: u32(frame:12 | value:20)
        const packed = u32(view, p);
        frame = packed & 0xfff;
        value = packed >>> 12;
        p += 4;
        break;
      }
      default:
        return { keys };
    }
    keys.push({ frame: frame * frameScale + frameOffset, value: value * valueScale + valueOffset });
  }
  return { keys };
}

/**
 * 'transform' segment: 6 independent axis tracks (rotationX/Y/Z then
 * translationX/Y/Z), each either absent, a single constant value, or a
 * `readAxisKeyFrameGroup`-decoded curve. Bit layout ported directly from
 * Ohana3DS-Rebirth's nested loop (mask starts at bit 19/9 and both shift left
 * once per axis, with an extra shift of `constantMask` between the rotation
 * and translation halves) rather than re-derived, to avoid transcription
 * errors in the bit positions.
 */
function readTransformSegment(
  view: DataView,
  boneOffset: number,
  flags: number,
): { rotation: [BchAnimAxis | undefined, BchAnimAxis | undefined, BchAnimAxis | undefined]; translation: [BchAnimAxis | undefined, BchAnimAxis | undefined, BchAnimAxis | undefined] } {
  let p = boneOffset + 0x18;
  let notExistMask = 0x80000;
  let constantMask = 0x200;
  const rotation: (BchAnimAxis | undefined)[] = [];
  const translation: (BchAnimAxis | undefined)[] = [];
  for (let j = 0; j < 2; j++) {
    for (let axis = 0; axis < 3; axis++) {
      const notExist = (flags & notExistMask) !== 0;
      const constant = (flags & constantMask) !== 0;
      let track: BchAnimAxis | undefined;
      if (!notExist) {
        track = constant
          ? { constant: readFloat(view, p) }
          : readAxisKeyFrameGroup(view, u32(view, p));
      }
      p += 4;
      (j === 0 ? rotation : translation).push(track);
      notExistMask <<= 1;
      constantMask <<= 1;
    }
    constantMask <<= 1;
  }
  return {
    rotation: [rotation[0], rotation[1], rotation[2]],
    translation: [translation[0], translation[1], translation[2]],
  };
}

/** One transformQuaternion channel: constant vector, or a dense per-frame array (no explicit per-key frame numbers — frame = startFrame + index). */
function readQuatChannel(view: DataView, channelOffset: number, componentCount: 3 | 4, isConstant: boolean): BchAnimVec4 {
  const read4 = (o: number): [number, number, number, number] => [
    readFloat(view, o),
    readFloat(view, o + 4),
    componentCount >= 3 ? readFloat(view, o + 8) : 0,
    componentCount >= 4 ? readFloat(view, o + 12) : 0,
  ];
  if (isConstant) return { constant: read4(channelOffset) };

  const startFrame = readFloat(view, channelOffset);
  const dataOffset = u32(view, channelOffset + 12);
  const entries = Math.min(u32(view, channelOffset + 16), 0x4000);
  const stride = componentCount >= 4 ? 16 : 12;
  const keys: { frame: number; value: [number, number, number, number] }[] = [];
  for (let j = 0; j < entries; j++) {
    const vo = dataOffset + j * stride;
    if (vo >= view.byteLength) break;
    keys.push({ frame: startFrame + j, value: read4(vo) });
  }
  return { keys };
}

function readTransformQuaternionSegment(
  view: DataView,
  boneOffset: number,
  flags: number,
): { scaleQuat?: BchAnimVec4; rotationQuat?: BchAnimVec4; translationQuat?: BchAnimVec4 } {
  const scaleOffset = u32(view, boneOffset + 12);
  const rotationOffset = u32(view, boneOffset + 16);
  const translationOffset = u32(view, boneOffset + 20);
  const scaleQuat = (flags & 0x20) === 0 ? readQuatChannel(view, scaleOffset, 3, (flags & 4) !== 0) : undefined;
  const rotationQuat = (flags & 0x10) === 0 ? readQuatChannel(view, rotationOffset, 4, (flags & 2) !== 0) : undefined;
  const translationQuat = (flags & 8) === 0 ? readQuatChannel(view, translationOffset, 3, (flags & 1) !== 0) : undefined;
  return { scaleQuat, rotationQuat, translationQuat };
}

function readSkeletalAnimations(view: DataView, mainHeaderOffset: number): BchSkeletalAnimation[] {
  const pointerTableOffset = u32(view, mainHeaderOffset + 96);
  const pointerTableEntries = Math.min(u32(view, mainHeaderOffset + 100), 0x400);

  const animations: BchSkeletalAnimation[] = [];
  for (let a = 0; a < pointerTableEntries; a++) {
    const animOffset = u32(view, pointerTableOffset + a * 4);
    if (animOffset >= view.byteLength) continue;
    try {
      const nameOffset = u32(view, animOffset);
      const name = nameOffset && nameOffset < view.byteLength ? readCString(view, nameOffset) : `anim${a}`;
      const animationFlags = u32(view, animOffset + 4);
      const loopMode = animationFlags & 1;
      const frameSize = readFloat(view, animOffset + 8);
      const boneTableOffset = u32(view, animOffset + 12);
      const boneTableEntries = Math.min(u32(view, animOffset + 16), 0x400);

      const bones: BchAnimBoneTrack[] = [];
      for (let i = 0; i < boneTableEntries; i++) {
        const boneOffset = u32(view, boneTableOffset + i * 4);
        if (boneOffset >= view.byteLength) continue;
        const boneNameOffset = u32(view, boneOffset);
        const boneName =
          boneNameOffset && boneNameOffset < view.byteLength ? readCString(view, boneNameOffset) : `bone${i}`;
        const animationTypeFlags = u32(view, boneOffset + 4);
        const flags = u32(view, boneOffset + 8);
        const segmentType = (animationTypeFlags >>> 16) & 0xf;
        if (segmentType === SEGMENT_TRANSFORM) {
          const { rotation, translation } = readTransformSegment(view, boneOffset, flags);
          bones.push({ boneName, rotation, translation });
        } else if (segmentType === SEGMENT_TRANSFORM_QUATERNION) {
          const seg = readTransformQuaternionSegment(view, boneOffset, flags);
          bones.push({ boneName, ...seg });
        }
        // transformMatrix (fully-baked per-frame matrices) and other segment
        // types aren't seen in practice for FE3DS bone tracks — skipped.
      }
      animations.push({ name, loopMode, frameSize, bones });
    } catch (e) {
      console.warn(`  ✗ BCH skeletal animation ${a}: ${(e as Error).message}`);
    }
  }
  return animations;
}

function readModels(view: DataView, mainHeaderOffset: number): BchModel[] {
  const modelsPointerTableOffset = u32(view, mainHeaderOffset);
  const modelsPointerTableEntries = u32(view, mainHeaderOffset + 4);
  const modelsNameOffset = u32(view, mainHeaderOffset + 8);
  void modelsNameOffset;

  const models: BchModel[] = [];
  for (let m = 0; m < Math.min(modelsPointerTableEntries, 0x100); m++) {
    const modelOffset = u32(view, modelsPointerTableOffset + m * 4);
    if (modelOffset >= view.byteLength) continue;
    try {
      const model = readModel(view, modelOffset);
      if (model.meshes.length > 0) models.push(model);
    } catch (e) {
      console.warn(`  ✗ BCH model ${m}: ${(e as Error).message}`);
    }
  }
  return models;
}

function readModel(view: DataView, base: number): BchModel {
  const bc = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)[4]!;
  let p = base;
  p += 4; // flags, skeletonScalingType, silhouetteMaterialEntries
  p += 48; // world transform matrix (4x3)
  const materialsTableOffset = u32(view, p);
  const materialsTableEntries = u32(view, p + 4);
  p += 12; // materials name offset
  const verticesTableOffset = u32(view, p);
  // These four entry counts are raw u32s read from file data, same as
  // modelsPointerTableEntries/materialsTableEntries above; a misparsed offset
  // (wrong `bc` revision, a fragment file that isn't really a model) can leave
  // one holding garbage in the billions. Capped like the others so a bad
  // header degrades to a truncated/skipped model instead of a pipeline hang —
  // every real BCH model here has at most a few hundred objects or bones.
  const verticesTableEntries = Math.min(u32(view, p + 4), 0x1000);
  p += 8;
  p += bc > 6 ? 0x28 : 0x20;
  const skeletonOffset = u32(view, p);
  const skeletonEntries = Math.min(u32(view, p + 4), 0x1000);
  p += 12; // skeleton name offset
  p += 8; // objects node visibility offset/count
  const modelName = readCString(view, u32(view, p));
  void modelName;
  p += 4;
  const objectsNodeNameEntries = Math.min(u32(view, p), 0x1000);
  p += 4;
  const objectsNodeNameOffset = u32(view, p);

  // Object names (radix tree)
  const objectName: string[] = [];
  let op = objectsNodeNameOffset + 12;
  for (let i = 0; i < objectsNodeNameEntries; i++) {
    objectName.push(readCString(view, u32(view, op)));
    op += 8;
  }

  // Skeleton. Each entry is 0x64 bytes: flags(4) + parentId:i16(2) +
  // spacer:u16(2) + scale/rotation/translation (3x vec3, 36) + a 4x3
  // inverse-transform matrix (48, unused here) + a name-string offset (4) +
  // a metadata-pointer offset (4, unused) = 100 bytes. (Verified empirically
  // against a real Fates body model: a 0x44 stride — the prior, wrong value
  // here — reads a plausible bone 0 but garbage/degenerate scale for every
  // bone after it; 0x64 with the name field at +92 recovers a clean
  // ROOT→center→body1→body2→l_sl→l_arm1-shaped hierarchy with real names.)
  const BONE_STRIDE = 0x64;
  const bones: Bone[] = [];
  for (let i = 0; i < skeletonEntries; i++) {
    const bo = skeletonOffset + i * BONE_STRIDE;
    const boneFlags = u32(view, bo);
    void boneFlags;
    const parentId = i16(view, bo + 4);
    const scale: [number, number, number] = [
      readFloat(view, bo + 8),
      readFloat(view, bo + 12),
      readFloat(view, bo + 16),
    ];
    const rotation: [number, number, number] = [
      readFloat(view, bo + 20),
      readFloat(view, bo + 24),
      readFloat(view, bo + 28),
    ];
    const translation: [number, number, number] = [
      readFloat(view, bo + 32),
      readFloat(view, bo + 36),
      readFloat(view, bo + 40),
    ];
    const nameOffset = u32(view, bo + 92);
    const name = nameOffset && nameOffset < view.byteLength ? readCString(view, nameOffset) : `bone${i}`;
    bones.push({ name, parentId, scale, rotation, translation });
  }
  const skeletonTransforms = bones.map((_, i) => accumulateBone(bones, i));

  // Materials (bc >= 0x21: 0x2c-byte entries)
  const materials: BchModel['materials'] = [];
  for (let i = 0; i < Math.min(materialsTableEntries, 0x1000); i++) {
    const mo = materialsTableOffset + i * 0x2c;
    materials.push({ name: `material${i}`, diffuse: [0.8, 0.8, 0.8, 1] });
    void mo;
  }

  // Objects (meshes)
  const meshes: BchMesh[] = [];
  for (let oi = 0; oi < verticesTableEntries; oi++) {
    const vo = verticesTableOffset + oi * 0x40;
    const materialId = u16(view, vo);
    const flags = u16(view, vo + 2);
    const isSilhouette = (flags & 1) !== 0;
    const nodeId = u16(view, vo + 4);
    const vshCommandsOffset = u32(view, vo + 8);
    const vshCommandsWordCount = u32(view, vo + 12);
    const facesHeaderOffset = u32(view, vo + 16);
    const facesHeaderEntries = u32(view, vo + 20);
    if (isSilhouette) continue;
    if (vshCommandsOffset >= view.byteLength) continue;

    const mesh = readMesh(
      view,
      vshCommandsOffset,
      Math.min(vshCommandsWordCount, 0x20000),
      facesHeaderOffset,
      Math.min(facesHeaderEntries, 0x200),
      skeletonTransforms,
    );
    if (!mesh || mesh.vertices.length === 0) continue;
    mesh.materialId = Math.min(materialId, Math.max(materials.length - 1, 0));
    mesh.name = objectName[nodeId] ?? `mesh${oi}`;
    meshes.push(mesh);
  }

  const boneList: BchBone[] = bones.map((b) => ({
    name: b.name,
    parentId: b.parentId,
    scale: b.scale,
    rotation: b.rotation,
    translation: b.translation,
  }));
  const bindMatrices: number[][] = skeletonTransforms.map((m) => [...m]);

  return { name: modelName, materials, meshes, bones: boneList, bindMatrices };
}

function readMesh(
  view: DataView,
  vshCommandsOffset: number,
  vshCommandsWordCount: number,
  facesHeaderOffset: number,
  facesHeaderEntries: number,
  skeletonTransforms: Mat4[],
): BchMesh | null {
  const commands = new PicaCommandReader(
    sliceView(view, vshCommandsOffset, vshCommandsWordCount * 4),
    Math.min(vshCommandsWordCount, 0x20000),
  );

  // Position offset + attribute scales from vertex shader uniforms (regs 6/7).
  const uniform6 = commands.getFloatUniform(6);
  const uniform7 = commands.getFloatUniform(7);
  const positionOffset: [number, number, number] = [
    uniform6[0] ?? 0,
    uniform6[1] ?? 0,
    uniform6[2] ?? 0,
  ];
  const positionScale = uniform7[4] ?? 1;
  const colorScale = uniform7[7] ?? 1;
  // Derived from Ohana3DS-Rebirth's BCH reader: its 8 scales are POPPED off a
  // stack built by pushing `getFloatUniform(7)` in forward order, so the pop
  // sequence (texture0, texture1, texture2, boneWeight, position, normal,
  // tangent, color) reverses back to array order — texture0Scale is the
  // LAST element, i.e. the same index this file already (mis-)reads as
  // `colorScale`. Left as a separate name since only one of the two callers
  // is actually correct and this isn't the place to relitigate colorScale.
  const uvScale = uniform7[7] ?? 1;

  // The main attributes buffer address lives in reg 0x200; stride + attribute
  // count are packed into the buffer-0 stride register (0x205).
  const attributesBufferOffset = commands.parameter(VSH_ATTRS_BUFFER_ADDRESS);
  const strideRegister = commands.parameter(VSH_BUFFER0_STRIDE);
  const attributesBufferStride = (strideRegister >> 16) & 0xff;
  const totalAttributes = Math.min(strideRegister >> 28, 23);
  const mainPermutation = commands.mainPermutation();
  const bufferPermutation = commands.attributesBufferPermutation(0);
  const formats = commands.formats();
  let hasUvAttr = false;
  for (let a = 0; a < totalAttributes; a++) {
    if (mainPermutation[bufferPermutation[a] ?? 0] === ATTRIBUTE_UV) hasUvAttr = true;
  }

  const vertices: [number, number, number][] = [];
  const vertexColors: [number, number, number, number][] = [];
  const uvs: [number, number][] = [];
  const boneIndices: number[] = [];
  const faces: BchFace[] = [];

  for (let f = 0; f < facesHeaderEntries; f++) {
    const baseOffset = facesHeaderOffset + f * 0x34;
    const skinningMode = u16(view, baseOffset);
    const nodeIdEntries = u16(view, baseOffset + 2);
    const nodeList: number[] = [];
    for (let n = 0; n < nodeIdEntries; n++) nodeList.push(u16(view, baseOffset + 4 + n * 2));

    const faceHeaderOffset = u32(view, baseOffset + 0x2c);
    const faceHeaderWordCount = u32(view, baseOffset + 0x30);
    if (faceHeaderOffset >= view.byteLength) continue;
    const idxCommands = new PicaCommandReader(
      sliceView(view, faceHeaderOffset, faceHeaderWordCount * 4),
      faceHeaderWordCount,
    );
    const idxBufferOffset = idxCommands.indexBufferAddress();
    const idxBufferFormat = idxCommands.indexBufferFormat();
    const idxBufferTotalVertices = Math.min(idxCommands.indexBufferTotalVertices(), 0x40000);
    if (idxBufferOffset >= view.byteLength) continue;

    const base = vertices.length;
    let ip = idxBufferOffset;
    for (let i = 0; i < idxBufferTotalVertices; i++) {
      let index: number;
      if (idxBufferFormat === 0) {
        if (ip >= view.byteLength) break;
        index = u8(view, ip);
        ip += 1;
      } else {
        if (ip + 2 > view.byteLength) break;
        index = u16(view, ip);
        ip += 2;
      }
      const vBase = attributesBufferOffset + index * attributesBufferStride;
      if (vBase + 4 > view.byteLength) break;
      let pos: [number, number, number] = [0, 0, 0];
      let color: [number, number, number, number] = [1, 1, 1, 1];
      let uv: [number, number] = [0, 0];
      let boneIndex = -1;
      let hasVertexColor = false;
      let voff = vBase;
      for (let a = 0; a < totalAttributes; a++) {
        const att = mainPermutation[bufferPermutation[a] ?? 0]!;
        const format = formats[bufferPermutation[a] ?? 0]!;
        const type = att === ATTRIBUTE_BONE_WEIGHT ? 1 : format.type;
        const vec = readVector(view, voff, format, type);
        voff += (format.length + 1) * (type === 2 ? 2 : type === 3 ? 4 : 1);
        if (att === ATTRIBUTE_POSITION) {
          pos = [
            vec[0]! * positionScale + positionOffset[0],
            vec[1]! * positionScale + positionOffset[1],
            vec[2]! * positionScale + positionOffset[2],
          ];
        } else if (att === ATTRIBUTE_COLOR) {
          hasVertexColor = true;
          color = [
            sat(vec[0]! * colorScale),
            sat(vec[1]! * colorScale),
            sat(vec[2]! * colorScale),
            sat(vec[3]! * colorScale),
          ];
        } else if (att === ATTRIBUTE_UV) {
          const su = type === 2 ? vec[0]! / 32767 : vec[0]!;
          const sv = type === 2 ? vec[1]! / 32767 : vec[1]!;
          // 3DS convention: V=0 at the texture's top; flip to the
          // OpenGL/canvas V=0-at-bottom convention once here (see cgfx.ts).
          uv = [su * uvScale, 1 - sv * uvScale];
        } else if (att === ATTRIBUTE_BONE_INDEX && nodeList.length > 0) {
          const b0 = Math.floor(vec[0]!);
          if (b0 >= 0 && b0 < nodeList.length) boneIndex = nodeList[b0]!;
        }
      }
      // Skinning: transform by the bone's accumulated matrix (rigid/fallback).
      // `nodeList` entries are read straight off disk — a malformed/unusual
      // file can hold a bone index past the skeleton's actual bone count, so
      // treat that the same as "no bone" rather than emitting an index a
      // glTF skin (or this file's own `skeletonTransforms` lookup) can't use.
      let bone = boneIndex >= 0 ? boneIndex : nodeList.length > 0 ? nodeList[0]! : -1;
      if (bone >= 0 && bone < skeletonTransforms.length) {
        pos = matApply(skeletonTransforms[bone]!, pos);
      } else {
        bone = -1;
      }
      void skinningMode;
      vertices.push(pos);
      boneIndices.push(bone);
      if (hasVertexColor) vertexColors.push(color);
      if (hasUvAttr) uvs.push(uv);
    }

    for (let i = 0; i + 2 < vertices.length - base; i += 3) {
      faces.push({ verts: [base + i, base + i + 1, base + i + 2] });
    }
  }

  const hasSkinning = boneIndices.some((b) => b >= 0);
  return {
    name: '',
    vertices,
    faces,
    materialId: 0,
    ...(uvs.length > 0 ? { uvs } : {}),
    ...(vertexColors.length > 0 ? { vertexColors } : {}),
    ...(hasSkinning ? { boneIndices } : {}),
  };
}

function readVector(
  view: DataView,
  base: number,
  format: AttributeFormat,
  type: number,
): [number, number, number, number] {
  const n = Math.min(format.length + 1, 4);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  let off = base;
  for (let i = 0; i < n; i++) {
    switch (type) {
      case 0:
        out[i] = i8(view, off);
        off += 1;
        break;
      case 1:
        out[i] = u8(view, off);
        off += 1;
        break;
      case 2:
        out[i] = i16(view, off);
        off += 2;
        break;
      default:
        out[i] = readFloat(view, off);
        off += 4;
        break;
    }
  }
  return out;
}

function sat(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function bchFileStem(): string {
  return String(u16At(new Uint8Array(2), 0));
}

// ---------------------------------------------------------------------------
// Skeletal animation sampling — turns a `BchSkeletalAnimation`'s sparse,
// per-axis (or dense-vector) tracks into a uniform-time-grid sample set a
// glTF exporter can turn directly into LINEAR animation samplers.
// ---------------------------------------------------------------------------

export type BchSampledJointAnimation = CtrSampledJointAnimation;
export type BchSampledAnimation = CtrSampledAnimation;

/**
 * Resample one `BchSkeletalAnimation` onto a uniform time grid so every
 * bone's samples share the same timestamps, which LINEAR-interpolation glTF
 * samplers need. `bindBones` supplies each animated bone's bind-pose
 * rotation/translation, so an axis this clip doesn't animate still
 * contributes its resting value instead of 0.
 *
 * The body is `sampleCtrSkeletalAnimation` — BCH and CGFX had two copies of
 * it that differed in nothing but five type-name lines. See `ctr-anim.ts`
 * for the 30fps assumption and the rest of the rationale.
 */
export function sampleBchSkeletalAnimation(
  animation: BchSkeletalAnimation,
  bindBones: BchBone[],
  fps = 30,
  maxSamples = 120,
): BchSampledAnimation {
  return sampleCtrSkeletalAnimation(animation, bindBones, fps, maxSamples);
}
