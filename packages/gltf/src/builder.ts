/**
 * Low-level GLB (binary glTF 2.0) assembly helpers: buffer/accessor
 * bookkeeping, 4x4 matrix math for skeleton world transforms, and final
 * binary packing. Any mesh format's exporter can reuse these primitives
 * instead of reimplementing GLB chunk framing and matrix inversion.
 *
 * Browser-safe: uses `TextEncoder`/`DataView` rather than Node's `Buffer` for
 * the final GLB pack, so this module works unmodified in a bundled viewer.
 */

export type JsonNode = {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
};

export interface GltfJson {
  asset: { version: string; generator?: string };
  scene: number;
  /**
   * `extras` is additive and optional. three.js's `GLTFLoader` copies a
   * scene's `extras` verbatim into the loaded `Object3D`'s `userData` with
   * no custom extension needed — a caller can use this to bake, e.g., a
   * spring-bones config for viewers to pick up automatically.
   */
  scenes: { nodes: number[]; extras?: Record<string, unknown> }[];
  nodes: JsonNode[];
  meshes: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; material?: number }[] }[];
  /** `uri` is only set for sidecar `.gltf` output ({@link assembleGltfSidecar}); a GLB's single buffer is the BIN chunk. */
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[];
  accessors: Record<string, unknown>[];
  materials?: {
    name?: string;
    pbrMetallicRoughness?: { baseColorTexture?: { index: number }; metallicFactor?: number; roughnessFactor?: number };
    /** glTF default is `'OPAQUE'` — omit unless a material genuinely needs `'BLEND'`/`'MASK'` (see `EmbeddedTexture.hasAlpha`). */
    alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
    /** glTF default is `false` (backface-culled/single-sided). */
    doubleSided?: boolean;
    /**
     * Standard glTF texture slots, additive and optional — a caller can use
     * these to carry a tangent normal map and an AO/specular-scaler map
     * through to three.js's `GLTFLoader`, which wires them into
     * `material.normalMap`/`material.aoMap` with no custom extension.
     */
    normalTexture?: { index: number };
    occlusionTexture?: { index: number };
    /**
     * Additive and optional, same contract as {@link GltfJson.scenes}'
     * `extras` — three.js's `GLTFLoader` copies a material's `extras`
     * verbatim into the loaded `THREE.Material`'s `userData`.
     */
    extras?: Record<string, unknown>;
  }[];
  images?: { name?: string; bufferView?: number; mimeType?: 'image/png'; uri?: string }[];
  textures?: { sampler?: number; source: number }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  skins?: { joints: number[]; inverseBindMatrices: number }[];
  animations?: JsonAnimation[];
}

export type AnimationPath = 'translation' | 'rotation' | 'scale';

