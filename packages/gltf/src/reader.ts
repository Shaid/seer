/**
 * GLB (binary glTF 2.0) reader — the read direction to pair with
 * `builder.ts`'s write-only helpers, needed so a modder's edited (or
 * freshly authored) `.glb` can be turned back into a game's native format.
 *
 * Scope is deliberately narrower than the full glTF 2.0 spec — just what a
 * skinned-mesh importer needs: the two-chunk GLB container, accessors
 * (including `normalized` denormalization), buffer views (including
 * interleaved `byteStride`), node TRS (`matrix` decomposed when present),
 * skins, and primitives. No sparse-accessor support (`builder.ts` never
 * emits one).
 *
 * Browser-safe: `parseGLB`'s JSON-chunk decode uses `TextDecoder` rather
 * than Node's `Buffer`. Embedded-PNG image decoding (`readImage`,
 * `readBaseColorImage`) needs `pngjs` and lives in `./node.js` instead.
 */

import {
  GLB_MAGIC,
  GLB_VERSION,
  GLB_HEADER_BYTES,
  GLB_CHUNK_HEADER_BYTES,
  GLB_CHUNK_JSON,
  GLB_CHUNK_BIN,
} from './glb-container.js';

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface GltfAccessorJson {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
  min?: number[];
  max?: number[];
  /** Not supported — `readAccessor` throws if this is present rather than silently returning the un-patched base data. */
  sparse?: unknown;
}

