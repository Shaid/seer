import { describe, it, expect } from 'vitest';
import {
  newBuilder,
  pushView,
  pushBytes,
  pushAccessor,
  addEmbeddedTexture,
  newAnimation,
  addAnimationChannel,
  assembleGLB,
  rgbaHasAlpha,
  eulerToMatrix,
  quatToMatrix,
  quatFromMatrix,
  mat4Multiply,
  mat4Inverse,
  align4,
  ARRAY_BUFFER,
  ELEMENT_ARRAY_BUFFER,
} from '../builder.js';
import { parseGLB, readAccessor, FLOAT, UNSIGNED_SHORT } from '../reader.js';

describe('align4', () => {
  it('rounds up to the next multiple of 4', () => {
    expect(align4(0)).toBe(0);
    expect(align4(1)).toBe(4);
    expect(align4(4)).toBe(4);
    expect(align4(5)).toBe(8);
  });
});

describe('assembleGLB / parseGLB round trip', () => {
  it('round-trips a simple mesh with a material through GLB packing and parsing', () => {
    const builder = newBuilder([{ name: 'Sword™ Émaillé' }]);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const view = pushView(builder, positions, ARRAY_BUFFER);
    const acc = pushAccessor(builder, view, 'VEC3', FLOAT, 3);
    builder.json.meshes.push({ name: 'tri', primitives: [{ attributes: { POSITION: acc }, material: 0 }] });
    builder.json.nodes.push({ mesh: 0 });
    builder.json.scenes[0]!.nodes.push(0);

    const glbBytes = assembleGLB(builder);
    const glb = parseGLB(glbBytes);
    expect(glb.json.materials?.[0]?.name).toBe('Sword™ Émaillé');
    expect(glb.json.meshes[0]?.name).toBe('tri');
    const { values, count } = readAccessor(glb, acc);
    expect(count).toBe(3);
    expect(Array.from(values)).toEqual(Array.from(positions));
  });

  it('drops empty top-level arrays from the packed JSON', () => {
    const builder = newBuilder();
    builder.json.nodes.push({ name: 'empty' });
    builder.json.scenes[0]!.nodes.push(0);
    const glb = parseGLB(assembleGLB(builder));
    expect(glb.json.materials).toBeUndefined();
    // `meshes` (unlike `materials`) is one of the top-level arrays `parseGLB` normalizes to `[]`
    // when absent, per the glTF spec making it optional — see `parseGLB`'s doc comment.
    expect(glb.json.meshes).toEqual([]);
  });

  it('synthesizes a placeholder empty node when there are no chunks at all', () => {
    const builder = newBuilder();
    const glb = parseGLB(assembleGLB(builder));
    expect(glb.json.nodes).toHaveLength(1);
    expect(glb.json.nodes[0]?.name).toBe('empty');
    expect(glb.json.scenes[0]?.nodes).toEqual([0]);
  });

  it('pads bufferViews to 4-byte alignment and keeps byte offsets correct across several pushes', () => {
    const builder = newBuilder();
    const a = pushBytes(builder, new Uint8Array([1, 2, 3])); // 3 bytes -> padded to 4
    const b = pushBytes(builder, new Uint8Array([4, 5])); // 2 bytes -> padded to 4
    const glb = parseGLB(assembleGLB(builder));
    expect(glb.json.bufferViews[a]?.byteOffset).toBe(0);
    expect(glb.json.bufferViews[b]?.byteOffset).toBe(4);
    expect(Array.from(glb.bin.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(glb.bin.subarray(4, 6))).toEqual([4, 5]);
  });

  it('round-trips an animation channel', () => {
    const builder = newBuilder();
    const positions = new Float32Array([0, 0, 0]);
    const view = pushView(builder, positions, ARRAY_BUFFER);
    const acc = pushAccessor(builder, view, 'VEC3', FLOAT, 1);
    builder.json.meshes.push({ primitives: [{ attributes: { POSITION: acc } }] });
    builder.json.nodes.push({ mesh: 0 });
    builder.json.scenes[0]!.nodes.push(0);
    const animIdx = newAnimation(builder, 'walk');
    const times = new Float32Array([0, 0.5, 1]);
    const values = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    addAnimationChannel(builder, animIdx, 0, 'translation', times, values);

    const glb = parseGLB(assembleGLB(builder));
    const anim = glb.json.animations![0]!;
    expect(anim.name).toBe('walk');
    const sampler = anim.samplers[0]!;
    expect(readAccessor(glb, sampler.input).values).toEqual(new Float64Array(times));
    expect(readAccessor(glb, sampler.output).values).toEqual(new Float64Array(values));
    expect(glb.json.accessors[sampler.input]).toMatchObject({ min: [0], max: [1] });
  });

  it('addAnimationChannel throws for zero keyframes instead of emitting a schema-invalid zero-length accessor', () => {
    const builder = newBuilder();
    const animIdx = newAnimation(builder);
    expect(() => addAnimationChannel(builder, animIdx, 0, 'translation', new Float32Array(0), new Float32Array(0))).toThrow(/at least one keyframe/);
  });

  it("addAnimationChannel throws when values.length doesn't match times.length * componentsPerValue", () => {
    const builder = newBuilder();
    const animIdx = newAnimation(builder);
    const times = new Float32Array([0, 1]);
    const tooFewValues = new Float32Array([0, 0, 0]); // 2 keyframes * VEC3 needs 6, not 3
    expect(() => addAnimationChannel(builder, animIdx, 0, 'translation', times, tooFewValues)).toThrow(/values\.length/);
    const wrongForRotation = new Float32Array([0, 0, 0, 1, 0, 0]); // VEC3-shaped (6 = 2*3), but rotation needs VEC4 (2*4=8)
    expect(() => addAnimationChannel(builder, animIdx, 0, 'rotation', times, wrongForRotation)).toThrow(/values\.length/);
  });

  it('round-trips an embedded PNG texture with alpha-blend material', () => {
    const builder = newBuilder();
    const png = new Uint8Array([1, 2, 3, 4, 5]);
    const texIdx = addEmbeddedTexture(builder, { name: 'tex', png, hasAlpha: true });
    builder.json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: texIdx } }, alphaMode: 'BLEND' }];
    const glb = parseGLB(assembleGLB(builder));
    const image = glb.json.images![0]!;
    expect(image.mimeType).toBe('image/png');
    const bv = glb.json.bufferViews[image.bufferView!]!;
    expect(Array.from(glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength))).toEqual(Array.from(png));
    expect(glb.json.materials?.[0]?.alphaMode).toBe('BLEND');
  });

  it('uses UNSIGNED_SHORT indices correctly (accessor componentType round trip)', () => {
    const builder = newBuilder();
    const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
    const posView = pushView(builder, positions, ARRAY_BUFFER);
    const posAcc = pushAccessor(builder, posView, 'VEC3', FLOAT, 2);
    const indices = new Uint16Array([0, 1]);
    const idxView = pushView(builder, indices, ELEMENT_ARRAY_BUFFER);
    const idxAcc = pushAccessor(builder, idxView, 'SCALAR', UNSIGNED_SHORT, 2);
    builder.json.meshes.push({ primitives: [{ attributes: { POSITION: posAcc }, indices: idxAcc }] });
    builder.json.nodes.push({ mesh: 0 });
    builder.json.scenes[0]!.nodes.push(0);
    const glb = parseGLB(assembleGLB(builder));
    expect(Array.from(readAccessor(glb, idxAcc).values)).toEqual([0, 1]);
  });
});

