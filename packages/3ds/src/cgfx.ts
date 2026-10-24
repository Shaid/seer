/**
 * 3DS CGFX container parser — the resource format used for 3D models (e.g.
 * Fire Emblem Awakening's `b/*.m.lz` battle models, `effect/*.bcres.lz`) and
 * their textures. CGFX wraps model (CMDL), texture (TXOB), material and
 * animation chunks behind a dictionary tree.
 *
 * Ported from Ohana3DS-Rebirth's `Models/CGFX.cs` (gdkchan): textures, static
 * geometry (vertices + faces + material colors, rigid-skinning transforms
 * applied where cheap), bind-pose bones (`CgfxModel.bones`/`bindMatrices`),
 * and skeletal-animation clips (`Cgfx.skeletalAnimations`,
 * `sampleSkeletalAnimation`).
 *
 * Layout notes:
 * - Header: "CGFX", u16 endian (0xFFFE), u16 header length (0x14), then a
 *   few u32s; the DATA chunk follows at `header length`.
 * - DATA: "DATA" + u32 length, then a series of `[entries u32][dict offset]`
 *   references (models, textures, materials, shaders, animations…).
 * - DICT: "DICT" + length + entry count + radix-tree fields, then per entry:
 *   `[refBit i32][left u16][right u16][nameOffset][dataOffset]`.
 * - Offsets are stored relative to their own field position.
 */
import {
  sampleCtrSkeletalAnimation,
  type CtrAnimAxis,
  type CtrAnimVec4,
  type CtrAnimBoneTrack,
  type CtrSampledAnimation,
  type CtrSampledJointAnimation,
} from './ctr-anim.js';
import { u32At, u16At } from './le.js';
import {
  matApply,
  matMul,
  matRotX,
  matRotY,
  matRotZ,
  matScale,
  matTranslate,
  type Mat4,
} from './mat4-ctr.js';

interface DictEntry {
  name: string;
  offset: number;
}

function readCString(data: Uint8Array, off: number): string {
  let end = off;
  while (end < data.length && data[end] !== 0) end++;
  return new TextDecoder('shift_jis').decode(data.subarray(off, end));
}

/** Relative offset: field position + value (0 stays 0). */
function relOffset(data: Uint8Array, fieldPos: number): number {
  const v = u32At(data, fieldPos);
  return v ? fieldPos + v : 0;
}

function readDict(data: Uint8Array, offset: number): DictEntry[] {
  const count = Math.min(u32At(data, offset + 8), 0x4000);
  const entries: DictEntry[] = [];
  let p = offset + 0x1c;
  for (let i = 0; i < count; i++) {
    p += 8; // reference bit i32, left u16, right u16
    const nameOffset = relOffset(data, p);
    p += 4;
    const dataOffset = relOffset(data, p);
    p += 4;
    entries.push({ name: readCString(data, nameOffset), offset: dataOffset });
  }
  return entries;
}

