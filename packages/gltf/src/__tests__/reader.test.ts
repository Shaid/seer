import { describe, it, expect } from 'vitest';
import {
  newBuilder,
  pushView,
  pushAccessor,
  assembleGLB,
  ARRAY_BUFFER,
  ELEMENT_ARRAY_BUFFER,
  quatToMatrix,
  mat4Multiply,
} from '../builder.js';
import {
  parseGLB,
  readAccessor,
  readIndices,
  readNodes,
  buildParentMap,
  readSkin,
  readPrimitive,
  baseColorImageSource,
  UNSIGNED_BYTE,
  BYTE,
  UNSIGNED_SHORT,
  FLOAT,
  type GlbFile,
} from '../reader.js';

/** Hand-assembles a raw GLB byte buffer from a JSON object + optional BIN bytes, for tests that need
 * fields `assembleGLB` never writes itself (e.g. `extensionsRequired`) or a specific malformed shape. */
function buildRawGLB(json: object, bin: Uint8Array = new Uint8Array(0)): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binPadded = (bin.length + 3) & ~3;
  const totalLen = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = new ArrayBuffer(totalLen);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLen, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded);
  const binHeaderOffset = 20 + jsonPadded;
  view.setUint32(binHeaderOffset, binPadded, true);
  view.setUint32(binHeaderOffset + 4, 0x004e4942, true);
  bytes.set(bin, binHeaderOffset + 8);
  return out;
}

describe('parseGLB', () => {
  it('throws on a bad magic number', () => {
    const bad = new Uint8Array(20);
    expect(() => parseGLB(bad)).toThrow(/bad magic/);
  });

  it('throws when there is no JSON chunk', () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true); // version
    view.setUint32(8, 12, true);
    expect(() => parseGLB(buf)).toThrow(/no JSON chunk/);
  });

  it('throws for a GLB version other than 2', () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 1, true); // version
    view.setUint32(8, 12, true);
    expect(() => parseGLB(buf)).toThrow(/unsupported GLB version/);
  });

  it('throws when the header declares more bytes than the input actually has (truncated file)', () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, 1000, true); // declares far more than the 12 bytes present
    expect(() => parseGLB(buf)).toThrow(/truncated/);
  });

  it('throws a clear error for a malformed JSON chunk instead of a bare SyntaxError', () => {
    // buildRawGLB expects a real object to JSON.stringify, so hand-build just this one buffer
    // with deliberately-invalid JSON bytes in the chunk instead.
    const jsonBytes = new TextEncoder().encode('{not valid json');
    const totalLen = 12 + 8 + jsonBytes.length;
    const buf = new ArrayBuffer(totalLen);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, totalLen, true);
    view.setUint32(12, jsonBytes.length, true);
    view.setUint32(16, 0x4e4f534a, true); // "JSON"
    bytes.set(jsonBytes, 20);
    expect(() => parseGLB(buf)).toThrow(/JSON chunk is not valid JSON/);
  });

  it('throws when extensionsRequired names an unsupported extension', () => {
    const buf = buildRawGLB({
      asset: { version: '2.0' },
      extensionsRequired: ['KHR_draco_mesh_compression'],
      nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [],
    });
    expect(() => parseGLB(buf)).toThrow(/requires unsupported extension.*KHR_draco_mesh_compression/);
  });

  it('normalizes missing optional top-level arrays to empty arrays', () => {
    const buf = buildRawGLB({ asset: { version: '2.0' } });
    const glb = parseGLB(buf);
    expect(glb.json.nodes).toEqual([]);
    expect(glb.json.meshes).toEqual([]);
    expect(glb.json.accessors).toEqual([]);
    expect(glb.json.bufferViews).toEqual([]);
    expect(glb.json.buffers).toEqual([]);
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const builder = newBuilder();
    builder.json.nodes.push({ name: 'n' });
    builder.json.scenes[0]!.nodes.push(0);
    const glbBuffer = assembleGLB(builder);
    const fromArrayBuffer = parseGLB(glbBuffer);
    const fromUint8 = parseGLB(new Uint8Array(glbBuffer));
    expect(fromArrayBuffer.json.nodes[0]?.name).toBe('n');
    expect(fromUint8.json.nodes[0]?.name).toBe('n');
  });
});

