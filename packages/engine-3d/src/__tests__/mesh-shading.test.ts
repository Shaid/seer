import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { applyMeshShading, clearGeneratedShadingMaterials, type GeneratedShadingMaterials } from '../mesh-shading.js';
import type { Model3D, ModelRepresentations } from '../types.js';

function spyOnDispose(material: THREE.Material) {
  return vi.spyOn(material, 'dispose');
}

function makeGltfModel(): { model: Model3D; mesh: THREE.Mesh; originalMaterial: THREE.MeshStandardMaterial } {
  const object = new THREE.Group();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const originalMaterial = new THREE.MeshStandardMaterial({ color: 0xff8800 });
  const mesh = new THREE.Mesh(geom, originalMaterial);
  object.add(mesh);

  const originalMaterials: ModelRepresentations['originalMaterials'] = new Map();
  originalMaterials.set(mesh, originalMaterial);
  const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials };

  return {
    model: { object, source: 'gltf', animations: [], hasTextures: false, repr },
    mesh,
    originalMaterial,
  };
}

function makePolygonModel(): Model3D {
  const object = new THREE.Group();
  const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials: new Map() };
  return { object, source: 'polygon', animations: [], hasTextures: false, repr };
}

describe('applyMeshShading — "lit" (no-op custom material)', () => {
  it("keeps the mesh's own material, toggling flatShading from `smooth`", () => {
    const { model, mesh, originalMaterial } = makeGltfModel();
    const cache: GeneratedShadingMaterials = new Map();

    applyMeshShading(model, cache, { shading: 'lit', smooth: true, renderMode: 'textured' });
    expect(mesh.material).toBe(originalMaterial);
    expect(originalMaterial.flatShading).toBe(false);

    applyMeshShading(model, cache, { shading: 'lit', smooth: false, renderMode: 'textured' });
    expect(originalMaterial.flatShading).toBe(true);
    expect(cache.size).toBe(0);
  });
});

describe('applyMeshShading — custom modes', () => {
  it('"unlit" swaps in a MeshBasicMaterial carrying the original map/color', () => {
    const { model, mesh, originalMaterial } = makeGltfModel();
    const cache: GeneratedShadingMaterials = new Map();
    applyMeshShading(model, cache, { shading: 'unlit', smooth: false, renderMode: 'textured' });
    expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((mesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(originalMaterial.color.getHex());
    expect(cache.get(mesh)).toBeDefined();
  });

  it('"normals" and "depth" swap in their debug materials', () => {
    const { model, mesh } = makeGltfModel();
    const cache: GeneratedShadingMaterials = new Map();
    applyMeshShading(model, cache, { shading: 'normals', smooth: false, renderMode: 'textured' });
    expect(mesh.material).toBeInstanceOf(THREE.MeshNormalMaterial);
    applyMeshShading(model, cache, { shading: 'depth', smooth: false, renderMode: 'textured' });
    expect(mesh.material).toBeInstanceOf(THREE.MeshDepthMaterial);
  });

  it('defers to renderMode: no custom material for "wireframe" or "points" even with shading !== "lit"', () => {
    const { model, mesh, originalMaterial } = makeGltfModel();
    const cache: GeneratedShadingMaterials = new Map();
    applyMeshShading(model, cache, { shading: 'toon', smooth: false, renderMode: 'wireframe' });
    expect(mesh.material).toBe(originalMaterial);
    expect(cache.size).toBe(0);
  });

  it('disposes previously-generated materials on every call, not just at the end', () => {
    const { model } = makeGltfModel();
    const cache: GeneratedShadingMaterials = new Map();
    applyMeshShading(model, cache, { shading: 'unlit', smooth: false, renderMode: 'textured' });
    const firstMaterials = [...cache.values()][0]!;
    const disposeSpy = firstMaterials.map((m) => spyOnDispose(m));
    applyMeshShading(model, cache, { shading: 'toon', smooth: false, renderMode: 'textured' });
    for (const spy of disposeSpy) expect(spy).toHaveBeenCalled();
  });

  it('no-op for a polygon model', () => {
    const model = makePolygonModel();
    const cache: GeneratedShadingMaterials = new Map();
    applyMeshShading(model, cache, { shading: 'toon', smooth: false, renderMode: 'faces' });
    expect(cache.size).toBe(0);
  });

  it('"indexedRamp" swaps in a MeshToonMaterial carrying a gradientMap and the original normal/AO maps', () => {
    const { model, mesh, originalMaterial } = makeGltfModel();
    originalMaterial.normalMap = new THREE.Texture();
    originalMaterial.aoMap = new THREE.Texture();
    const cache: GeneratedShadingMaterials = new Map();
    applyMeshShading(model, cache, { shading: 'indexedRamp', smooth: false, renderMode: 'textured' });
    expect(mesh.material).toBeInstanceOf(THREE.MeshToonMaterial);
    const material = mesh.material as THREE.MeshToonMaterial;
    expect(material.gradientMap).toBeInstanceOf(THREE.DataTexture);
    expect(material.normalMap).toBe(originalMaterial.normalMap);
    expect(material.aoMap).toBe(originalMaterial.aoMap);
    expect(material.color.getHex()).toBe(originalMaterial.color.getHex());
  });

  it('"indexedRamp" reuses the same gradientMap instance across calls (module-shared, not per-material)', () => {
    const { model: modelA, mesh: meshA } = makeGltfModel();
    const { model: modelB, mesh: meshB } = makeGltfModel();
    const cache: GeneratedShadingMaterials = new Map();
    applyMeshShading(modelA, cache, { shading: 'indexedRamp', smooth: false, renderMode: 'textured' });
    applyMeshShading(modelB, cache, { shading: 'indexedRamp', smooth: false, renderMode: 'textured' });
    const gradientA = (meshA.material as THREE.MeshToonMaterial).gradientMap;
    const gradientB = (meshB.material as THREE.MeshToonMaterial).gradientMap;
    expect(gradientA).toBe(gradientB);
  });
});

describe('clearGeneratedShadingMaterials', () => {
  it('disposes every cached material and empties the cache', () => {
    const { model } = makeGltfModel();
    const cache: GeneratedShadingMaterials = new Map();
    applyMeshShading(model, cache, { shading: 'unlit', smooth: false, renderMode: 'textured' });
    expect(cache.size).toBe(1);
    clearGeneratedShadingMaterials(cache);
    expect(cache.size).toBe(0);
  });
});