/** Read a `[entries u32][dict offset]` dictionary reference. */
function readDictRef(data: Uint8Array, fieldPos: number): DictEntry[] {
  const count = u32At(data, fieldPos);
  const offset = relOffset(data, fieldPos + 4);
  return count > 0 ? readDict(data, offset) : [];
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

export interface CgfxTexture {
  name: string;
  /** CT SDK format id (same numbering as CTPK: 12 = ETC1, 13 = ETC1A4). */
  format: number;
  width: number;
  height: number;
  mipmapLevels: number;
  dataOffset: number;
  dataLength: number;
}

function readTextures(data: Uint8Array, dict: DictEntry[]): CgfxTexture[] {
  const out: CgfxTexture[] = [];
  for (const entry of dict) {
    const base = entry.offset;
    if (base + 0x60 > data.length) continue;
    if (
      String.fromCharCode(data[base + 4], data[base + 5], data[base + 6], data[base + 7]) !== 'TXOB'
    )
      continue;
    const height = u32At(data, base + 0x18);
    const width = u32At(data, base + 0x1c);
    const format = u32At(data, base + 0x34);
    const mipmapLevels = u32At(data, base + 0x28);
    const dataLength = u32At(data, base + 0x44);
    const dataOffset = relOffset(data, base + 0x48);
    out.push({ name: entry.name, format, width, height, mipmapLevels, dataOffset, dataLength });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface AttributeFormat {
  attribute: number;
  type: number; // 0 = i8, 1 = u8, 2 = i16, 6 = f32
  length: number; // number of components
  scale: number;
  offset: number; // byte offset within the vertex
}

export interface CgfxFace {
  /** Vertex indices into `vertices`. */
  verts: number[];
}

export interface CgfxMesh {
  name: string;
  /** Raw decoded vertex positions (index buffer order, possibly duplicated). */
  vertices: [number, number, number][];
  /** Faces as index lists (triangles / strips / fans resolved to lists). */
  faces: CgfxFace[];
  materialId: number;
  /** Per-vertex RGBA colors (0..1) when the shape has a color attribute. */
  vertexColors?: [number, number, number, number][];
  /** Per-vertex UV texture coordinates when the shape has a UV attribute. */
  uvs?: [number, number][];
  /** Rigid (single-influence) skinning bone per vertex, -1 if unskinned. Parallel to `vertices`. */
  boneIndices?: number[];
}

export interface CgfxMaterial {
  name: string;
  /** RGBA diffuse color, floats 0..1. */
  diffuse: [number, number, number, number];
  /** Name of texture-mapper-0's texture (the primary/diffuse map), if any — cross-references `Cgfx.textures[].name`. */
  textureName?: string;
}

export interface CgfxModel {
  name: string;
  materials: CgfxMaterial[];
  meshes: CgfxMesh[];
  bones: CgfxBone[];
  /** Accumulated (bone-to-model-space) bind matrices, one per `bones` entry. */
  bindMatrices: number[][];
}

// Aliases of the shared CTR animation shapes — see `ctr-anim.ts`. CGFX and
// BCH wrap the same CTR SDK structures; only the containers differ. Kept
// exported under their original names (published surface).
/** A single float channel's keyframes, already scaled to (frame, value). */
export type CgfxAnimAxis = CtrAnimAxis;
/** A vec3/vec4 channel (transformQuaternion segment) — constant or a dense per-frame array. */
export type CgfxAnimVec4 = CtrAnimVec4;
export type CgfxAnimBoneTrack = CtrAnimBoneTrack;

export interface CgfxSkeletalAnimation {
  name: string;
  loopMode: number;
  frameSize: number;
  bones: CgfxAnimBoneTrack[];
}

export interface Cgfx {
  models: CgfxModel[];
  textures: CgfxTexture[];
  skeletalAnimations: CgfxSkeletalAnimation[];
}

const PRIMITIVE_TRIANGLES = 4;
const PRIMITIVE_TRIANGLE_STRIP = 5;
const PRIMITIVE_TRIANGLE_FAN = 6;

function readFloat(data: Uint8Array, off: number): number {
  if (off < 0 || off + 4 > data.length) return 0;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat32(off, true);
}

// ---------------------------------------------------------------------------
// Rigid-skinning bone transforms. `matMul`/`matApply`/`matRotX`/etc. come
// from mat4-ctr.ts (see that file's doc comment) — `accumulateBone` stays
// local because it takes this file's own `CgfxBone` shape and, as of this
// package's extraction, is no longer byte-identical to bch.ts's version
// (bch.ts's guards against an undefined bone entry and an out-of-range or
// self-referential parent index; this one doesn't — see mat4-ctr.ts).
// ---------------------------------------------------------------------------

/** A bone's accumulated (world-space) transform, per Ohana3DS transformSkeleton. */
function accumulateBone(bones: CgfxBone[], index: number): Mat4 {
  const b = bones[index]!;
  const local = matMul(
    matMul(
      matMul(matMul(matScale(b.scale), matRotX(b.rotation[0])), matRotY(b.rotation[1])),
      matRotZ(b.rotation[2]),
    ),
    matTranslate(b.translation),
  );
  return b.parentId >= 0 ? matMul(local, accumulateBone(bones, b.parentId)) : local;
}

interface Shape {
  name: string;
  positionOffset: [number, number, number];
  facesGroupEntries: number;
  facesGroupOffset: number;
  vertexGroupOffset: number;
}

export interface CgfxBone {
  name: string;
  parentId: number;
  scale: [number, number, number];
  rotation: [number, number, number];
  translation: [number, number, number];
}

/** Parse the skeleton (SOBJ) into bones. */
function readSkeleton(data: Uint8Array, skeletonOffset: number): CgfxBone[] {
  let p = skeletonOffset;
  u32At(data, p); // flags
  p += 4;
  p += 4; // magic
  p += 4; // revision
  // BUG FIX: there used to be a spurious extra `p += 4` here before reading
  // the name-offset field, shifting every subsequent read (including the
  // bone dictionary itself) 4 bytes late — verified against Ohana3DS-Rebirth's
  // CGFX.cs SOBJ reader (`name = readString(getRelativeOffset(input))` comes
  // immediately after `revision`, with no field in between). The dictionary
  // read landing 4 bytes off produced a garbage entry count that happened to
  // decode as 0 for every sampled file, silently reporting "no skeleton" for
  // every CGFX model that actually has one.
  const nameOffset = relOffset(data, p);
  p += 4;
  const bones: CgfxBone[] = [];
  const name = readCString(data, nameOffset);
  void name;
  p += 4; // ?
  p += 4; // ?
  const boneDict = readDictRef(data, p);
  p += 8;
  p += 4; // root bone offset
  p += 4; // scaling rule
  p += 4; // translate anim flag
  for (const entry of boneDict) {
    let bp = entry.offset;
    const boneName = readCString(data, relOffset(data, bp));
    bp += 4;
    u32At(data, bp); // bone flags
    bp += 4;
    u32At(data, bp); // bone id
    bp += 4;
    const parentId = ((u32At(data, bp) << 16) >> 16) as number; // i16
    bp += 4;
    bp += 16; // parent/child/sibling offsets
    const scale: [number, number, number] = [
      readFloat(data, bp),
      readFloat(data, bp + 4),
      readFloat(data, bp + 8),
    ];
    bp += 12;
    const rotation: [number, number, number] = [
      readFloat(data, bp),
      readFloat(data, bp + 4),
      readFloat(data, bp + 8),
    ];
    bp += 12;
    const translation: [number, number, number] = [
      readFloat(data, bp),
      readFloat(data, bp + 4),
      readFloat(data, bp + 8),
    ];
    bones.push({ name: boneName, parentId, scale, rotation, translation });
  }
  return bones;
}

interface ShapeGeometry {
  vertices: [number, number, number][];
  vertexColors: [number, number, number, number][];
  uvs: [number, number][];
  faces: CgfxFace[];
  boneIndices?: number[];
}

function readModel(
  data: Uint8Array,
  entry: DictEntry,
  knownTextureNames: ReadonlySet<string>,
): {
  name: string;
  materials: CgfxMaterial[];
  shapes: Shape[];
  shapeGeometry: ShapeGeometry[];
  hasSkeleton: boolean;
  shapeMaterialIds: number[];
  bones: CgfxBone[];
  bindMatrices: number[][];
} {
  let p = entry.offset;
  const flags = u32At(data, p);
  p += 4;
  const hasSkeleton = (flags & 0x80) !== 0;
  p += 4; // magic
  p += 4; // revision
  const name = readCString(data, relOffset(data, p));
  p += 4;
  p += 4; // user data entries
  p += 4; // user data dict offset
  p += 4;
  p += 4; // flags
  p += 4; // child count
  p += 4;
  p += 4; // animation group entries
  p += 4; // animation group dict offset
  p += 12; // transform scale
  p += 12; // transform rotate
  p += 12; // transform translate
  p += 48; // local matrix
  p += 48; // world matrix
  const objectEntries = u32At(data, p);
  p += 4;
  const objectPointerTableOffset = relOffset(data, p);
  p += 4;
  const materialDict = readDictRef(data, p);
  p += 8;
  const shapeEntries = u32At(data, p);
  p += 4;
  const shapePointerTableOffset = relOffset(data, p);
  p += 4;
  p += 8; // object nodes dict ref
  p += 4; // flags
  p += 4; // cull mode
  p += 4; // layer id
  let skeletonOffset = 0;
  if (hasSkeleton) {
    skeletonOffset = relOffset(data, p);
    p += 4;
  }
  // Materials. Layout verified against Ohana3DS-Rebirth's MTOB reader
  // (Models/CGFX.cs + MeshUtils.cs): every "color" field is written twice,
  // first as 11 float4s (`getColorFloat`, 16 bytes each — read by the PICA
  // command buffers, discarded here) and only then as 11 packed RGBA8 colors
  // (`getColor`, 4 bytes each — the ones actually used as material colors).
  // A 44-byte skip (the packed-color block's size, not the float block's)
  // used to land mid-way through the float block instead, so `diffuse` was
  // reading [Diffuse.A, Specular0.R, Specular0.G, Specular0.B] as floats.
  const materials: CgfxMaterial[] = [];
  for (const m of materialDict) {
    let mp = m.offset;
    mp += 4; // flags
    mp += 4; // magic
    mp += 4; // revision
    const matName = readCString(data, relOffset(data, mp));
    mp += 4;
    mp += 4; // user data entries
    mp += 4; // user data offset
    mp += 4; // flags
    mp += 4; // texture coords config
    mp += 4; // translucency kind
    mp += 11 * 16; // 11 float4 colors (emission..constant5), unused
    mp += 8; // packed emission, ambient (u8×4 each), unused
    const diffuse: [number, number, number, number] = [
      data[mp]! / 255,
      data[mp + 1]! / 255,
      data[mp + 2]! / 255,
      data[mp + 3]! / 255,
    ];
    mp += 4; // diffuse (just read)
    mp += 4 * 8; // specular0, specular1, constant0..5 (u8×4 each), unused
    // Rasterization: polygonOffsetEnabled(u32) + cullMode(u32) + polygonOffsetUnit(f32) + 0xC pad
    mp += 4 + 4 + 4 + 12;
    // Fragment operation: depth (flags u32 + 4-word PICA command buffer),
    // blend (mode u32 + color float4 + 5-word buffer), stencil (flags u32 +
    // 4-word buffer). A PICA "word" is 4 bytes; these word counts are fixed
    // for these known register sets (see PICACommandReader.cs).
    mp += 4 + 4 * 4; // depth
    mp += 4 + 16 + 4 * 5; // blend
    mp += 4 + 4 * 4; // stencil
    // Texture coordinates: usedTextureCoordinates(u32) + 3 coordinator
    // entries (10 u32/f32 fields + a 48-byte 3×4 transform matrix each).
    mp += 4;
    mp += 3 * (10 * 4 + 48);
    // Texture mappers: 4 relative-offset fields (mapper 3 is reserved/unused
    // by the format). Prefer the first mapper whose name matches one of this
    // file's embedded textures — an unmatched name (e.g. "envmap") is a
    // shared/built-in reference the CGFX doesn't embed, not this decoder
    // being wrong.
    let textureName: string | undefined;
    let firstResolvedName: string | undefined;
    for (let mi = 0; mi < 3; mi++) {
      const mapperOffset = relOffset(data, mp + mi * 4);
      if (!mapperOffset) continue;
      const textureHeaderOffset = relOffset(data, mapperOffset + 8);
      if (!textureHeaderOffset) continue;
      const nameOff = relOffset(data, textureHeaderOffset + 0x18);
      if (!nameOff) continue;
      const name = readCString(data, nameOff);
      if (!firstResolvedName) firstResolvedName = name;
      if (knownTextureNames.has(name)) {
        textureName = name;
        break;
      }
    }
    if (!textureName) textureName = firstResolvedName;
    materials.push({ name: matName, diffuse, ...(textureName ? { textureName } : {}) });
  }

  // Shapes (geometry headers)
  const shapes: Shape[] = [];
  for (let i = 0; i < shapeEntries; i++) {
    const so = relOffset(data, shapePointerTableOffset + i * 4);
    let sp = so;
    u32At(data, sp); // flags
    sp += 4;
    sp += 4; // magic
    sp += 4; // revision
    const shapeName = readCString(data, relOffset(data, sp));
    sp += 4;
    sp += 4; // user data entries
    sp += 4; // user data offset
    sp += 4; // flags
    sp += 4; // bounding box offset
    const positionOffset: [number, number, number] = [
      readFloat(data, sp),
      readFloat(data, sp + 4),
      readFloat(data, sp + 8),
    ];
    sp += 12;
    const facesGroupEntries = u32At(data, sp);
    sp += 4;
    const facesGroupOffset = relOffset(data, sp);
    sp += 4;
    sp += 4; // ?
    sp += 4; // vertex group entries
    const vertexGroupOffset = relOffset(data, sp);
    shapes.push({
      name: shapeName,
      positionOffset,
      facesGroupEntries,
      facesGroupOffset,
      vertexGroupOffset,
    });
  }

  // Decode each shape's geometry from its first vertex buffer + face groups.
  let skeletonTransforms: Mat4[] = [];
  let bones: CgfxBone[] = [];
  if (hasSkeleton && skeletonOffset) {
    bones = readSkeleton(data, skeletonOffset);
    skeletonTransforms = bones.map((_, i) => accumulateBone(bones, i));
  }
  const shapeGeometry: ShapeGeometry[] = [];
  for (const shape of shapes) {
    shapeGeometry.push(readShapeGeometry(data, shape, skeletonTransforms));
  }

  // Objects: the shapeIndex → materialId mapping (MSOB entries). A shape has
  // no material of its own — a model's "objects" table is what assigns one,
  // via a pointer table of relative offsets into per-object MSOB structs.
  const shapeMaterialIds = new Array(shapes.length).fill(0);
  for (let i = 0; i < Math.min(objectEntries, 0x1000); i++) {
    const objOffset = relOffset(data, objectPointerTableOffset + i * 4);
    if (!objOffset) continue;
    const shapeIndex = u32At(data, objOffset + 24);
    const materialId = u32At(data, objOffset + 28);
    if (shapeIndex < shapeMaterialIds.length) shapeMaterialIds[shapeIndex] = materialId;
  }

  const bindMatrices = skeletonTransforms.map((m) => [...m]);
  return { name, materials, shapes, shapeGeometry, hasSkeleton, shapeMaterialIds, bones, bindMatrices };
}

function readShapeGeometry(
  data: Uint8Array,
  shape: Shape,
  skeletonTransforms: Mat4[],
): ShapeGeometry {
  // First vertex buffer
  const vb = relOffset(data, shape.vertexGroupOffset);
  let vp = vb + 12; // name, user data entries, user data offset
  vp += 4; // buffer object
  vp += 4; // location flag
  const attributesBufferLength = u32At(data, vp);
  vp += 4;
  const attributesBufferOffset = relOffset(data, vp);
  vp += 4;
  vp += 4; // location address
  vp += 4; // memory area
  const attributesBufferStride = u32At(data, vp);
  vp += 4;
  const componentEntries = u32At(data, vp);
  vp += 4;
  const componentOffset = relOffset(data, vp);

  const formats: AttributeFormat[] = [];
  for (let i = 0; i < componentEntries; i++) {
    const co = relOffset(data, componentOffset + i * 4);
    let cp = co;
    u32At(data, cp); // flags
    cp += 4;
    const attribute = u32At(data, cp);
    cp += 4;
    cp += 4; // interleaved
    cp += 4; // buffer object
    cp += 4; // location flag
    cp += 4; // stream length
    cp += 4; // stream offset
    cp += 4; // location address
    cp += 4; // memory area
    const type = u32At(data, cp) & 0xf;
    cp += 4;
    const length = u32At(data, cp);
    cp += 4;
    const scale = readFloat(data, cp);
    cp += 4;
    const offset = u32At(data, cp);
    formats.push({ attribute, type, length, scale, offset });
  }

  const hasColor = formats.some((f) => f.attribute === 3);
  const hasUv = formats.some((f) => f.attribute === 4);
  const vertices: [number, number, number][] = [];
  const vertexColors: [number, number, number, number][] = [];
  const uvs: [number, number][] = [];
  const boneIndices: number[] = [];
  const faces: CgfxFace[] = [];

  for (let fi = 0; fi < shape.facesGroupEntries; fi++) {
    const fo = relOffset(data, shape.facesGroupOffset + fi * 4);
    let fp = fo;
    const nodeListEntries = u32At(data, fp);
    fp += 4;
    const nodeListOffset = relOffset(data, fp);
    fp += 4;
    const skinningMode = u32At(data, fp);
    fp += 4;
    fp += 4; // face main header entries
    const faceMainHeaderOffset = relOffset(data, fp);
    void skinningMode;

    // Bone node list
    const nodeList: number[] = [];
    if (nodeListEntries > 0) {
      let np = nodeListOffset;
      for (let i = 0; i < nodeListEntries; i++) {
        nodeList.push(u32At(data, np));
        np += 4;
      }
    }

    // First face descriptor
    const fd0 = relOffset(data, faceMainHeaderOffset);
    const faceDescriptorOffset = relOffset(data, fd0 + 4);

    const firstFaceEntry = relOffset(data, faceDescriptorOffset);
    const fe0 = firstFaceEntry;
    const idxBufferFormat = (u32At(data, fe0) & 2) >> 1;
    const primitive = u32At(data, fe0 + 4);
    // `fe0 + 8` is the index buffer's size in BYTES, not its element count.
    // For 8-bit indices the two coincide, which is why 16-bit buffers were the
    // only ones that used to run off the end of the buffer into neighbouring
    // sections (yielding garbage indices → non-finite vertex positions).
    const idxByteLength = Math.min(u32At(data, fe0 + 8), 0x40000);
    const idxSize = idxBufferFormat === 0 ? 1 : 2;
    const idxCount = Math.floor(idxByteLength / idxSize);
    const idxBufferOffset = relOffset(data, fe0 + 12);
    if (idxCount === 0) continue;

    // Vertices addressable by the attribute buffer. Indices beyond this would
    // read unrelated bytes, so they are dropped rather than decoded as noise.
    const vertexCapacity =
      attributesBufferStride > 0 ? Math.floor(attributesBufferLength / attributesBufferStride) : 0;

    const base = vertices.length;
    let ip = idxBufferOffset;
    for (let i = 0; i < idxCount; i++) {
      let index: number;
      if (idxBufferFormat === 0) {
        index = data[ip]!;
        ip += 1;
      } else {
        index = data[ip]! | (data[ip + 1]! << 8);
        ip += 2;
      }
      if (vertexCapacity > 0 && index >= vertexCapacity) {
        vertices.push([0, 0, 0]);
        boneIndices.push(-1);
        if (hasColor) vertexColors.push([1, 1, 1, 1]);
        if (hasUv) uvs.push([0, 0]);
        continue;
      }
      const vBase = attributesBufferOffset + index * attributesBufferStride;
      let pos: [number, number, number] = [0, 0, 0];
      let color: [number, number, number, number] = [1, 1, 1, 1];
      let uv: [number, number] = [0, 0];
      let boneIndex = -1;
      for (const f of formats) {
        const val = readVector(data, vBase + f.offset, f);
        if (f.attribute === 0) {
          pos = [
            val[0]! * f.scale + shape.positionOffset[0],
            val[1]! * f.scale + shape.positionOffset[1],
            val[2]! * f.scale + shape.positionOffset[2],
          ];
        } else if (f.attribute === 3 && hasColor) {
          color = [
            clamp01(val[0]! * f.scale),
            clamp01(val[1]! * f.scale),
            clamp01(val[2]! * f.scale),
            clamp01(val[3]! * f.scale),
          ];
        } else if (f.attribute === 4 && hasUv) {
          // PICA200 (and this format family) has V=0 at the texture's top,
          // OpenGL/canvas convention has V=0 at the bottom — flip here once
          // rather than in every consumer.
          uv = [val[0]! * f.scale, 1 - val[1]! * f.scale];
        } else if (f.attribute === 7 && nodeList.length > 0) {
          const b0 = Math.floor(val[0]!);
          if (b0 >= 0 && b0 < nodeList.length) boneIndex = nodeList[b0]!;
        }
      }
      // Skinning: transform the vertex by its bone's accumulated matrix.
      // (Exact for rigid skinning; a first-bone approximation for smooth.)
      // `nodeList` entries are read straight off disk — bounds-check before
      // recording for a glTF skin too (not just before transforming), same
      // fix as bch.ts's readMesh.
      let bone = boneIndex >= 0 ? boneIndex : nodeList.length > 0 ? nodeList[0]! : -1;
      if (bone >= 0 && bone < skeletonTransforms.length) {
        pos = matApply(skeletonTransforms[bone]!, pos);
      } else {
        bone = -1;
      }
      // Last-resort guard: a non-finite coordinate would serialise to JSON
      // `null` and poison the viewer's bounding-box fit for the whole model.
      if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1]) || !Number.isFinite(pos[2])) {
        pos = [0, 0, 0];
      }
      vertices.push(pos);
      boneIndices.push(bone);
      if (hasColor) vertexColors.push(color);
      if (hasUv) uvs.push(uv);
    }

    for (const face of buildFaces(idxCount, primitive)) {
      faces.push({ verts: face.verts.map((v) => base + v) });
    }
  }

  const hasSkinning = boneIndices.some((b) => b >= 0);
  return { vertices, vertexColors, uvs, faces, ...(hasSkinning ? { boneIndices } : {}) };
}

