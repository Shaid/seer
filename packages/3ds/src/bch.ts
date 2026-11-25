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
import {
  PicaRegisterFile,
  decodeAlphaTest,
  decodeBlendFunc,
  decodeLightPermutation,
  decodeLightingLutInputs,
  decodeTevStage,
  lightingLutFromCommands,
  readPicaWrites,
  type LightingLut,
  type LightingLutInput,
  type LightingLutSlot,
  type PicaBlend,
  type TevStage,
} from './pica.js';
import { parseShbin, type Shbin } from './shbin.js';
import { toModelSpace } from './skin.js';
import { ctrTextureByteSize } from './ctr-texture.js';
import {
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
  /** Second texture-coordinate set (attribute 5), present on Fates head meshes whose material also binds an eye map. */
  uvs1?: [number, number][];
  /** Rigid (single-influence) skinning bone per vertex, -1 if unskinned. Parallel to `vertices`. */
  boneIndices?: number[];
  /**
   * The vertex shader's per-mesh constants (`IrScale` = c7, c8 and `PosOffs` = c6 of the game's DefaultShader), read from the mesh's
   * command buffer. The shader computes `position = aPosition * irScale.position + posOffs`, `normal = aNormal * irScale.normal`,
   * `colour = aColor * irScale.color`, `uv0 = aTexCoord0 * irScale.tex0` (then the texture matrix), and the smooth-skin weight
   * `aBoneWeight * irScale.boneWeight` (docs/3ds-formats.md, "Material shading").
   */
  irScale?: {
    position: number;
    normal: number;
    tangent: number;
    color: number;
    tex0: number;
    tex1: number;
    tex2: number;
    boneWeight: number;
  };
  /** Position attribute type (0 int8, 1 uint8, 2 int16, 3 float32), the largest raw position component, the object's bounding-box size. */
  positionInfo?: { positionFormat: number; rawMax: number; boxSize: number | null; scale: number };
}

export interface BchBone {
  name: string;
  parentId: number;
  /** Bind-pose local TRS (radians for rotation), same convention as the skeletal-animation tracks. */
  scale: [number, number, number];
  rotation: [number, number, number];
  translation: [number, number, number];
}

/**
 * Fragment-pipeline state of one BCH material (docs/3ds-formats.md, "Material shading (all three titles)"). Read from the 0x140-byte
 * parameter block a material entry points at (+0x00) and the 0x84-word command buffer it points at (+0xC8): six TEV stages,
 * lighting LUT inputs, alpha test, blend, the vertex-shader constants the material uploads, the LUT names.
 */
export interface BchMaterialShading {
  /** The material's own name (`body_mat`, `skin_mat`, `MtBody`); `BchModel.materials[i].name` is a placeholder (`material<i>`). */
  materialName: string;
  /** `0@DefaultShader-hs`, `1@StealthShader`... : variant digit, program, suffix (-hs hemisphere light, -nl no vertex lights, -rs/-ss reflection / sphere map, -u2/-s2 second UV set). */
  shaderName: string;
  /** TEV stages 0-5. */
  tev: TevStage[];
  /** TEV buffer: initial colour (register 0xFD), update flags (register 0xE0). */
  tevBufferColor: [number, number, number, number];
  tevBufferUpdate: number;
  /** Packed colours at +0x58: emission, ambient, diffuse, specular0, specular1, constant0-5 (r, g, b, a 0-255). */
  colors: [number, number, number, number][];
  /** Lighting LUT slot configuration (registers 0x1D0-0x1D2). */
  lutInputs: Record<LightingLutSlot, LightingLutInput>;
  /** Table names of the six material LUT slots (+0xEC..+0x100): D0, D1, then (hypothesis for the rest) FR, RR, RG, RB; '' = unused. */
  lutNames: string[];
  /** LUT set (a `Bch.lutSets` entry) each slot reads from (+0xD4..+0xE8); '' = unused. */
  lutSetNames: string[];
  /** Light slots enabled (register permutation at +0xC0, nibbles). */
  lightPermutation: number[];
  /** The word at +0xA4 (2 in 343 of 347 sampled materials; `0x01010002` on the rest): lighting flags, meaning not decoded. */
  lightingFlags: number;
  /** `TexcMap` (vertex-shader constant c10) x, y, z: the UV set (0-2) each of the three texture units reads. */
  texCoordSources: [number, number, number];
  alphaTest: { enabled: boolean; func: string; ref: number };
  /** Blend function (register 0x101) and constant colour (0x103). */
  blend: PicaBlend;
  blendColor: [number, number, number, number];
  /** Register 0x40 (face culling: 0 none, 1 front, 2 back as stored by the SDK). */
  cullMode: number;
  /** Every register of the command buffer except the vertex-shader uniform ports, `[register, value]`. */
  registers: [number, number][];
  /** Vertex-shader float uniforms the material uploads, by constant register: `c10` TexcMap, `c11`-`c18` texture matrices, `c19` TexTran, `c20` MatAmbi, `c21` MatDiff. Each vec4 as stored (w, z, y, x). */
  vsUniforms: Record<number, number[]>;
}