export interface JsonAnimationSampler {
  input: number;
  output: number;
  interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface JsonAnimationChannel {
  sampler: number;
  target: { node: number; path: AnimationPath };
}

export interface JsonAnimation {
  name?: string;
  samplers: JsonAnimationSampler[];
  channels: JsonAnimationChannel[];
}

export interface GltfBuilder {
  json: GltfJson;
  chunks: Uint8Array[];
  /** Running byte offset into the binary buffer (O(1) instead of re-scanning chunks). */
  binOffset: number;
}

// `FLOAT` is defined once, in `reader.ts` (which needs the full
// componentType set anyway) and exported from this package's barrel from
// there — importing (not re-exporting) it here avoids a duplicate-export
// collision at the `index.ts` barrel. `UNSIGNED_SHORT`/`UNSIGNED_INT` are
// likewise only exported from `reader.ts`; this module doesn't use them
// internally.
import { FLOAT } from './reader.js';
import {
  GLB_MAGIC,
  GLB_VERSION,
  GLB_HEADER_BYTES,
  GLB_CHUNK_HEADER_BYTES,
  GLB_CHUNK_JSON,
  GLB_CHUNK_BIN,
  GLB_JSON_PAD,
} from './glb-container.js';

export const ARRAY_BUFFER = 34962;
export const ELEMENT_ARRAY_BUFFER = 34963;

// glTF sampler enums are raw GL constants. Named here so `addEmbeddedTexture`'s
// default sampler reads as a choice ("bilinear, trilinear mips, repeat") rather
// than four unexplained integers.
const GL_LINEAR = 9729;
const GL_LINEAR_MIPMAP_LINEAR = 9987;
const GL_REPEAT = 10497;

export function align4(n: number): number {
  return (n + 3) & ~3;
}

export function newBuilder(materials?: { name?: string }[]): GltfBuilder {
  return {
    json: {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      buffers: [{ byteLength: 0 }],
      bufferViews: [],
      accessors: [],
      materials,
    },
    chunks: [],
    binOffset: 0,
  };
}

export interface EmbeddedTexture {
  name: string;
  png: Uint8Array;
  /**
   * Whether the source pixel data carries genuine, non-uniform alpha (some
   * pixels meaningfully transparent or partially transparent, not just
   * compression noise around a uniformly-opaque channel) — set by whichever
   * decoder built `png` from raw RGBA, since only it has the pre-encode
   * buffer cheaply at hand. A caller that assigns this image as a
   * material's baseColor can use it to pick `alphaMode: 'BLEND'` over the
   * glTF default `'OPAQUE'` (an eye/highlight overlay plane rendered fully
   * opaque shows as a solid black or white square instead of blending
   * correctly). `undefined`/`false` keeps the default `OPAQUE` behavior.
   */
  hasAlpha?: boolean;
}

/**
 * Whether a decoded RGBA8 buffer carries genuine, substantial transparency —
 * as opposed to a mostly-opaque texture with a thin soft-edge alpha fade
 * (e.g. a hairline blended into a forehead), which should stay `OPAQUE` to
 * avoid `BLEND`'s no-depth-write transparency sorting producing visible
 * compositing artifacts on a large, mostly-solid mesh. `threshold`/
 * `minFraction` default to values confirmed against a real texture corpus
 * (FE Three Houses): three genuine transparent-overlay textures measured
 * 26.9%-99.9% of pixels below alpha 50, while a thin edge fade measured only
 * 4.5% — an order of magnitude of separation, so `minFraction=0.10` sits
 * well clear of both populations rather than splitting a continuum.
 */
export function rgbaHasAlpha(rgba: Uint8Array, threshold = 50, minFraction = 0.1): boolean {
  const pixelCount = rgba.length / 4;
  if (pixelCount === 0) return false;
  let below = 0;
  for (let p = 3; p < rgba.length; p += 4) {
    if (rgba[p]! < threshold) below++;
  }
  return below / pixelCount >= minFraction;
}

/** Add one embedded PNG and return its glTF texture index. */
export function addEmbeddedTexture(builder: GltfBuilder, image: EmbeddedTexture): number {
  const view = pushBytes(builder, image.png, 0);
  const images = (builder.json.images ??= []);
  const textures = (builder.json.textures ??= []);
  const samplers = (builder.json.samplers ??= []);
  const imageIndex = images.push({ name: image.name, bufferView: view, mimeType: 'image/png' }) - 1;
  if (samplers.length === 0) {
    samplers.push({ magFilter: GL_LINEAR, minFilter: GL_LINEAR_MIPMAP_LINEAR, wrapS: GL_REPEAT, wrapT: GL_REPEAT });
  }
  return textures.push({ sampler: 0, source: imageIndex }) - 1;
}

/** Add one image referenced by `uri` (resolved relative to the `.gltf`, for sidecar output) with a sampler-less texture, returning the glTF texture index. */
export function addExternalTexture(builder: GltfBuilder, uri: string): number {
  const images = (builder.json.images ??= []);
  const textures = (builder.json.textures ??= []);
  const imageIndex = images.push({ uri }) - 1;
  return textures.push({ source: imageIndex }) - 1;
}

/** Euler XYZ (radians) -> column-major 4x4 rotation matrix. Composition order is `Rx * Ry * Rz` (Z applied first) — the opposite of Blender's own "XYZ Euler" (`Rz * Ry * Rx`); a caller porting rotation data from another engine should confirm its convention rather than assume this matches. */
export function eulerToMatrix(e: { x: number; y: number; z: number }): Float32Array {
  const cx = Math.cos(e.x), sx = Math.sin(e.x);
  const cy = Math.cos(e.y), sy = Math.sin(e.y);
  const cz = Math.cos(e.z), sz = Math.sin(e.z);
  const m = new Float32Array(16);
  m[0] = cy * cz;
  m[1] = sx * sy * cz + cx * sz;
  m[2] = -cx * sy * cz + sx * sz;
  m[4] = -cy * sz;
  m[5] = -sx * sy * sz + cx * cz;
  m[6] = cx * sy * sz + sx * cz;
  m[8] = sy;
  m[9] = -sx * cy;
  m[10] = cx * cy;
  m[15] = 1;
  return m;
}

/** Quaternion (x,y,z,w) -> column-major 4x4 rotation matrix. */
export function quatToMatrix(q: { x: number; y: number; z: number; w: number }): Float32Array {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m = new Float32Array(16);
  m[0] = 1 - (yy + zz); m[1] = xy + wz; m[2] = xz - wy;
  m[4] = xy - wz; m[5] = 1 - (xx + zz); m[6] = yz + wx;
  m[8] = xz + wy; m[9] = yz - wx; m[10] = 1 - (xx + yy);
  m[15] = 1;
  return m;
}

/**
 * Extract unit quaternion [x,y,z,w] from a column-major 4x4 rotation+translation
 * matrix (Shepperd method). Translation is ignored, but scale is NOT — a
 * non-uniformly-scaled input (e.g. a bone scaled 3x on one axis only)
 * distorts the extracted axis, only rescued back to a unit quaternion by
 * the final normalization. Callers with non-uniform scale should normalize
 * the input matrix's basis vectors to unit length first.
 */
export function quatFromMatrix(m: Float32Array): number[] {
  const trace = m[0]! + m[5]! + m[10]!;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m[6]! - m[9]!) * s;
    y = (m[8]! - m[2]!) * s;
    z = (m[1]! - m[4]!) * s;
  } else if (m[0]! > m[5]! && m[0]! > m[10]!) {
    const s = 2 * Math.sqrt(1 + m[0]! - m[5]! - m[10]!);
    w = (m[6]! - m[9]!) / s;
    x = 0.25 * s;
    y = (m[1]! + m[4]!) / s;
    z = (m[8]! + m[2]!) / s;
  } else if (m[5]! > m[10]!) {
    const s = 2 * Math.sqrt(1 + m[5]! - m[0]! - m[10]!);
    w = (m[8]! - m[2]!) / s;
    x = (m[1]! + m[4]!) / s;
    y = 0.25 * s;
    z = (m[6]! + m[9]!) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[10]! - m[0]! - m[5]!);
    w = (m[1]! - m[4]!) / s;
    x = (m[8]! + m[2]!) / s;
    y = (m[6]! + m[9]!) / s;
    z = 0.25 * s;
  }
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len > 0) { x /= len; y /= len; z /= len; w /= len; }
  return [x, y, z, w];
}