function readVector(
  data: Uint8Array,
  off: number,
  format: AttributeFormat,
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  const n = Math.min(format.length, 4);
  for (let i = 0; i < n; i++) {
    switch (format.type) {
      case 0:
        out[i] = (data[off + i]! << 24) >> 24; // signed byte
        break;
      case 1:
        out[i] = data[off + i]!;
        break;
      case 2: {
        const v = data[off + i * 2]! | (data[off + i * 2 + 1]! << 8);
        out[i] = (v << 16) >> 16; // signed short
        break;
      }
      case 6:
        out[i] = readFloat(data, off + i * 4);
        break;
      default:
        out[i] = 0;
    }
  }
  return out;
}

function buildFaces(vertexCount: number, primitive: number): CgfxFace[] {
  const faces: CgfxFace[] = [];
  if (primitive === PRIMITIVE_TRIANGLES || primitive === 0) {
    for (let i = 0; i + 2 < vertexCount; i += 3) faces.push({ verts: [i, i + 1, i + 2] });
  } else if (primitive === PRIMITIVE_TRIANGLE_STRIP) {
    for (let i = 0; i + 2 < vertexCount; i++) {
      faces.push({ verts: i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2] });
    }
  } else if (primitive === PRIMITIVE_TRIANGLE_FAN) {
    for (let i = 1; i + 1 < vertexCount; i++) faces.push({ verts: [0, i, i + 1] });
  } else {
    // Unknown primitive marker — treat the index buffer as a triangle list.
    for (let i = 0; i + 2 < vertexCount; i += 3) faces.push({ verts: [i, i + 1, i + 2] });
  }
  return faces;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Skeletal animations (CANM chunks) — CGFX's own segment-type numbering