describe('readAccessor', () => {
  function glbWithRawBin(json: GlbFile['json'], bin: Uint8Array): GlbFile {
    return { json, bin };
  }

  it('reads a normalized UNSIGNED_BYTE accessor as denormalized floats', () => {
    const bin = new Uint8Array([0, 128, 255]);
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 3 }],
        accessors: [{ bufferView: 0, componentType: UNSIGNED_BYTE, normalized: true, count: 3, type: 'SCALAR' }],
        buffers: [{ byteLength: 3 }],
      },
      bin,
    );
    const { values } = readAccessor(glb, 0);
    expect(values[0]).toBeCloseTo(0);
    expect(values[1]).toBeCloseTo(128 / 255);
    expect(values[2]).toBeCloseTo(1);
  });

  it('reads a normalized SHORT/BYTE accessor clamped at -1', () => {
    const bin = new Int8Array([-128, 127]);
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 }],
        accessors: [{ bufferView: 0, componentType: BYTE, normalized: true, count: 2, type: 'SCALAR' }],
        buffers: [{ byteLength: 2 }],
      },
      new Uint8Array(bin.buffer),
    );
    const { values } = readAccessor(glb, 0);
    expect(values[0]).toBe(-1); // -128/127 clamped to -1
    expect(values[1]).toBeCloseTo(1);
  });

  it('respects byteStride for an interleaved buffer view', () => {
    // Interleave [pos.xyz, extra.w] as 4 floats per vertex, but only read the 3-float VEC3 at offset 0.
    const floats = new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]);
    const bin = new Uint8Array(floats.buffer);
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, byteStride: 16 }],
        accessors: [{ bufferView: 0, componentType: FLOAT, count: 2, type: 'VEC3' }],
        buffers: [{ byteLength: bin.length }],
      },
      bin,
    );
    const { values } = readAccessor(glb, 0);
    expect(Array.from(values)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('returns an all-zero accessor when bufferView is undefined (sparse/no-data)', () => {
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [],
        accessors: [{ componentType: FLOAT, count: 3, type: 'VEC3' }],
        buffers: [],
      },
      new Uint8Array(0),
    );
    const { values, count, componentsPerElement } = readAccessor(glb, 0);
    expect(count).toBe(3);
    expect(componentsPerElement).toBe(3);
    expect(Array.from(values)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('readIndices converts a SCALAR accessor to Uint32Array', () => {
    const idx = new Uint16Array([5, 3, 1]);
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 6 }],
        accessors: [{ bufferView: 0, componentType: UNSIGNED_SHORT, count: 3, type: 'SCALAR' }],
        buffers: [{ byteLength: 6 }],
      },
      new Uint8Array(idx.buffer),
    );
    const indices = readIndices(glb, 0);
    expect(indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(indices)).toEqual([5, 3, 1]);
  });

  it('throws for a sparse accessor rather than silently returning the un-patched base data', () => {
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
        accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'SCALAR', sparse: { count: 1, indices: {}, values: {} } }],
        buffers: [{ byteLength: 12 }],
      },
      new Uint8Array(12),
    );
    expect(() => readAccessor(glb, 0)).toThrow(/sparse accessor/);
  });

  it('throws for an unknown accessor type instead of silently producing a length-0 result', () => {
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
        accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC33' as unknown as 'VEC3' }],
        buffers: [{ byteLength: 12 }],
      },
      new Uint8Array(12),
    );
    expect(() => readAccessor(glb, 0)).toThrow(/unknown type/);
  });

  it('throws for a negative or non-integer count instead of misbehaving silently', () => {
    const base = { asset: { version: '2.0' as const }, nodes: [], meshes: [], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }], buffers: [{ byteLength: 12 }] };
    const negative = glbWithRawBin({ ...base, accessors: [{ bufferView: 0, componentType: FLOAT, count: -1, type: 'SCALAR' as const }] }, new Uint8Array(12));
    expect(() => readAccessor(negative, 0)).toThrow(/invalid count/);
    const fractional = glbWithRawBin({ ...base, accessors: [{ bufferView: 0, componentType: FLOAT, count: 2.5, type: 'SCALAR' as const }] }, new Uint8Array(12));
    expect(() => readAccessor(fractional, 0)).toThrow(/invalid count/);
  });

  it('throws when a bufferView references a buffer other than 0', () => {
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 1, byteOffset: 0, byteLength: 12 }],
        accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'SCALAR' }],
        buffers: [{ byteLength: 12 }, { byteLength: 12, uri: 'other.bin' }],
      },
      new Uint8Array(12),
    );
    expect(() => readAccessor(glb, 0)).toThrow(/only buffer 0/);
  });

  it('throws when byteStride is smaller than the tight element size', () => {
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24, byteStride: 8 }], // VEC3 FLOAT needs 12
        accessors: [{ bufferView: 0, componentType: FLOAT, count: 2, type: 'VEC3' }],
        buffers: [{ byteLength: 24 }],
      },
      new Uint8Array(24),
    );
    expect(() => readAccessor(glb, 0)).toThrow(/smaller than its tight element size/);
  });

  it('throws when an accessor reads past the end of its own bufferView, instead of reading into the next one', () => {
    // Two adjacent bufferViews: a 2-vertex VEC3 view, then another view right after it.
    // An accessor claiming count=4 over the first view would (without a bounds check) read
    // two "vertices" that are actually the second view's bytes.
    const bin = new Float32Array([1, 1, 1, 2, 2, 2, 9, 9, 9, 8, 8, 8]);
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 24 }, // 2 vertices
          { buffer: 0, byteOffset: 24, byteLength: 24 },
        ],
        accessors: [{ bufferView: 0, componentType: FLOAT, count: 4, type: 'VEC3' }], // claims 4, view only fits 2
        buffers: [{ byteLength: 48 }],
      },
      new Uint8Array(bin.buffer),
    );
    expect(() => readAccessor(glb, 0)).toThrow(/needs .* bytes but its bufferView/);
  });

  it('throws when a bufferView itself extends past the end of the BIN chunk', () => {
    const glb = glbWithRawBin(
      {
        asset: { version: '2.0' }, nodes: [], meshes: [],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 100 }], // BIN chunk below is only 12 bytes
        accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'SCALAR' }],
        buffers: [{ byteLength: 100 }],
      },
      new Uint8Array(12),
    );
    expect(() => readAccessor(glb, 0)).toThrow(/extends past the end of the BIN chunk/);
  });
});