export function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Inverts a 4x4 matrix. Returns an all-zero matrix (rather than throwing or returning NaN) for a singular (zero-determinant) input — e.g. a bone scaled to 0 on some axis, a common "hide this" idiom in some game rigs. A caller computing inverse-bind matrices should treat an all-zero result as a signal that the source transform was degenerate, not as a valid inverse. */
export function mat4Inverse(m: Float32Array): Float32Array {
  const out = new Float32Array(16);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return new Float32Array(16).fill(0);
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/**
 * Append a typed array's bytes as a bufferView: `pushBytes` over the array's
 * own backing store, no copy. These used to be two line-for-line identical
 * function bodies — wrapping the typed array is the only thing that ever
 * differed between them.
 */
export function pushView(
  builder: GltfBuilder,
  typedArr: Float32Array | Uint32Array | Uint16Array,
  target: number,
): number {
  return pushBytes(builder, new Uint8Array(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength), target);
}

/** Append raw bytes as a bufferView, returning its index. `target` 0 means "omit the field" (glTF's `target` is only meaningful for vertex/index data). */
export function pushBytes(builder: GltfBuilder, bytes: Uint8Array, target = 0): number {
  const byteOffset = builder.binOffset;
  builder.binOffset += align4(bytes.length);
  const view: { buffer: number; byteOffset: number; byteLength: number; target?: number } = {
    buffer: 0,
    byteOffset,
    byteLength: bytes.length,
  };
  if (target > 0) view.target = target;
  builder.json.bufferViews.push(view);
  builder.chunks.push(bytes);
  return builder.json.bufferViews.length - 1;
}

export function pushAccessor(
  builder: GltfBuilder,
  bufferView: number,
  type: string,
  componentType: number,
  count: number,
  extra?: Record<string, unknown>,
): number {
  const accessor: Record<string, unknown> = { bufferView, type, componentType, count };
  if (extra) Object.assign(accessor, extra);
  builder.json.accessors.push(accessor);
  return builder.json.accessors.length - 1;
}

/** Create a new (empty) glTF `animations[]` entry and return its index. */
export function newAnimation(builder: GltfBuilder, name?: string): number {
  const animations = (builder.json.animations ??= []);
  const anim: JsonAnimation = { samplers: [], channels: [] };
  if (name) anim.name = name;
  return animations.push(anim) - 1;
}

/**
 * Add one animation channel (a sampler + its channel target) to an
 * existing `animations[animIndex]` entry, driving `path` (translation/
 * rotation/scale) on `nodeIndex`. `times` is in seconds; `values` is
 * flattened VEC3 (translation/scale) or VEC4 (rotation, x/y/z/w) floats,
 * `times.length` keyframes. glTF requires the sampler's `input` (time)
 * accessor to declare min/max — every other numeric accessor here doesn't.
 * Throws for zero keyframes or a `values` length that doesn't match
 * `times.length` — either would otherwise silently emit a schema-invalid
 * (zero-length) accessor or one whose declared `count` overruns the bytes
 * actually written for it, corrupting whatever bufferView happens to follow.
 */
export function addAnimationChannel(
  builder: GltfBuilder,
  animIndex: number,
  nodeIndex: number,
  path: AnimationPath,
  times: Float32Array,
  values: Float32Array,
  interpolation: 'LINEAR' | 'STEP' = 'LINEAR',
): void {
  if (times.length === 0) throw new Error('addAnimationChannel: times must have at least one keyframe');
  const componentsPerValue = path === 'rotation' ? 4 : 3;
  if (values.length !== times.length * componentsPerValue) {
    throw new Error(`addAnimationChannel: values.length (${values.length}) must equal times.length * ${componentsPerValue} (${times.length * componentsPerValue}) for path "${path}"`);
  }
  const anim = builder.json.animations![animIndex]!;
  let tmin = Infinity, tmax = -Infinity;
  for (const t of times) { if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  if (!Number.isFinite(tmin)) { tmin = 0; tmax = 0; }
  const timeView = pushView(builder, times, 0);
  const timeAccessor = pushAccessor(builder, timeView, 'SCALAR', FLOAT, times.length, { min: [tmin], max: [tmax] });
  const valueView = pushView(builder, values, 0);
  const type = path === 'rotation' ? 'VEC4' : 'VEC3';
  const valueAccessor = pushAccessor(builder, valueView, type, FLOAT, times.length);
  const samplerIndex = anim.samplers.push({ input: timeAccessor, output: valueAccessor, interpolation }) - 1;
  anim.channels.push({ sampler: samplerIndex, target: { node: nodeIndex, path } });
}

/** Stamp the buffer length and drop empty optional top-level arrays (glTF forbids zero-length ones); returns the binary length. */
function finalizeJson(builder: GltfBuilder): number {
  const total = builder.binOffset;
  builder.json.buffers[0]!.byteLength = total;
  const json = builder.json as unknown as Record<string, unknown[] | undefined>;
  for (const key of ['materials', 'meshes', 'skins', 'accessors', 'bufferViews', 'buffers', 'images', 'textures', 'samplers', 'animations'] as const) {
    if (Array.isArray(json[key]) && json[key]!.length === 0) delete json[key];
  }
  return total;
}

/**
 * Finish a builder as a separate `.gltf` + `.bin` pair instead of a GLB: the
 * returned `json` points `buffers[0].uri` at `binUri` (relative to the
 * `.gltf`), and `bin` is the 4-byte-aligned binary buffer. Image `uri`s (see
 * {@link addExternalTexture}) stay external.
 */
export function assembleGltfSidecar(builder: GltfBuilder, binUri: string): { json: GltfJson; bin: Uint8Array } {
  const total = finalizeJson(builder);
  const bin = new Uint8Array(total);
  let p = 0;
  for (const c of builder.chunks) {
    bin.set(c, p);
    p += align4(c.length);
  }
  builder.json.buffers[0]!.uri = binUri;
  return { json: builder.json, bin };
}

/**
 * Pack the accumulated JSON + binary chunks into a GLB ArrayBuffer.
 *
 * Uses `TextEncoder`/`DataView` rather than Node's `Buffer` so this module
 * has no Node dependency at all — the original this was ported from used
 * `Buffer`, which is undefined in a real browser without a polyfill.
 */
export function assembleGLB(builder: GltfBuilder): ArrayBuffer {
  if (builder.chunks.length === 0) {
    builder.json.nodes.push({ name: 'empty' });
    builder.json.scenes[0]!.nodes.push(builder.json.nodes.length - 1);
    builder.chunks.push(new Uint8Array(0));
  }

  const total = finalizeJson(builder);

  const jsonBytes = new TextEncoder().encode(JSON.stringify(builder.json));
  const jsonPaddedLen = align4(jsonBytes.length);
  const binPaddedLen = align4(total);
  const totalLen = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + jsonPaddedLen + GLB_CHUNK_HEADER_BYTES + binPaddedLen;

  const out = new ArrayBuffer(totalLen);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  let p = 0;

  // GLB header
  view.setUint32(p, GLB_MAGIC, true); p += 4;
  view.setUint32(p, GLB_VERSION, true); p += 4;
  view.setUint32(p, totalLen, true); p += 4;

  // JSON chunk header + data (space-padded)
  view.setUint32(p, jsonPaddedLen, true); p += 4;
  view.setUint32(p, GLB_CHUNK_JSON, true); p += 4;
  bytes.set(jsonBytes, p);
  bytes.fill(GLB_JSON_PAD, p + jsonBytes.length, p + jsonPaddedLen);
  p += jsonPaddedLen;

  // Binary chunk header + data (zero-padded, which a fresh ArrayBuffer already is)
  view.setUint32(p, binPaddedLen, true); p += 4;
  view.setUint32(p, GLB_CHUNK_BIN, true); p += 4;
  for (const c of builder.chunks) {
    bytes.set(c, p);
    p += align4(c.length);
  }

  return out;
}