// differs from BCH's (verified against Ohana3DS-Rebirth's `cgfxSegmentType`
// enum in `Models/CGFX.cs`, distinct from `RenderBase.OSegmentType` that
// `bch.ts` uses): transform = 5, transformQuaternion = 8 here (vs 4 and 7 in
// BCH). The byte layouts also differ in several details (relative offsets
// throughout, a different `getAnimationKeyFrame` header, an extra 4-byte
// padding word after each transformQuaternion dense-array entry) — ported
// separately from CGFX.cs rather than reusing bch.ts's readers.
// ---------------------------------------------------------------------------

const CGFX_SEGMENT_TRANSFORM = 5;
const CGFX_SEGMENT_TRANSFORM_QUATERNION = 8;

/**
 * Decode one CGFX `getAnimationKeyFrame` group. Unlike BCH's version, the
 * interpolation-mode/quantization bit layout differs (`segmentFlags & 0xf`
 * for interpolation, `segmentFlags >> 5` for quantization, vs BCH's
 * `& 0xf`/`(>> 8) & 0xff`), scale/offset fields are only present for some
 * quantizations, and the frame offset comes from a `startFrame` value baked
 * into the group header rather than a separate field. Only `frame`/`value`
 * are kept — Hermite slopes are parsed to keep the cursor aligned but
 * discarded, same scope cut as bch.ts's animation resampling.
 */