describe('readNodes / buildParentMap', () => {
  it('fills in TRS defaults for a node with none set', () => {
    const glb: GlbFile = { json: { asset: { version: '2.0' }, nodes: [{}], meshes: [], accessors: [], bufferViews: [], buffers: [] }, bin: new Uint8Array(0) };
    const [n] = readNodes(glb);
    expect(n!.translation).toEqual([0, 0, 0]);
    expect(n!.rotation).toEqual([0, 0, 0, 1]);
    expect(n!.scale).toEqual([1, 1, 1]);
  });

  it('decomposes a matrix-only node into TRS', () => {
    const q = { x: 0, y: 0.7071, z: 0, w: 0.7071 }; // ~90deg around Y
    const rot = quatToMatrix(q);
    rot[12] = 10; rot[13] = 20; rot[14] = 30; // translation
    const glb: GlbFile = {
      json: { asset: { version: '2.0' }, nodes: [{ matrix: Array.from(rot) }], meshes: [], accessors: [], bufferViews: [], buffers: [] },
      bin: new Uint8Array(0),
    };
    const [n] = readNodes(glb);
    expect(n!.translation[0]).toBeCloseTo(10);
    expect(n!.translation[1]).toBeCloseTo(20);
    expect(n!.translation[2]).toBeCloseTo(30);
    expect(n!.scale[0]).toBeCloseTo(1, 4);
    expect(n!.scale[1]).toBeCloseTo(1, 4);
    expect(n!.scale[2]).toBeCloseTo(1, 4);
  });

  it('decomposes a scaled matrix and recovers the scale factors', () => {
    const m = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]);
    const glb: GlbFile = {
      json: { asset: { version: '2.0' }, nodes: [{ matrix: Array.from(m) }], meshes: [], accessors: [], bufferViews: [], buffers: [] },
      bin: new Uint8Array(0),
    };
    const [n] = readNodes(glb);
    expect(n!.scale[0]).toBeCloseTo(2);
    expect(n!.scale[1]).toBeCloseTo(3);
    expect(n!.scale[2]).toBeCloseTo(4);
  });

  it('builds a parent map from children arrays', () => {
    const glb: GlbFile = {
      json: {
        asset: { version: '2.0' },
        nodes: [{ children: [1, 2] }, { children: [3] }, {}, {}],
        meshes: [], accessors: [], bufferViews: [], buffers: [],
      },
      bin: new Uint8Array(0),
    };
    const parents = buildParentMap(readNodes(glb));
    expect(Array.from(parents)).toEqual([-1, 0, 0, 1]);
  });

  it('decomposes a mirrored matrix into a unit quaternion, folding the mirror into scale rather than discarding it', () => {
    // Mirror the X axis: diag(-1, 1, 1). A naive Math.hypot-only scale extraction can't tell
    // this apart from an unmirrored identity, and produces a non-unit "rotation" quaternion.
    const m = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const glb: GlbFile = {
      json: { asset: { version: '2.0' }, nodes: [{ matrix: Array.from(m) }], meshes: [], accessors: [], bufferViews: [], buffers: [] },
      bin: new Uint8Array(0),
    };
    const [n] = readNodes(glb);
    expect(n!.scale[0]).toBeCloseTo(-1); // the mirror is preserved as a negative scale...
    const [qx, qy, qz, qw] = n!.rotation;
    expect(Math.hypot(qx, qy, qz, qw)).toBeCloseTo(1); // ...and the quaternion is still unit-length.
  });

  it('decomposes a mirrored-and-rotated matrix without losing the rotation component', () => {
    // Mirror X, then rotate 90 degrees around Z: the naive (unsigned-scale) extraction collapses
    // this to the same result as a pure mirror, silently discarding the rotation.
    const rotZ90 = quatToMatrix({ x: 0, y: 0, z: 0.7071, w: 0.7071 });
    const mirrorX = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const m = mat4Multiply(mirrorX, rotZ90);
    const glb: GlbFile = {
      json: { asset: { version: '2.0' }, nodes: [{ matrix: Array.from(m) }], meshes: [], accessors: [], bufferViews: [], buffers: [] },
      bin: new Uint8Array(0),
    };
    const [n] = readNodes(glb);
    const [qx, qy, qz, qw] = n!.rotation;
    expect(Math.hypot(qx, qy, qz, qw)).toBeCloseTo(1);
    // Reconstruct the rotation-only matrix from the extracted quaternion and confirm it still
    // carries the 90-degree Z rotation, rather than having collapsed to identity.
    const reconstructed = quatToMatrix({ x: qx, y: qy, z: qz, w: qw });
    expect(reconstructed[0]).toBeCloseTo(0, 4); // cos(90deg) ~ 0, not 1 (identity)
  });
});

