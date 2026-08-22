// @vitest-environment jsdom
//
// Same WebGLRenderer/rAF mocking as viewport.test.ts (see its header comment
// for why) — this file only exercises session.ts's own new appearance state
// (shading/smooth/subdivision/textureFilter), not viewport internals, which
// are already covered there.
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model3D, ModelRepresentations } from '../types.js';

const { FakeWebGLRenderer } = vi.hoisted(() => {
  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement;
    outputColorSpace = '';
    capabilities = { getMaxAnisotropy: () => 8 };
    shadowMap = { enabled: false, type: 0 };
    constructor() {
      this.domElement = document.createElement('canvas');
    }
    setPixelRatio(): void {}
    setSize(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const { createMeshSession } = await import('../session.js');

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
  document.body.appendChild(el);
  return el;
}

function makeGltfModel(): { model: Model3D; mesh: THREE.Mesh } {
  const object = new THREE.Group();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const mesh = new THREE.Mesh(geom, material);
  object.add(mesh);
  const originalMaterials: ModelRepresentations['originalMaterials'] = new Map();
  originalMaterials.set(mesh, material);
  const repr: ModelRepresentations = { faces: null, lines: null, points: null, originalMaterials };
  return { model: { object, source: 'gltf', animations: [], hasTextures: true, repr }, mesh };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MeshSession — appearance state', () => {
  it('setModel resets shading/smooth/subdivision to defaults even after prior changes', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model: first, mesh } = makeGltfModel();
    session.setModel(first, { fit: false });
    session.setShading('toon');
    session.setSmooth(true);
    session.setSubdivision(4);
    expect(session.shading).toBe('toon');
    expect(session.smooth).toBe(true);
    expect(session.subdivision).toBe(4);

    const { model: second } = makeGltfModel();
    session.setModel(second, { fit: false });
    expect(session.shading).toBe('lit');
    expect(session.smooth).toBe(false);
    expect(session.subdivision).toBe(0);
    expect(mesh.material).toBeDefined(); // first model's mesh untouched by disposal ordering
  });

  it('setSubdivision rebuilds geometry from the original, not a cumulative rebuild', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model } = makeGltfModel();
    session.setModel(model, { fit: false });
    session.setSubdivision(2);
    const meshAfterFirst = model.object.children[0] as THREE.Mesh;
    const countAfterFirst = meshAfterFirst.geometry.getAttribute('position').count;
    session.setSubdivision(0);
    expect(meshAfterFirst.geometry.getAttribute('position').count).toBe(3);
    session.setSubdivision(2);
    expect(meshAfterFirst.geometry.getAttribute('position').count).toBe(countAfterFirst);
  });

  it('setTextureFilter persists across setModel — a viewer-wide preference, not per-model', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model: first } = makeGltfModel();
    session.setModel(first, { fit: false });
    session.setTextureFilter({ mode: 'nearest', anisotropy: 1 });
    expect(session.textureFilter.mode).toBe('nearest');

    const { model: second, mesh: secondMesh } = makeGltfModel();
    session.setModel(second, { fit: false });
    expect(session.textureFilter.mode).toBe('nearest');
    const map = (secondMesh.material as THREE.MeshStandardMaterial).map!;
    expect(map.magFilter).toBe(THREE.NearestFilter);
  });

  it('getMaxAnisotropy reads through to the renderer capabilities', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    expect(session.getMaxAnisotropy()).toBe(8);
  });

  it('setShading/setSmooth/setSubdivision/setTextureFilter are no-ops before any model is set', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    expect(() => {
      session.setShading('toon');
      session.setSmooth(true);
      session.setSubdivision(2);
      session.setTextureFilter({ mode: 'nearest' });
    }).not.toThrow();
    expect(session.shading).toBe('lit');
  });
});

describe('MeshSession — shadows', () => {
  it('defaults to off', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    expect(session.shadows).toBe(false);
  });

  it('setShadows(true) updates session.shadows and applies castShadow/receiveShadow to the currently-loaded model', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, mesh } = makeGltfModel();
    session.setModel(model, { fit: false });

    session.setShadows(true);

    expect(session.shadows).toBe(true);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
  });

  it('setShadows(false) resets castShadow/receiveShadow back off', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, mesh } = makeGltfModel();
    session.setModel(model, { fit: false });
    session.setShadows(true);

    session.setShadows(false);

    expect(session.shadows).toBe(false);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
  });

  it('a model loaded via setModel AFTER shadows are already on inherits shadow flags automatically', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setShadows(true);

    const { model, mesh } = makeGltfModel();
    session.setModel(model, { fit: false });

    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
  });

  it('a model loaded via addModel AFTER shadows are already on inherits shadow flags automatically', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setShadows(true);

    const { model, mesh } = makeGltfModel();
    session.addModel(model);

    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
  });

  it('a model loaded via addModel while shadows are off does NOT get shadow flags', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, mesh } = makeGltfModel();
    session.addModel(model);
    expect(mesh.castShadow).toBe(false);
  });

  it('setShadows is safe to call before any model is set, and before/after are both reflected once one loads', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    expect(() => session.setShadows(true)).not.toThrow();
    expect(session.shadows).toBe(true);

    const { model, mesh } = makeGltfModel();
    session.setModel(model, { fit: false });
    expect(mesh.castShadow).toBe(true);
  });

  it('setModel reports scene bounds to the viewport even when fit is false — the shadow-catcher/frustum hook', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const setSceneBoundsSpy = vi.spyOn(session.viewport, 'setSceneBounds');

    const { model } = makeGltfModel();
    session.setModel(model, { fit: false });

    expect(setSceneBoundsSpy).toHaveBeenCalledTimes(1);
    const box = setSceneBoundsSpy.mock.calls[0]![0] as THREE.Box3;
    expect(box.isEmpty()).toBe(false);
  });

  it('fit() also reports scene bounds, without a second, separate box computation from setModel', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model } = makeGltfModel();
    session.setModel(model, { fit: false });

    const setSceneBoundsSpy = vi.spyOn(session.viewport, 'setSceneBounds');
    session.fit();

    expect(setSceneBoundsSpy).toHaveBeenCalledTimes(1);
  });
});