function readCgfxAxisKeyFrameGroup(data: Uint8Array, groupOffset: number): CgfxAnimAxis {
  const startFrame = readFloat(data, groupOffset + 0x18);
  const segmentFlags = u32At(data, groupOffset + 0x20);
  const quantization = segmentFlags >>> 5;
  const entries = Math.min(u32At(data, groupOffset + 0x24), 0x4000);
  // valueScale/valueOffset/frameScale default to identity for the three
  // quantizations that already store final float values directly.
  let valueScale = 1;
  let valueOffset = 0;
  let frameScale = 1;
  let p = groupOffset + 0x2c;
  const hasExplicitScale = quantization !== 0 && quantization !== 3 && quantization !== 6;
  if (hasExplicitScale) {
    valueScale = readFloat(data, p);
    valueOffset = readFloat(data, p + 4);
    frameScale = readFloat(data, p + 8);
    p += 12;
  }

  const keys: { frame: number; value: number }[] = [];
  for (let k = 0; k < entries; k++) {
    if (p >= data.length) break;
    let frame = 0;
    let value = 0;
    switch (quantization) {
      case 0: // hermite128: f32 frame, f32 value, f32 inSlope, f32 outSlope
        frame = readFloat(data, p);
        value = readFloat(data, p + 4);
        p += 16;
        break;
      case 1: { // hermite64: u32(frame:12 | value:20), i16 inSlope, i16 outSlope
        const packed = u32At(data, p);
        frame = packed & 0xfff;
        value = packed >>> 12;
        p += 8;
        break;
      }
      case 2: // hermite48: u8 frame, u16 value, 3 packed slope bytes
        frame = data[p]!;
        value = data[p + 1]! | (data[p + 2]! << 8);
        p += 6;
        break;
      case 3: // unifiedHermite96: f32 frame, f32 value, f32 slope (shared in/out)
        frame = readFloat(data, p);
        value = readFloat(data, p + 4);
        p += 12;
        break;
      case 4: // unifiedHermite48: u16 frame/32, u16 value, i16 slope
        frame = (data[p]! | (data[p + 1]! << 8)) / 32;
        value = data[p + 2]! | (data[p + 3]! << 8);
        p += 6;
        break;
      case 5: // unifiedHermite32: u8 frame, u16+u8 packed value/slope
        frame = data[p]!;
        value = (data[p + 1]! | (data[p + 2]! << 8)) & 0xfff;
        p += 4;
        break;
      case 6: // stepLinear64: f32 frame, f32 value
        frame = readFloat(data, p);
        value = readFloat(data, p + 4);
        p += 8;
        break;
      case 7: { // stepLinear32: u32(frame:12 | value:20)
        const packed = u32At(data, p);
        frame = packed & 0xfff;
        value = packed >>> 12;
        p += 4;
        break;
      }
      default:
        return { keys };
    }
    keys.push({ frame: frame * frameScale + startFrame, value: value * valueScale + valueOffset });
  }
  return { keys };
}