describe('readSkin', () => {
  it('returns identity inverse-bind matrices when the skin declares none', () => {
    const glb: GlbFile = {
      json: { asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [], skins: [{ joints: [0, 1] }] },
      bin: new Uint8Array(0),
    };
    const skin = readSkin(glb, 0);
    expect(skin.joints).toEqual([0, 1]);
    expect(Array.from(skin.inverseBindMatrices[0]!)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('reads real inverseBindMatrices from an accessor', () => {
    const builder = newBuilder();
    const mats = new Float32Array(32);
    mats[0] = 1; mats[5] = 1; mats[10] = 1; mats[15] = 1; // identity for joint 0
    mats[16] = 2; mats[21] = 2; mats[26] = 2; mats[31] = 1; // 2x scale for joint 1
    const view = pushView(builder, mats, ARRAY_BUFFER);
    const acc = pushAccessor(builder, view, 'MAT4', FLOAT, 2);
    builder.json.skins = [{ joints: [0, 1], inverseBindMatrices: acc }];
    const glb = parseGLB(assembleGLB(builder));
    const skin = readSkin(glb, 0);
    expect(skin.inverseBindMatrices[1]![0]).toBe(2);
  });

  it('throws for a missing skin index', () => {
    const glb: GlbFile = { json: { asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [] }, bin: new Uint8Array(0) };
    expect(() => readSkin(glb, 0)).toThrow(/no skin/);
  });

  it('throws when the inverseBindMatrices accessor has fewer matrices than joints, instead of returning empty matrices for the missing slots', () => {
    const builder = newBuilder();
    const mats = new Float32Array(16); // only 1 matrix, but the skin below declares 3 joints
    mats[0] = 1; mats[5] = 1; mats[10] = 1; mats[15] = 1;
    const view = pushView(builder, mats, ARRAY_BUFFER);
    const acc = pushAccessor(builder, view, 'MAT4', FLOAT, 1);
    builder.json.skins = [{ joints: [0, 1, 2], inverseBindMatrices: acc }];
    const glb = parseGLB(assembleGLB(builder));
    expect(() => readSkin(glb, 0)).toThrow(/only carries 1 matri/);
  });

  it('throws when the inverseBindMatrices accessor is not type MAT4', () => {
    const builder = newBuilder();
    const values = new Float32Array([1, 2, 3, 4]);
    const view = pushView(builder, values, ARRAY_BUFFER);
    const acc = pushAccessor(builder, view, 'VEC4', FLOAT, 1);
    builder.json.skins = [{ joints: [0], inverseBindMatrices: acc }];
    const glb = parseGLB(assembleGLB(builder));
    expect(() => readSkin(glb, 0)).toThrow(/must be type MAT4/);
  });
});

describe('readPrimitive', () => {
  it('reads positions, indices, and optional attributes', () => {
    const builder = newBuilder();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const posView = pushView(builder, positions, ARRAY_BUFFER);
    const posAcc = pushAccessor(builder, posView, 'VEC3', FLOAT, 3);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const uvView = pushView(builder, uv, ARRAY_BUFFER);
    const uvAcc = pushAccessor(builder, uvView, 'VEC2', FLOAT, 3);
    const indices = new Uint16Array([0, 1, 2]);
    const idxView = pushView(builder, indices, ELEMENT_ARRAY_BUFFER);
    const idxAcc = pushAccessor(builder, idxView, 'SCALAR', UNSIGNED_SHORT, 3);
    const glb = parseGLB(assembleGLB(builder));
    const prim = readPrimitive(glb, { attributes: { POSITION: posAcc, TEXCOORD_0: uvAcc }, indices: idxAcc });
    expect(prim.count).toBe(3);
    expect(Array.from(prim.positions)).toEqual(Array.from(positions));
    expect(Array.from(prim.uv0!)).toEqual(Array.from(uv));
    expect(Array.from(prim.indices)).toEqual([0, 1, 2]);
    expect(prim.normals).toBeUndefined();
  });

  it('synthesizes sequential indices when the primitive has none', () => {
    const builder = newBuilder();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const view = pushView(builder, positions, ARRAY_BUFFER);
    const acc = pushAccessor(builder, view, 'VEC3', FLOAT, 3);
    const glb = parseGLB(assembleGLB(builder));
    const prim = readPrimitive(glb, { attributes: { POSITION: acc } });
    expect(Array.from(prim.indices)).toEqual([0, 1, 2]);
  });

  it('throws for a non-TRIANGLES mode instead of silently reinterpreting its indices', () => {
    const builder = newBuilder();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const view = pushView(builder, positions, ARRAY_BUFFER);
    const acc = pushAccessor(builder, view, 'VEC3', FLOAT, 2);
    const glb = parseGLB(assembleGLB(builder));
    expect(() => readPrimitive(glb, { attributes: { POSITION: acc }, mode: 1 })).toThrow(/mode 1 is not supported/);
  });

  it('throws when the index count is not a multiple of 3', () => {
    const builder = newBuilder();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const posView = pushView(builder, positions, ARRAY_BUFFER);
    const posAcc = pushAccessor(builder, posView, 'VEC3', FLOAT, 4);
    const indices = new Uint16Array([0, 1, 2, 3]); // 4 indices, not a multiple of 3
    const idxView = pushView(builder, indices, ELEMENT_ARRAY_BUFFER);
    const idxAcc = pushAccessor(builder, idxView, 'SCALAR', UNSIGNED_SHORT, 4);
    const glb = parseGLB(assembleGLB(builder));
    expect(() => readPrimitive(glb, { attributes: { POSITION: posAcc }, indices: idxAcc })).toThrow(/not a multiple of 3/);
  });

  it('throws when a primitive has no POSITION attribute', () => {
    const glb: GlbFile = { json: { asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [] }, bin: new Uint8Array(0) };
    expect(() => readPrimitive(glb, { attributes: {} })).toThrow(/no POSITION/);
  });
});

describe('baseColorImageSource', () => {
  it('returns undefined when the material has no baseColorTexture', () => {
    const glb: GlbFile = {
      json: { asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [], materials: [{}] },
      bin: new Uint8Array(0),
    };
    expect(baseColorImageSource(glb, 0)).toBeUndefined();
  });

  it('resolves the texture source index', () => {
    const glb: GlbFile = {
      json: {
        asset: { version: '2.0' }, nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        textures: [{ source: 2 }],
      },
      bin: new Uint8Array(0),
    };
    expect(baseColorImageSource(glb, 0)).toBe(2);
  });
});
