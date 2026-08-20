import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyTextureFilter } from '../texture-filter.js';
import type { Model3D, ModelRepresentations } from '../types.js';

function makeGltfModel(): { model: Model3D; texture: THREE.Texture; material: THREE.MeshStandardMaterial } {
  const object = new THREE.Group();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  object.add(mesh);

  const originalMaterials: ModelRepresentations['originalMaterials'] = new Map();
  originalMaterials.set(mesh, material);
  const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials };

  return { model: { object, source: 'gltf', animations: [], hasTextures: true, repr }, texture, material };
}

describe('applyTextureFilter', () => {
  it('"nearest" sets point sampling, no mipmaps, and forces anisotropy to 1', () => {
    const { model, texture } = makeGltfModel();
    applyTextureFilter(model, { mode: 'nearest', anisotropy: 16 }, 16);
    expect(texture.magFilter).toBe(THREE.NearestFilter);
    expect(texture.minFilter).toBe(THREE.NearestFilter);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.anisotropy).toBe(1);
  });

  it('"linear" bilinear-filters without mipmaps', () => {
    const { model, texture } = makeGltfModel();
    applyTextureFilter(model, { mode: 'linear' }, 16);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.minFilter).toBe(THREE.LinearFilter);
    expect(texture.generateMipmaps).toBe(false);
  });

  it('"trilinear" enables mipmaps and honors a requested anisotropy', () => {
    const { model, texture } = makeGltfModel();
    applyTextureFilter(model, { mode: 'trilinear', anisotropy: 4 }, 16);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.anisotropy).toBe(4);
  });

  it('clamps anisotropy to the renderer max', () => {
    const { model, texture } = makeGltfModel();
    applyTextureFilter(model, { mode: 'trilinear', anisotropy: 64 }, 8);
    expect(texture.anisotropy).toBe(8);
  });

  it('defaults anisotropy to 1 when not specified', () => {
    const { model, texture } = makeGltfModel();
    applyTextureFilter(model, { mode: 'trilinear' }, 16);
    expect(texture.anisotropy).toBe(1);
  });

  it('touches each shared texture exactly once across meshes/materials', () => {
    const { model, texture, material } = makeGltfModel();
    // A second material sharing the same texture — applyTextureFilter walks
    // model.repr.originalMaterials, not a per-mesh unique set, so dedup
    // matters once a texture is reused across materials.
    const secondMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    model.repr.originalMaterials.set(secondMesh, material);

    applyTextureFilter(model, { mode: 'nearest' }, 1);
    expect(texture.magFilter).toBe(THREE.NearestFilter);
  });

  it('no-op for a polygon model', () => {
    const object = new THREE.Group();
    const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials: new Map() };
    const model: Model3D = { object, source: 'polygon', animations: [], hasTextures: false, repr };
    expect(() => applyTextureFilter(model, { mode: 'nearest' }, 1)).not.toThrow();
  });
});