/**
 * 'transform' segment: 6 independent axis tracks, same rotationX/Y/Z then
 * translationX/Y/Z bit-mask structure as bch.ts's version, but CGFX shifts
 * *both* masks (not just `constantMask`) after each 3-axis group and skips
 * an extra 4-byte word there too — ported from CGFX.cs's loop directly
 * rather than re-derived, to avoid a transcription error in the bit/byte
 * positions.
 */
function readCgfxTransformSegment(
  data: Uint8Array,
  start: number,
  flags: number,
): { rotation: [CgfxAnimAxis | undefined, CgfxAnimAxis | undefined, CgfxAnimAxis | undefined]; translation: [CgfxAnimAxis | undefined, CgfxAnimAxis | undefined, CgfxAnimAxis | undefined] } {
  let p = start;
  let notExistMask = 0x80000;
  let constantMask = 0x200;
  const rotation: (CgfxAnimAxis | undefined)[] = [];
  const translation: (CgfxAnimAxis | undefined)[] = [];
  for (let j = 0; j < 2; j++) {
    for (let axis = 0; axis < 3; axis++) {
      const notExist = (flags & notExistMask) !== 0;
      const constant = (flags & constantMask) !== 0;
      let track: CgfxAnimAxis | undefined;
      if (!notExist) {
        track = constant
          ? { constant: readFloat(data, p) }
          : readCgfxAxisKeyFrameGroup(data, relOffset(data, p));
      }
      p += 4;
      (j === 0 ? rotation : translation).push(track);
      notExistMask <<= 1;
      constantMask <<= 1;
    }
    notExistMask <<= 1;
    constantMask <<= 1;
    p += 4;
  }
  return {
    rotation: [rotation[0], rotation[1], rotation[2]],
    translation: [translation[0], translation[1], translation[2]],
  };
}