/** One lighting LUT set (a BCH `Iron15_LUT` file: 18 named 256-entry tables). */
export interface BchLutSet {
  name: string;
  luts: { name: string; lut: LightingLut }[];
}

export interface BchModel {
  name: string;
  /**
   * `textureNames` are the material's three texture-slot names (`''` when a
   * slot is unused), read at +0x1c/+0x20/+0x24 of its 0x2c-byte entry — see
   * docs/3ds-formats.md §7 (lucina). Names match `Bch.textures[].name` of the
   * model's own file or its `_t` / `_cl0n_*` companion.
   */
  materials: { name: string; diffuse: [number, number, number, number]; textureNames: string[]; shading?: BchMaterialShading }[];
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
  /** Lighting LUT sets (`common/Iron15_LUT.bch`). */
  lutSets: BchLutSet[];
  /** Shader programs (`common/SharedData.bch`: the DefaultShader variants and the SilhouetteShader); one entry per shader name, sharing the parsed DVLB where names share a binary. */
  shaders: { name: string; shbin: Shbin }[];
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

/**
 * Divisor taking `int16 position x uniform-7 position scale` to the skeleton's units. The vertex shader constants c7/c8
 * (`getFloatUniform(7)`, 8 floats, each vec4 stored w,z,y,x) hold the scales of position, normal, tangent, colour | tex0,
 * tex1, tex2, bone weight, so the position scale is array index 3 (the normal's is index 2 = 1/127, which pins the order).
 * Settled (lucina docs/3ds-formats.md, Material shading): the position scale is the vertex shader constant c7.x (`IrScale`,
 * `uniform7[3]`), applied to the raw attribute and followed by `+ c6` (`PosOffs`); the earlier "x256 / power of 256 / box"
 * rules compensated for a register-merge bug in the command reader (rewrites of a register were OR-merged instead of
 * honouring the byte-enable mask). Kept only as a legacy export; `readMesh` no longer uses it.
 */
export const BCH_POSITION_UNITS = 256;
const ATTRIBUTE_POSITION = 0;
const ATTRIBUTE_COLOR = 3;
const ATTRIBUTE_UV = 4;
const ATTRIBUTE_UV1 = 5;
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
          this.currentUniforms.push(f32(next));
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

