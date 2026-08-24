import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyMeshPolish,
  applySmoothNormals,
  captureOriginalGeometry,
  disposeOriginalGeometry,
  subdivideGeometry,
} from '../mesh-polish.js';
import type { Model3D, ModelRepresentations } from '../types.js';

function triangleGeometry(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  return geom;
}

function makeGltfModel(): { model: Model3D; mesh: THREE.Mesh } {
  const object = new THREE.Group();
  const mesh = new THREE.Mesh(triangleGeometry(), new THREE.MeshStandardMaterial());
  object.add(mesh);
  const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials: new Map() };
  return { model: { object, source: 'gltf', animations: [], hasTextures: false, repr }, mesh };
}

describe('subdivideGeometry', () => {
  it('multiplier <= 0 normalizes to non-indexed without subdividing', () => {
    const source = triangleGeometry();
    const result = subdivideGeometry(source, 0);
    expect(result.getAttribute('position').count).toBe(3);
  });

  it('doubles triangle count per logarithmic pass', () => {
    const source = triangleGeometry();
    const result = subdivideGeometry(source, 2); // passes = round(log2(2)) + 1 = 2 -> 4 triangles
    expect(result.getAttribute('position').count).toBe(4 * 3);
  });

  it('preserves UVs on the subdivided geometry', () => {
    const source = triangleGeometry();
    const result = subdivideGeometry(source, 2);
    expect(result.getAttribute('uv')).toBeDefined();
    expect(result.getAttribute('uv').count).toBe(result.getAttribute('position').count);
  });

  it('drops UVs when the source has none', () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const result = subdivideGeometry(geom, 2);
    expect(result.getAttribute('uv')).toBeUndefined();
  });
});

describe('applySmoothNormals', () => {
  it('writes a normal attribute matching the position attribute length', () => {
    const geom = triangleGeometry();
    applySmoothNormals(geom);
    const normal = geom.getAttribute('normal');
    expect(normal).toBeDefined();
    expect(normal.count).toBe(geom.getAttribute('position').count);
  });
});

describe('captureOriginalGeometry / applyMeshPolish', () => {
  it('rebuilds mesh geometry from the captured original at the requested subdivision', () => {
    const { model, mesh } = makeGltfModel();
    const original = mesh.geometry;
    const cache = captureOriginalGeometry(model);
    expect(cache.get(mesh)).not.toBe(original); // cloned, not the same instance

    applyMeshPolish(model, cache, { subdivision: 2, smooth: false });
    expect(mesh.geometry).not.toBe(original);
    expect(mesh.geometry.getAttribute('position').count).toBe(4 * 3);

    // Switching back to 0x re-derives from the untouched captured original.
    applyMeshPolish(model, cache, { subdivision: 0, smooth: false });
    expect(mesh.geometry.getAttribute('position').count).toBe(3);
  });

  it('smooth: true uses applySmoothNormals instead of per-face computeVertexNormals', () => {
    const { model, mesh } = makeGltfModel();
    const cache = captureOriginalGeometry(model);
    applyMeshPolish(model, cache, { subdivision: 0, smooth: true });
    expect(mesh.geometry.getAttribute('normal')).toBeDefined();
  });

  it('captureOriginalGeometry returns an empty cache for a polygon model', () => {
    const object = new THREE.Group();
    const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials: new Map() };
    const model: Model3D = { object, source: 'polygon', animations: [], hasTextures: false, repr };
    expect(captureOriginalGeometry(model).size).toBe(0);
  });

  it('disposeOriginalGeometry disposes every cached geometry and empties the cache', () => {
    const { model } = makeGltfModel();
    const cache = captureOriginalGeometry(model);
    expect(cache.size).toBe(1);
    disposeOriginalGeometry(cache);
    expect(cache.size).toBe(0);
  });

  it('leaves a SkinnedMesh (skinIndex/skinWeight attributes) untouched rather than dropping its skinning data', () => {
    const object = new THREE.Group();
    const geometry = triangleGeometry();
    // A real skinned mesh needs a skeleton, but subdivideGeometry only cares
    // about the geometry's own attributes — this is enough to trigger the
    // "would corrupt skinning" check without building a whole THREE.Skeleton.
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
    geometry.setAttribute(
      'skinWeight',
      new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
    );
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
    object.add(mesh);
    const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials: new Map() };
    const model: Model3D = { object, source: 'gltf', animations: [], hasTextures: false, repr };

    const cache = captureOriginalGeometry(model);
    const originalGeom = mesh.geometry;
    applyMeshPolish(model, cache, { subdivision: 2, smooth: false });

    expect(mesh.geometry).toBe(originalGeom);
    expect(mesh.geometry.getAttribute('skinIndex')).toBeDefined();
    expect(mesh.geometry.getAttribute('skinWeight')).toBeDefined();
  });

  it('leaves a multi-material mesh (material array / per-group rendering) untouched rather than dropping its geometry groups', () => {
    const object = new THREE.Group();
    const geometry = triangleGeometry();
    geometry.addGroup(0, 3, 0);
    const mesh = new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
    object.add(mesh);
    const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials: new Map() };
    const model: Model3D = { object, source: 'gltf', animations: [], hasTextures: false, repr };

    const cache = captureOriginalGeometry(model);
    const originalGeom = mesh.geometry;
    applyMeshPolish(model, cache, { subdivision: 2, smooth: false });

    expect(mesh.geometry).toBe(originalGeom);
    expect(mesh.geometry.groups).toHaveLength(1);
  });
});