/**
 * One transformQuaternion channel. Unlike BCH's dense array (packed floats,
 * no gaps), CGFX writes an extra 4-byte padding word after every entry
 * (`input.ReadUInt32()` following each Vector in `CGFX.cs`) — frame numbers
 * are implicit (`startFrame + index`), same as BCH.
 */
function readCgfxQuatChannel(data: Uint8Array, off: number, componentCount: 3 | 4): CgfxAnimVec4 {
  const startFrame = readFloat(data, off);
  const endFrame = readFloat(data, off + 4);
  const constantFlags = u32At(data, off + 12);
  const read4 = (o: number): [number, number, number, number] => [
    readFloat(data, o),
    readFloat(data, o + 4),
    componentCount >= 3 ? readFloat(data, o + 8) : 0,
    componentCount >= 4 ? readFloat(data, o + 12) : 0,
  ];
  if ((constantFlags & 1) !== 0) return { constant: read4(off + 16) };

  const entries = Math.max(0, Math.min(Math.round(endFrame - startFrame), 0x4000));
  const stride = (componentCount >= 4 ? 16 : 12) + 4; // + the padding word
  const keys: { frame: number; value: [number, number, number, number] }[] = [];
  for (let j = 0; j < entries; j++) {
    const vo = off + 16 + j * stride;
    if (vo >= data.length) break;
    keys.push({ frame: startFrame + j, value: read4(vo) });
  }
  return { keys };
}

function readCgfxTransformQuaternionSegment(
  data: Uint8Array,
  p: number,
  flags: number,
): { scaleQuat?: CgfxAnimVec4; rotationQuat?: CgfxAnimVec4; translationQuat?: CgfxAnimVec4 } {
  const rotationOffset = relOffset(data, p);
  const translationOffset = relOffset(data, p + 4);
  const scaleOffset = relOffset(data, p + 8);
  const scaleQuat = (flags & 0x20) === 0 && scaleOffset ? readCgfxQuatChannel(data, scaleOffset, 3) : undefined;
  const rotationQuat =
    (flags & 0x10) === 0 && rotationOffset ? readCgfxQuatChannel(data, rotationOffset, 4) : undefined;
  const translationQuat =
    (flags & 8) === 0 && translationOffset ? readCgfxQuatChannel(data, translationOffset, 3) : undefined;
  return { scaleQuat, rotationQuat, translationQuat };
}