  /**
   * PICA command writes carry a 4-bit byte-enable mask (bit i = byte i is written). The first version of this reader treated the
   * mask as a bit mask and OR-ed the previous register value into every rewrite, so a register written twice (the float uniform
   * data port 0x2c1, once per uniform) came out as the OR of all its earlier values: `IrScale.x` read 256x too large because
   * an earlier write's exponent bits were merged in (docs/3ds-formats.md, "Material shading", the BCH position-scale answer).
   */
  private writeCommand(id: number, mask: number, parameter: number): void {
    let value = this.commands[id]!;
    for (let b = 0; b < 4; b++) {
      if ((mask >> b) & 1) value = (value & ~(0xff << (8 * b))) | (parameter & (0xff << (8 * b)));
    }
    this.commands[id] = value >>> 0;
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
  const models = readModels(rv, mainHeaderOffset, stringTableOffset);
  const skeletalAnimations = readSkeletalAnimations(rv, mainHeaderOffset);
  return { models, textures, skeletalAnimations, lutSets: readLutSets(rv, mainHeaderOffset), shaders: readShaders(rv, mainHeaderOffset) };
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

function readModels(view: DataView, mainHeaderOffset: number, stringTableOffset: number): BchModel[] {
  const modelsPointerTableOffset = u32(view, mainHeaderOffset);
  const modelsPointerTableEntries = u32(view, mainHeaderOffset + 4);
  const modelsNameOffset = u32(view, mainHeaderOffset + 8);
  void modelsNameOffset;

  const models: BchModel[] = [];
  for (let m = 0; m < Math.min(modelsPointerTableEntries, 0x100); m++) {
    const modelOffset = u32(view, modelsPointerTableOffset + m * 4);
    if (modelOffset >= view.byteLength) continue;
    try {
      const model = readModel(view, modelOffset, stringTableOffset);
      if (model.meshes.length > 0) models.push(model);
    } catch (e) {
      console.warn(`  ✗ BCH model ${m}: ${(e as Error).message}`);
    }
  }
  return models;
}

function readModel(view: DataView, base: number, stringTableOffset: number): BchModel {
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
    // Texture-slot name pointers at +0x1c/+0x20/+0x24: relative to the string
    // table unless the file's relocation table already made them absolute.
    const textureNames: string[] = [];
    for (let slot = 0; slot < 3; slot++) {
      const raw = mo + 0x1c + slot * 4 + 4 <= view.byteLength ? u32(view, mo + 0x1c + slot * 4) : 0;
      const abs = raw >= stringTableOffset ? raw : raw + stringTableOffset;
      textureNames.push(raw !== 0 && abs < view.byteLength ? readCString(view, abs) : '');
    }
    const shading = readMaterialShading(view, mo, stringTableOffset);
    materials.push({ name: `material${i}`, diffuse: [0.8, 0.8, 0.8, 1], textureNames, ...(shading ? { shading } : {}) });
  }

  // Objects (meshes). Each entry is 0x38 bytes at bc >= 0x21 (Fates/Echoes
  // bc 0x22): materialId/flags/nodeId/priority (8) + vsh-commands (off,wc) +
  // faces-header (off,count) + a second command block (off,wc) + bounding
  // centre (3 floats) + 4 trailing words. The earlier 0x40 stride read the
  // 2nd+ object of every multi-object model from the wrong offset (garbage
  // 100k-vertex meshes). Verified over 943 multi-object Fates models: 0x38
  // gives in-range entries in 938, 0x40 in 0 (docs/3ds-formats.md §7).
  const objectStride = bc >= 0x21 ? 0x38 : 0x40;
  const meshes: BchMesh[] = [];
  for (let oi = 0; oi < verticesTableEntries; oi++) {
    const vo = verticesTableOffset + oi * objectStride;
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
    // A handful of field models (e.g. Btl_WoodsLost) carry an object table
    // whose entries sit 12 bytes off our read position; the garbage entries
    // show up as 0x3fc-style face-header counts and ~0.5M-vertex meshes.
    // Real entries have 1-3 face headers (max seen well under 0x40).
    if (facesHeaderEntries > 0x40 || vshCommandsWordCount > 0x4000) continue;

    const mesh = readMesh(
      view,
      readObjectBoxSize(view, u32(view, vo + 0x34)),
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

function bchString(view: DataView, raw: number, stringTableOffset: number): string {
  if (raw === 0) return '';
  const abs = raw >= stringTableOffset ? raw : raw + stringTableOffset;
  return abs < view.byteLength ? readCString(view, abs) : '';
}

const rgba8 = (v: number): [number, number, number, number] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

/**
 * The fragment state of the material entry at `mo` (0x2c bytes): +0x00 points at the 0x140-byte parameter block, which holds the
 * colours (+0x58), the lighting words (+0xA4 flags, +0xA8 abs, +0xB0 select, +0xB8 scale, +0xC0 light permutation), the fragment command
 * buffer (+0xC8 offset, +0xCC word count), the LUT set / table name pointers (+0xD4.., +0xEC..) and the shader name (+0x104).
 * Returns null when the block or the buffer is out of range.
 */
function readMaterialShading(view: DataView, mo: number, stringTableOffset: number): BchMaterialShading | null {
  if (mo + 0x2c > view.byteLength) return null;
  const p = u32(view, mo);
  if (p === 0 || p + 0x140 > view.byteLength) return null;
  const bufOffset = u32(view, p + 0xc8);
  const bufWords = u32(view, p + 0xcc);
  if (bufWords === 0 || bufWords > 0x400 || bufOffset + bufWords * 4 > view.byteLength) return null;
  const words: number[] = [];
  for (let i = 0; i < bufWords; i++) words.push(u32(view, bufOffset + 4 * i));
  const writes = readPicaWrites(words);
  const regs = new PicaRegisterFile().apply(writes.filter((w) => w.reg < 0x2c0 || w.reg > 0x2c8));
  const vsUniforms: Record<number, number[]> = {};
  let current = -1;
  for (const w of writes) {
    if (w.reg === 0x2c0) current = w.value & 0x7f;
    else if (w.reg >= 0x2c1 && w.reg <= 0x2c8 && current >= 0) (vsUniforms[current] ??= []).push(f32(w.value));
  }
  const tc = vsUniforms[10] ?? [];
  const colors: [number, number, number, number][] = [];
  for (let i = 0; i < 11; i++) colors.push(rgba8(u32(view, p + 0x58 + 4 * i)));
  const lutNames: string[] = [];
  const lutSetNames: string[] = [];
  for (let i = 0; i < 6; i++) {
    lutNames.push(bchString(view, u32(view, p + 0xec + 4 * i), stringTableOffset));
    lutSetNames.push(bchString(view, u32(view, p + 0xd4 + 4 * i), stringTableOffset));
  }
  return {
    materialName: bchString(view, u32(view, mo + 0x28), stringTableOffset),
    shaderName: bchString(view, u32(view, p + 0x104), stringTableOffset),
    tev: [0, 1, 2, 3, 4, 5].map((i) => decodeTevStage((r) => regs.get(r), i)),
    tevBufferColor: rgba8(regs.get(0xfd)),
    tevBufferUpdate: regs.get(0xe0),
    colors,
    lutInputs: decodeLightingLutInputs(u32(view, p + 0xa8), u32(view, p + 0xb0), u32(view, p + 0xb8)),
    lutNames,
    lutSetNames,
    lightPermutation: decodeLightPermutation(u32(view, p + 0xc0), 5),
    lightingFlags: u32(view, p + 0xa4),
    texCoordSources: [tc[3] ?? 0, tc[2] ?? 0, tc[1] ?? 0],
    alphaTest: decodeAlphaTest(regs.get(0x104)),
    blend: decodeBlendFunc(regs.get(0x101)),
    blendColor: rgba8(regs.get(0x103)),
    cullMode: regs.get(0x40),
    registers: regs.entries(),
    vsUniforms,
  };
}

/** The LUT sets of the content header (triple at +48): per set 18-odd named tables, each a command buffer of 256 writes to port 0x1C8. */
function readLutSets(view: DataView, mainHeaderOffset: number): BchLutSet[] {
  const out: BchLutSet[] = [];
  const table = u32(view, mainHeaderOffset + 48);
  const count = Math.min(u32(view, mainHeaderOffset + 52), 64);
  if (count === 0 || table + count * 4 > view.byteLength) return out;
  for (let i = 0; i < count; i++) {
    const set = u32(view, table + 4 * i);
    if (set + 12 > view.byteLength) continue;
    const samplers = u32(view, set);
    const n = Math.min(u32(view, set + 4), 256);
    const name = readCString(view, u32(view, set + 8));
    const luts: BchLutSet['luts'] = [];
    for (let k = 0; k < n; k++) {
      const o = samplers + 16 * k;
      if (o + 16 > view.byteLength) break;
      const cmd = u32(view, o + 4);
      const wc = u32(view, o + 8);
      if (cmd + wc * 4 > view.byteLength) continue;
      const words: number[] = [];
      for (let w = 0; w < wc; w++) words.push(u32(view, cmd + 4 * w));
      const lut = lightingLutFromCommands(words);
      if (lut) luts.push({ name: readCString(view, u32(view, o + 12)), lut });
    }
    out.push({ name, luts });
  }
  return out;
}

/** The shader table (content header triple at +24): entries of `[DVLB offset][size] ... [name at +0x28]`. */
function readShaders(view: DataView, mainHeaderOffset: number): { name: string; shbin: Shbin }[] {
  const out: { name: string; shbin: Shbin }[] = [];
  const table = u32(view, mainHeaderOffset + 24);
  const count = Math.min(u32(view, mainHeaderOffset + 28), 256);
  if (count === 0 || table + count * 4 > view.byteLength) return out;
  const cache = new Map<number, Shbin>();
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < count; i++) {
    const entry = u32(view, table + 4 * i);
    if (entry + 0x2c > view.byteLength) continue;
    const dvlb = u32(view, entry);
    try {
      let shbin = cache.get(dvlb);
      if (!shbin) {
        shbin = parseShbin(bytes, dvlb);
        cache.set(dvlb, shbin);
      }
      out.push({ name: readCString(view, u32(view, entry + 0x28)), shbin });
    } catch {
      /* not a DVLB: skip */
    }
  }
  return out;
}

/**
 * The largest side of an object's oriented bounding box. The pointer at +0x34 of an object entry leads to centre (3 floats),
 * the 3x3 axes (9 floats) and the size (3 floats) at float index 12, 15 and 24. Null when the pointer is out of range or the
 * size is not a positive finite number.
 */
function readObjectBoxSize(view: DataView, pointer: number): number | null {
  if (pointer === 0 || pointer + 27 * 4 > view.byteLength) return null;
  let max = 0;
  for (let k = 24; k < 27; k++) {
    const v = readFloat(view, pointer + k * 4);
    if (!Number.isFinite(v) || v < 0) return null;
    max = Math.max(max, v);
  }
  return max > 0 ? max : null;
}

function readMesh(
  view: DataView,
  boxSize: number | null,
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
  // The float uniforms are stored as PICA vec4 register words, w z y x, so a position offset (x, y, z) sits at
  // array indices 3, 2, 1. Read in array order (0, 1, 2) a Fates body's offset (0, 6.358, -0.076) came out as
  // (0, -0.076, 6.358): the body shifted 6.4 along z instead of up (feet at -6.5 instead of 0).
  const positionOffset: [number, number, number] = [
    uniform6[3] ?? 0,
    uniform6[2] ?? 0,
    uniform6[1] ?? 0,
  ];
  // `IrScale` (c7, c8): each vec4 is stored w, z, y, x, so c7 = (position, normal, tangent, colour) is array indices 3, 2, 1, 0 and
  // c8 = (tex0, tex1, tex2, bone weight) indices 7, 6, 5, 4. The shader multiplies the raw attribute by these directly; there is no
  // other divisor (the older 256x / bounding-box heuristics compensated for a register-merge bug in this reader's `writeCommand`).
  const irScale = {
    position: uniform7[3] ?? 1,
    normal: uniform7[2] ?? 1,
    tangent: uniform7[1] ?? 1,
    color: uniform7[0] ?? 1,
    tex0: uniform7[7] ?? 1,
    tex1: uniform7[6] ?? 1,
    tex2: uniform7[5] ?? 1,
    boneWeight: uniform7[4] ?? 1,
  };
  const uniformPositionScale = irScale.position;
  const colorScale = irScale.color;
  // Texture coordinates stay raw / 32767 (the tex0 scale is 1/32767 to within a few percent; lucina docs 11.5 measured both).
  const uvScale = 1;

  // The main attributes buffer address lives in reg 0x200; stride + attribute
  // count are packed into the buffer-0 stride register (0x205).
  // Buffer 0's own address (reg 0x203) is what the vertex indices are relative
  // to; reg 0x200 is only the shared base. They coincide for single-object
  // models (offset 0), but multi-object field models keep every object's
  // vertices in one buffer, so 0x200 alone reads every object from the start
  // of the shared buffer (shredded geometry). 0x203 is already absolute after
  // relocation (docs/3ds-formats.md §7.4); fall back to 0x200 if unset.
  const attributesBufferOffset =
    commands.attributesBufferAddress(0) || commands.parameter(VSH_ATTRS_BUFFER_ADDRESS);
  const strideRegister = commands.parameter(VSH_BUFFER0_STRIDE);
  const attributesBufferStride = (strideRegister >> 16) & 0xff;
  const totalAttributes = Math.min(strideRegister >> 28, 23);
  const mainPermutation = commands.mainPermutation();
  const bufferPermutation = commands.attributesBufferPermutation(0);
  const formats = commands.formats();
  let hasUvAttr = false;
  let hasUv1Attr = false;
  for (let a = 0; a < totalAttributes; a++) {
    if (mainPermutation[bufferPermutation[a] ?? 0] === ATTRIBUTE_UV) hasUvAttr = true;
    if (mainPermutation[bufferPermutation[a] ?? 0] === ATTRIBUTE_UV1) hasUv1Attr = true;
  }

  const vertices: [number, number, number][] = [];
  const vertexColors: [number, number, number, number][] = [];
  const uvs: [number, number][] = [];
  const uvs1: [number, number][] = [];
  const boneIndices: number[] = [];
  const skinModes: number[] = [];
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
      let uv1: [number, number] | null = null;
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
          pos = [vec[0]!, vec[1]!, vec[2]!]; // raw int16; scaled below once the mesh's range is known
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
        } else if (att === ATTRIBUTE_UV1) {
          const su = type === 2 ? vec[0]! / 32767 : vec[0]!;
          const sv = type === 2 ? vec[1]! / 32767 : vec[1]!;
          uv1 = [su, 1 - sv];
        } else if (att === ATTRIBUTE_BONE_INDEX && nodeList.length > 0) {
          const b0 = Math.floor(vec[0]!);
          if (b0 >= 0 && b0 < nodeList.length) boneIndex = nodeList[b0]!;
        }
      }
      // Skinning: bone-local (rigid / none) vertices take the bone's accumulated matrix; smooth ones (skinningMode 1) are
      // already in model space (src/skin.ts).
      // `nodeList` entries are read straight off disk — a malformed/unusual
      // file can hold a bone index past the skeleton's actual bone count, so
      // treat that the same as "no bone" rather than emitting an index a
      // glTF skin (or this file's own `skeletonTransforms` lookup) can't use.
      let bone = boneIndex >= 0 ? boneIndex : nodeList.length > 0 ? nodeList[0]! : -1;
      if (!(bone >= 0 && bone < skeletonTransforms.length)) bone = -1;
      skinModes.push(skinningMode);
      vertices.push(pos);
      boneIndices.push(bone);
      if (hasVertexColor) vertexColors.push(color);
      if (hasUvAttr) uvs.push(uv);
      if (hasUv1Attr) uvs1.push(uv1 ?? [0, 0]);
    }