describe('rgbaHasAlpha', () => {
  it('is false for fully opaque pixels', () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(rgbaHasAlpha(rgba)).toBe(false);
  });

  it('is false for a thin edge fade below minFraction', () => {
    const rgba = new Uint8Array(400); // 100 pixels
    for (let i = 0; i < 100; i++) rgba[i * 4 + 3] = 255;
    rgba[3] = 10; // 1/100 = 1% below threshold, under the 10% default minFraction
    expect(rgbaHasAlpha(rgba)).toBe(false);
  });

  it('is true when a substantial fraction of pixels are below the alpha threshold', () => {
    const rgba = new Uint8Array(400); // 100 pixels
    for (let i = 0; i < 100; i++) rgba[i * 4 + 3] = i < 30 ? 10 : 255;
    expect(rgbaHasAlpha(rgba)).toBe(true);
  });

  it('is false for an empty buffer', () => {
    expect(rgbaHasAlpha(new Uint8Array(0))).toBe(false);
  });
});

describe('matrix helpers', () => {
  it('eulerToMatrix(0,0,0) is the identity', () => {
    const m = eulerToMatrix({ x: 0, y: 0, z: 0 });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(identity[i]!);
  });

  it('quatToMatrix(identity quat) is the identity', () => {
    const m = quatToMatrix({ x: 0, y: 0, z: 0, w: 1 });
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('quatFromMatrix inverts quatToMatrix', () => {
    const q = { x: 0.5, y: -0.3, z: 0.2, w: Math.sqrt(1 - 0.5 ** 2 - 0.3 ** 2 - 0.2 ** 2) };
    const m = quatToMatrix(q);
    const [x, y, z, w] = quatFromMatrix(m);
    expect(x).toBeCloseTo(q.x, 5);
    expect(y).toBeCloseTo(q.y, 5);
    expect(z).toBeCloseTo(q.z, 5);
    expect(w).toBeCloseTo(q.w, 5);
  });

  it('mat4Multiply(identity, m) === m', () => {
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const m = eulerToMatrix({ x: 0.3, y: 0.1, z: -0.2 });
    expect(Array.from(mat4Multiply(identity, m))).toEqual(Array.from(m));
  });

  it('mat4Inverse(m) * m === identity', () => {
    const m = quatToMatrix({ x: 0.1, y: 0.2, z: 0.3, w: Math.sqrt(1 - 0.01 - 0.04 - 0.09) });
    m[12] = 5; m[13] = -2; m[14] = 10; // add translation
    const inv = mat4Inverse(m);
    const product = mat4Multiply(inv, m);
    for (let i = 0; i < 16; i++) {
      expect(product[i]).toBeCloseTo([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][i]!, 4);
    }
  });

  it('mat4Inverse of a singular matrix returns all zeros rather than throwing', () => {
    const singular = new Float32Array(16); // all zeros, det = 0
    expect(Array.from(mat4Inverse(singular))).toEqual(new Array(16).fill(0));
  });
});