export interface GltfBufferViewJson {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

export interface GltfNodeJson {
  name?: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
  mesh?: number;
  skin?: number;
}

export interface GltfPrimitiveJson {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  /** glTF primitive render mode. Defaults to `4` (TRIANGLES) per spec when absent. `readPrimitive` only supports `4` — see its doc comment. */
  mode?: number;
}

export interface GltfMeshJson {
  name?: string;
  primitives: GltfPrimitiveJson[];
}

export interface GltfSkinJson {
  joints: number[];
  inverseBindMatrices?: number;
}

export interface GltfMaterialJson {
  name?: string;
  pbrMetallicRoughness?: { baseColorTexture?: { index: number } };
  normalTexture?: { index: number };
  occlusionTexture?: { index: number };
  doubleSided?: boolean;
  alphaMode?: string;
}

export interface GltfImageJson {
  name?: string;
  bufferView?: number;
  mimeType?: string;
  uri?: string;
}

export interface GltfTextureJson {
  source?: number;
  sampler?: number;
}

export interface GltfJsonIn {
  asset?: { version: string };
  scene?: number;
  scenes?: { nodes: number[]; extras?: unknown }[];
  nodes: GltfNodeJson[];
  meshes: GltfMeshJson[];
  accessors: GltfAccessorJson[];
  bufferViews: GltfBufferViewJson[];
  buffers: { byteLength: number; uri?: string }[];
  skins?: GltfSkinJson[];
  materials?: GltfMaterialJson[];
  images?: GltfImageJson[];
  textures?: GltfTextureJson[];
  /** Skeletal animations. */
  animations?: GltfAnimationJson[];
  /** Extension names the file requires a consumer to understand to load correctly (e.g. mesh compression). `parseGLB` throws if this names anything outside `SUPPORTED_EXTENSIONS` (currently none — see that constant's doc comment). */
  extensionsRequired?: string[];
  extensionsUsed?: string[];
}

export interface GltfAnimationJson {
  name?: string;
  channels: { sampler: number; target: { node?: number; path: 'translation' | 'rotation' | 'scale' | 'weights' } }[];
  samplers: { input: number; output: number; interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE' }[];
}

export interface GlbFile {
  json: GltfJsonIn;
  /** The BIN chunk, or an empty buffer if the GLB carried none. */
  bin: Uint8Array;
  /**
   * For a separate `.gltf` + external files (not a GLB): resolves a `uri`
   * (a relative path, as written in the JSON) to its bytes. Only consulted
   * by `readImage` for `uri`-referenced images; `data:` URIs are decoded
   * inline without it. A caller loading a `.gltf` off disk passes
   * `(uri) => readFileSync(join(dir, uri))`.
   */
  resolveUri?: (uri: string) => Uint8Array;
}


/** Extension names this reader can actually decode. A GLB whose `extensionsRequired` names anything else is refused up front, rather than silently decoding to all-zero/wrong data (e.g. a Draco- or meshopt-compressed accessor has no `bufferView` at all, which would otherwise silently read back as zeros — see `readAccessor`'s `sparse`/no-`bufferView` handling). */
const SUPPORTED_EXTENSIONS = new Set<string>();

/** Parse a GLB container's two chunks (JSON + optional BIN). Throws on a non-GLB, wrong-version, truncated, or malformed-JSON file, or one that requires an unsupported extension. */
export function parseGLB(input: Uint8Array | ArrayBuffer): GlbFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < GLB_HEADER_BYTES || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('parseGLB: not a GLB container (bad magic)');
  }
  const version = view.getUint32(4, true);
  if (version !== GLB_VERSION) throw new Error(`parseGLB: unsupported GLB version ${version} (only 2 is supported)`);
  const totalLength = view.getUint32(8, true);
  if (totalLength > bytes.length) {
    throw new Error(`parseGLB: header declares ${totalLength} bytes but the input is only ${bytes.length} (truncated file)`);
  }
  let p = GLB_HEADER_BYTES;
  let json: GltfJsonIn | null = null;
  let bin = new Uint8Array(0);
  const decoder = new TextDecoder('utf-8');
  while (p + GLB_CHUNK_HEADER_BYTES <= totalLength) {
    const chunkLength = view.getUint32(p, true);
    const chunkType = view.getUint32(p + 4, true);
    const chunkStart = p + GLB_CHUNK_HEADER_BYTES;
    if (chunkStart + chunkLength > totalLength) {
      throw new Error(`parseGLB: chunk at offset ${p} overruns the declared file length (truncated or corrupt file)`);
    }
    if (chunkType === GLB_CHUNK_JSON) {
      const text = decoder.decode(bytes.subarray(chunkStart, chunkStart + chunkLength));
      try {
        json = JSON.parse(text) as GltfJsonIn;
      } catch (err) {
        throw new Error(`parseGLB: JSON chunk is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
      }
    } else if (chunkType === GLB_CHUNK_BIN) {
      bin = bytes.slice(chunkStart, chunkStart + chunkLength);
    }
    p = chunkStart + chunkLength;
  }
  if (!json) throw new Error('parseGLB: no JSON chunk found');
  const required = json.extensionsRequired?.filter((name) => !SUPPORTED_EXTENSIONS.has(name));
  if (required && required.length > 0) {
    throw new Error(`parseGLB: file requires unsupported extension(s): ${required.join(', ')} (only the base glTF 2.0 container/accessor/skin/primitive spec is supported — no mesh compression)`);
  }
  // The glTF spec makes every one of these top-level arrays optional (e.g. an empty scene has no
  // `nodes`); normalize them here so the rest of the reader can rely on them always being arrays.
  json.nodes ??= [];
  json.meshes ??= [];
  json.accessors ??= [];
  json.bufferViews ??= [];
  json.buffers ??= [];
  return { json, bin };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

const COMPONENTS_PER_TYPE: Record<GltfAccessorJson['type'], number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

/** glTF componentType constants (`builder.ts` only exports the subset it writes). */
export const BYTE = 5120;
export const UNSIGNED_BYTE = 5121;
export const SHORT = 5122;
export const UNSIGNED_SHORT = 5123;
export const UNSIGNED_INT = 5125;
export const FLOAT = 5126;

function componentByteSize(componentType: number): number {
  switch (componentType) {
    case BYTE: case UNSIGNED_BYTE: return 1;
    case SHORT: case UNSIGNED_SHORT: return 2;
    case UNSIGNED_INT: case FLOAT: return 4;
    default: throw new Error(`gltf-reader: unsupported accessor componentType ${componentType}`);
  }
}

/** Read one raw (not normalized) component value at a byte offset. */
function readComponent(view: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case BYTE: return view.getInt8(offset);
    case UNSIGNED_BYTE: return view.getUint8(offset);
    case SHORT: return view.getInt16(offset, true);
    case UNSIGNED_SHORT: return view.getUint16(offset, true);
    case UNSIGNED_INT: return view.getUint32(offset, true);
    case FLOAT: return view.getFloat32(offset, true);
    default: throw new Error(`gltf-reader: unsupported accessor componentType ${componentType}`);
  }
}

/** glTF spec 3.6.2.2 normalized-integer denormalization. */
function denormalize(raw: number, componentType: number): number {
  switch (componentType) {
    case BYTE: return Math.max(raw / 127, -1);
    case UNSIGNED_BYTE: return raw / 255;
    case SHORT: return Math.max(raw / 32767, -1);
    case UNSIGNED_SHORT: return raw / 65535;
    default: return raw;
  }
}

export interface AccessorData {
  componentsPerElement: number;
  count: number;
  /** Flattened `count * componentsPerElement` values, denormalized to float when `accessor.normalized` is set. */
  values: Float64Array;
}

/**
 * Decode accessor `accessorIndex` fully — every element's every component,
 * respecting `byteStride` for interleaved buffer views and `normalized` for
 * integer-backed attributes (e.g. a `normalized` UNSIGNED_BYTE `WEIGHTS_0`,
 * which no writer in this codebase emits but a real external glTF might).
 * No sparse-accessor support — see this file's header doc; throws rather
 * than silently returning the un-patched base data if `accessor.sparse` is
 * present. Also throws (rather than reading past the end into whatever
 * bytes happen to follow) if the accessor's declared `count`/`byteStride`
 * would read outside its own bufferView, and requires `bufferView.buffer`
 * to be `0` (this reader only ever populates one BIN chunk into `glb.bin`).
 */
export function readAccessor(glb: GlbFile, accessorIndex: number): AccessorData {
  const accessor = glb.json.accessors[accessorIndex];
  if (!accessor) throw new Error(`gltf-reader: no accessor ${accessorIndex}`);
  if (accessor.sparse !== undefined) throw new Error(`gltf-reader: accessor ${accessorIndex} is a sparse accessor, which is not supported`);
  const componentsPerElement = COMPONENTS_PER_TYPE[accessor.type];
  if (componentsPerElement === undefined) throw new Error(`gltf-reader: accessor ${accessorIndex} has unknown type "${accessor.type}"`);
  const count = accessor.count;
  if (!Number.isInteger(count) || count < 0) throw new Error(`gltf-reader: accessor ${accessorIndex} has invalid count ${count}`);
  const values = new Float64Array(count * componentsPerElement);
  if (accessor.bufferView === undefined) return { componentsPerElement, count, values }; // all-zero (no-data accessor, e.g. an unused morph target)
  const bv = glb.json.bufferViews[accessor.bufferView];
  if (!bv) throw new Error(`gltf-reader: accessor ${accessorIndex} references missing bufferView ${accessor.bufferView}`);
  if (bv.buffer !== 0) throw new Error(`gltf-reader: accessor ${accessorIndex}'s bufferView references buffer ${bv.buffer}, but only buffer 0 (the GLB's single BIN chunk) is supported`);
  const compSize = componentByteSize(accessor.componentType);
  const tightStride = componentsPerElement * compSize;
  if (bv.byteStride !== undefined && bv.byteStride < tightStride) {
    throw new Error(`gltf-reader: accessor ${accessorIndex}'s bufferView byteStride (${bv.byteStride}) is smaller than its tight element size (${tightStride})`);
  }
  const stride = bv.byteStride ?? tightStride;
  const accessorByteOffset = accessor.byteOffset ?? 0;
  const bvByteOffset = bv.byteOffset ?? 0;
  const base = bvByteOffset + accessorByteOffset;
  const neededWithinView = count > 0 ? accessorByteOffset + (count - 1) * stride + tightStride : 0;
  if (neededWithinView > bv.byteLength) {
    throw new Error(`gltf-reader: accessor ${accessorIndex} (count ${count}, byteOffset ${accessorByteOffset}) needs ${neededWithinView} bytes but its bufferView ${accessor.bufferView} is only ${bv.byteLength} bytes`);
  }
  if (bvByteOffset + bv.byteLength > glb.bin.byteLength) {
    throw new Error(`gltf-reader: bufferView ${accessor.bufferView} (offset ${bvByteOffset}, length ${bv.byteLength}) extends past the end of the BIN chunk (${glb.bin.byteLength} bytes) — truncated or corrupt file`);
  }
  const view = new DataView(glb.bin.buffer, glb.bin.byteOffset + base, glb.bin.byteLength - base);
  const normalize = accessor.normalized === true;
  for (let i = 0; i < count; i++) {
    const elemOffset = i * stride;
    for (let c = 0; c < componentsPerElement; c++) {
      const raw = readComponent(view, elemOffset + c * compSize, accessor.componentType);
      values[i * componentsPerElement + c] = normalize ? denormalize(raw, accessor.componentType) : raw;
    }
  }
  return { componentsPerElement, count, values };
}

/** Convenience wrapper for an index accessor (SCALAR, unsigned) — returns a flat triangle-index list. */
export function readIndices(glb: GlbFile, accessorIndex: number): Uint32Array {
  const { values } = readAccessor(glb, accessorIndex);
  return Uint32Array.from(values);
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface DecomposedNode {
  name?: string;
  children: number[];
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  mesh?: number;
  skin?: number;
}

/**
 * Decompose a column-major 4x4 TRS matrix (no shear) into translation/rotation/scale.
 * Handles a mirrored (negative-determinant) matrix by folding the sign into `sx`
 * (matching three.js's `Matrix4.decompose`) rather than silently discarding the
 * mirror and extracting a bogus rotation from it, and normalizes the extracted
 * quaternion (a non-uniform scale otherwise leaves it non-unit-length).
 */
function decomposeMatrix(m: number[]): { t: [number, number, number]; r: [number, number, number, number]; s: [number, number, number] } {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
  if (det < 0) sx = -sx;
  const r00 = m[0]! / (sx || 1), r01 = m[1]! / (sx || 1), r02 = m[2]! / (sx || 1);
  const r10 = m[4]! / (sy || 1), r11 = m[5]! / (sy || 1), r12 = m[6]! / (sy || 1);
  const r20 = m[8]! / (sz || 1), r21 = m[9]! / (sz || 1), r22 = m[10]! / (sz || 1);
  const trace = r00 + r11 + r22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s; qx = (r12 - r21) * s; qy = (r20 - r02) * s; qz = (r01 - r10) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    qw = (r12 - r21) / s; qx = 0.25 * s; qy = (r01 + r10) / s; qz = (r20 + r02) / s;
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    qw = (r20 - r02) / s; qx = (r01 + r10) / s; qy = 0.25 * s; qz = (r12 + r21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    qw = (r01 - r10) / s; qx = (r20 + r02) / s; qy = (r12 + r21) / s; qz = 0.25 * s;
  }
  const len = Math.hypot(qx, qy, qz, qw);
  if (len > 0) { qx /= len; qy /= len; qz /= len; qw /= len; }
  return { t: [m[12]!, m[13]!, m[14]!], r: [qx, qy, qz, qw], s: [sx, sy, sz] };
}

/** Every node, TRS-decomposed (a `matrix`-only node is decomposed; a TRS node is passed through with defaults filled in). */
export function readNodes(glb: GlbFile): DecomposedNode[] {
  return glb.json.nodes.map((n) => {
    if (n.matrix) {
      const { t, r, s } = decomposeMatrix(n.matrix);
      return { name: n.name, children: n.children ?? [], translation: t, rotation: r, scale: s, mesh: n.mesh, skin: n.skin };
    }
    return {
      name: n.name,
      children: n.children ?? [],
      translation: (n.translation as [number, number, number] | undefined) ?? [0, 0, 0],
      rotation: (n.rotation as [number, number, number, number] | undefined) ?? [0, 0, 0, 1],
      scale: (n.scale as [number, number, number] | undefined) ?? [1, 1, 1],
      mesh: n.mesh,
      skin: n.skin,
    };
  });
}

/** Parent index for every node (-1 for a node no other node lists as a child), built by scanning every `children[]` once. */
export function buildParentMap(nodes: DecomposedNode[]): Int32Array {
  const parents = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => { for (const c of n.children) parents[c] = i; });
  return parents;
}

// ---------------------------------------------------------------------------
// Skins
// ---------------------------------------------------------------------------

export interface GlbSkin {
  /** Node indices, in `JOINTS_0`-slot order. */
  joints: number[];
  /** One flattened column-major 4x4 (16 floats) per joint slot, in the same order as `joints`. Identity per-slot when the skin declares no `inverseBindMatrices` (glTF then implies identity). */
  inverseBindMatrices: Float32Array[];
}

/** Throws if the skin's `inverseBindMatrices` accessor doesn't declare `MAT4` or doesn't carry at least one matrix per joint (rather than silently truncating/returning empty matrices for the missing slots). */
export function readSkin(glb: GlbFile, skinIndex: number): GlbSkin {
  const skin = glb.json.skins?.[skinIndex];
  if (!skin) throw new Error(`gltf-reader: no skin ${skinIndex}`);
  if (skin.inverseBindMatrices === undefined) {
    return { joints: skin.joints, inverseBindMatrices: skin.joints.map(() => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) };
  }
  const ibmAccessor = glb.json.accessors[skin.inverseBindMatrices];
  if (!ibmAccessor) throw new Error(`gltf-reader: skin ${skinIndex} references missing inverseBindMatrices accessor ${skin.inverseBindMatrices}`);
  if (ibmAccessor.type !== 'MAT4') throw new Error(`gltf-reader: skin ${skinIndex}'s inverseBindMatrices accessor must be type MAT4, got ${ibmAccessor.type}`);
  if (ibmAccessor.count < skin.joints.length) {
    throw new Error(`gltf-reader: skin ${skinIndex} has ${skin.joints.length} joints but its inverseBindMatrices accessor only carries ${ibmAccessor.count} matrices`);
  }
  const { values } = readAccessor(glb, skin.inverseBindMatrices);
  const mats: Float32Array[] = [];
  for (let i = 0; i < skin.joints.length; i++) mats.push(Float32Array.from(values.subarray(i * 16, i * 16 + 16)));
  return { joints: skin.joints, inverseBindMatrices: mats };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface GlbPrimitiveData {
  /** Flat VEC3 positions, `count * 3`. */
  positions: Float32Array;
  count: number;
  normals?: Float32Array;
  uv0?: Float32Array;
  /** Flat VEC4 joint slot indices (index into the referencing node's skin's `joints[]`), `count * 4`. */
  joints?: Uint32Array;
  /** Flat VEC4 weights, `count * 4`. */
  weights?: Float32Array;
  /** Flat triangle-list vertex indices (already un-strided — glTF primitive `mode` is assumed TRIANGLES, the only mode `builder.ts` emits). */
  indices: Uint32Array;
  material?: number;
}

/** glTF primitive `mode` constant for a triangle list — the only mode this reader supports. */
const TRIANGLES = 4;

/**
 * Reads one primitive's attributes/indices. Throws for any `mode` other
 * than `TRIANGLES` (the glTF default when `mode` is absent) rather than
 * silently reinterpreting a `LINES`/`POINTS`/triangle-strip-or-fan
 * primitive's index buffer as a flat triangle list — a real DCC export
 * (e.g. Blender writes loose edges as a separate `LINES` primitive) would
 * otherwise decode to plausible-looking but wrong triangles with no error.
 * Also throws if a `TRIANGLES` primitive's index count isn't a multiple of 3.
 */
export function readPrimitive(glb: GlbFile, prim: GltfPrimitiveJson): GlbPrimitiveData {
  const mode = prim.mode ?? TRIANGLES;
  if (mode !== TRIANGLES) throw new Error(`gltf-reader: primitive mode ${mode} is not supported (only TRIANGLES/${TRIANGLES} is)`);
  const posAcc = prim.attributes.POSITION;
  if (posAcc === undefined) throw new Error('gltf-reader: primitive has no POSITION attribute');
  const pos = readAccessor(glb, posAcc);
  const count = pos.count;
  const indices = prim.indices !== undefined ? readIndices(glb, prim.indices) : Uint32Array.from({ length: count }, (_, i) => i);
  if (indices.length % 3 !== 0) throw new Error(`gltf-reader: primitive has ${indices.length} indices, not a multiple of 3 (not a valid triangle list)`);
  const out: GlbPrimitiveData = {
    positions: Float32Array.from(pos.values),
    count,
    indices,
    material: prim.material,
  };
  if (prim.attributes.NORMAL !== undefined) out.normals = Float32Array.from(readAccessor(glb, prim.attributes.NORMAL).values);
  if (prim.attributes.TEXCOORD_0 !== undefined) out.uv0 = Float32Array.from(readAccessor(glb, prim.attributes.TEXCOORD_0).values);
  if (prim.attributes.JOINTS_0 !== undefined) out.joints = Uint32Array.from(readAccessor(glb, prim.attributes.JOINTS_0).values);
  if (prim.attributes.WEIGHTS_0 !== undefined) out.weights = Float32Array.from(readAccessor(glb, prim.attributes.WEIGHTS_0).values);
  return out;
}

// ---------------------------------------------------------------------------
// Images / materials
// ---------------------------------------------------------------------------

export interface GlbImage {
  rgba: Uint8Array;
  width: number;
  height: number;
}

/** The base-colour texture index for a material, or `undefined` if it has none (or no `pbrMetallicRoughness` at all). Resolving that index to a decoded image needs `readImage` from `./node.js`. */
export function baseColorImageSource(glb: GlbFile, materialIndex: number): number | undefined {
  const mat = glb.json.materials?.[materialIndex];
  const texIndex = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (texIndex === undefined) return undefined;
  const tex = glb.json.textures?.[texIndex];
  if (!tex || tex.source === undefined) return undefined;
  return tex.source;
}