    for (let i = 0; i + 2 < vertices.length - base; i += 3) {
      faces.push({ verts: [base + i, base + i + 1, base + i + 2] });
    }
  }

  // Scale the raw positions. Skinning: bone-local (rigid / none) vertices take the bone's accumulated matrix; smooth ones
  // (BCH skinningMode 1) are already in model space (src/skin.ts). `nodeList` entries are read straight off disk, so a bone
  // index past the skeleton's bone count was treated as "no bone" above.
  let rawMax = 0;
  for (const v of vertices) rawMax = Math.max(rawMax, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  // The shader's own constant. The box is only a fallback for a mesh whose command buffer has no usable IrScale.
  let positionScale = uniformPositionScale;
  if (!(positionScale > 0 && Number.isFinite(positionScale)) || uniform7.length < 4) {
    positionScale = boxSize !== null && rawMax > 0 ? boxSize / 2 / rawMax : 1;
  }
  for (let i = 0; i < vertices.length; i++) {
    const raw = vertices[i]!;
    let pos: [number, number, number] = [
      raw[0] * positionScale + positionOffset[0],
      raw[1] * positionScale + positionOffset[1],
      raw[2] * positionScale + positionOffset[2],
    ];
    const bone = boneIndices[i]!;
    if (bone >= 0) pos = toModelSpace(pos, skeletonTransforms[bone]!, 'bch', skinModes[i]!);
    vertices[i] = pos;
  }

  const hasSkinning = boneIndices.some((b) => b >= 0);
  const positionAttr = mainPermutation.findIndex((a) => a === ATTRIBUTE_POSITION);
  return {
    name: '',
    irScale,
    positionInfo: {
      positionFormat: formats[positionAttr >= 0 ? positionAttr : 0]?.type ?? -1,
      rawMax,
      boxSize,
      scale: positionScale,
    },
    vertices,
    faces,
    materialId: 0,
    ...(uvs.length > 0 ? { uvs } : {}),
    ...(uvs1.length > 0 ? { uvs1 } : {}),
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