/** Read the DATA header's `skeletalAnimations` dict (offset `dataStart + 72`, see `parseCgfx`). */
function readCgfxSkeletalAnimations(data: Uint8Array, dataStart: number): CgfxSkeletalAnimation[] {
  const dict = readDictRef(data, dataStart + 72);
  const animations: CgfxSkeletalAnimation[] = [];
  for (const entry of dict) {
    try {
      let p = entry.offset;
      p += 4; // magic "CANM"
      const revision = u32At(data, p);
      p += 4;
      const name = readCString(data, relOffset(data, p));
      p += 4;
      p += 4; // targetAnimationGroupName offset, discard
      const loopMode = u32At(data, p);
      p += 4;
      const frameSize = readFloat(data, p);
      p += 4;
      const boneDict = readDictRef(data, p);

      const bones: CgfxAnimBoneTrack[] = [];
      for (const boneEntry of boneDict) {
        let bp = boneEntry.offset;
        const boneFlags = u32At(data, bp);
        bp += 4;
        bp += 4; // bonePath offset field
        if (revision >>> 24 < 7) bp += 8; // legacy revisions carry 8 extra bytes here
        const segmentType = u32At(data, bp);
        bp += 4;
        if (segmentType === CGFX_SEGMENT_TRANSFORM) {
          const { rotation, translation } = readCgfxTransformSegment(data, bp + 0xc, boneFlags);
          bones.push({ boneName: boneEntry.name, rotation, translation });
        } else if (segmentType === CGFX_SEGMENT_TRANSFORM_QUATERNION) {
          const seg = readCgfxTransformQuaternionSegment(data, bp, boneFlags);
          bones.push({ boneName: boneEntry.name, ...seg });
        }
      }
      animations.push({ name, loopMode, frameSize, bones });
    } catch (e) {
      console.warn(`  ✗ CGFX skeletal animation: ${(e as Error).message}`);
    }
  }
  return animations;
}

export type CgfxSampledJointAnimation = CtrSampledJointAnimation;
export type CgfxSampledAnimation = CtrSampledAnimation;

/**
 * Resample a `CgfxSkeletalAnimation` onto a uniform 30fps-assumed time grid.
 *
 * The body is `sampleCtrSkeletalAnimation`, shared with
 * `sampleBchSkeletalAnimation`: the two used to be byte-identical apart from
 * five type-name lines, which is also why this one carries the longer name
 * (both files originally called it `sampleSkeletalAnimation` and collided at
 * the barrel). See `ctr-anim.ts` for the rationale, and `mat4-ctr.ts` for
 * the sibling extraction this follows.
 */
export function sampleCgfxSkeletalAnimation(
  animation: CgfxSkeletalAnimation,
  bindBones: CgfxBone[],
  fps = 30,
  maxSamples = 120,
): CgfxSampledAnimation {
  return sampleCtrSkeletalAnimation(animation, bindBones, fps, maxSamples);
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

/** Parse a CGFX buffer. Throws on a bad magic. */
export function parseCgfx(data: Uint8Array): Cgfx {
  if (
    data.length < 4 ||
    data[0] !== 0x43 ||
    data[1] !== 0x47 ||
    data[2] !== 0x46 ||
    data[3] !== 0x58
  ) {
    throw new Error('Not a CGFX file');
  }
  const headerLength = u16At(data, 6);
  const dataStart = headerLength + 8;
  if (
    String.fromCharCode(
      data[headerLength],
      data[headerLength + 1],
      data[headerLength + 2],
      data[headerLength + 3],
    ) !== 'DATA'
  ) {
    throw new Error('CGFX has no DATA chunk');
  }

  // DATA header dict order (verified against Ohana3DS-Rebirth's `CGFX.cs`):
  // models, textures, lookUpTables, materials, shaders, cameras, lights,
  // fogs, scenes, skeletalAnimations, ... — each of these globals is unused
  // here (every model reads its own materials/skeleton from its own chunk,
  // see `readModel`), kept only so the offsets/labels stay correct should a
  // future pass need one (e.g. `skeletalAnimations` at `dataStart + 72` for
  // CGFX's embedded animation format — very sparse in practice, 2/200
  // sampled Awakening files had any).
  const models = readDictRef(data, dataStart);
  const textures = readDictRef(data, dataStart + 8);
  readDictRef(data, dataStart + 16); // lookUpTables
  readDictRef(data, dataStart + 24); // materials (global, unused)
  readDictRef(data, dataStart + 32); // shaders
  readDictRef(data, dataStart + 40); // cameras
  readDictRef(data, dataStart + 48); // lights
  readDictRef(data, dataStart + 56); // fogs
  readDictRef(data, dataStart + 64); // scenes

  const cgfxTextures = readTextures(data, textures);
  const knownTextureNames = new Set(cgfxTextures.map((t) => t.name));
  const modelList: CgfxModel[] = [];
  for (const m of models) {
    const model = readModel(data, m, knownTextureNames);
    if (model.shapeGeometry.length === 0) continue;

    const meshes: CgfxMesh[] = [];
    for (let s = 0; s < model.shapes.length; s++) {
      const geo = model.shapeGeometry[s]!;
      if (geo.vertices.length === 0) continue;
      meshes.push({
        name: model.shapes[s]!.name,
        vertices: geo.vertices,
        faces: geo.faces,
        materialId: model.shapeMaterialIds[s] ?? 0,
        ...(geo.vertexColors.length > 0 ? { vertexColors: geo.vertexColors } : {}),
        ...(geo.uvs.length > 0 ? { uvs: geo.uvs } : {}),
        ...(geo.boneIndices ? { boneIndices: geo.boneIndices } : {}),
      });
    }
    modelList.push({
      name: model.name,
      materials: model.materials,
      meshes,
      bones: model.bones,
      bindMatrices: model.bindMatrices,
    });
  }

  const skeletalAnimations = readCgfxSkeletalAnimations(data, dataStart);
  return { models: modelList, textures: cgfxTextures, skeletalAnimations };
}
