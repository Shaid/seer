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
    toneMapping = 0;
    toneMappingExposure = 1;
    private pixelRatio = 1;
    constructor() {
      this.domElement = document.createElement('canvas');
    }
    setPixelRatio(r: number): void {
      this.pixelRatio = r;
    }
    getPixelRatio(): number {
      return this.pixelRatio;
    }
    getSize(target: THREE.Vector2): THREE.Vector2 {
      return target.set(400, 300);
    }
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

/**
 * A fully-controllable fake `createPhotoMode` — real photo-mode
 * construction needs `three-gpu-pathtracer`'s WebGLPathTracer, which needs
 * far more of a real WebGL context than is worth faking here (that's what
 * the browser verification is for). What genuinely deserves a unit test is
 * session.ts's own race-condition handling around the fact that
 * `setPhotoMode()` is async and every other render-tier setter isn't —
 * exercising that only needs full control over *when* the mocked promise
 * resolves, not what a real path tracer does.
 */
const { photoModeMock } = vi.hoisted(() => {
  const pending: Array<{ resolve: (c: unknown) => void; reject: (e: unknown) => void }> = [];
  const createPhotoMode = vi.fn(() => {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  return { photoModeMock: { pending, createPhotoMode } };
});

vi.mock('../photo-mode.js', () => ({
  createPhotoMode: photoModeMock.createPhotoMode,
  isPhotoModeAvailable: vi.fn(async () => true),
}));

function makeFakePhotoController(phase: 'tracing' | 'converged' = 'tracing', samples = 1) {
  return {
    phase,
    samples,
    render: vi.fn(),
    setCamera: vi.fn(),
    setOptions: vi.fn(),
    // A real PhotoModeController's dispose() is idempotent (photo-mode.ts's
    // own guard) — production code relies on that: viewport.setRenderPath()
    // disposing the outgoing path and session.ts's own explicit dispose()
    // call can legitimately both reach the same controller in one
    // operation. The mock still records every call (it genuinely is
    // called more than once) — tests assert "was disposed", not "called
    // exactly once", to match what idempotent actually means.
    dispose: vi.fn(),
  };
}

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
  photoModeMock.pending.length = 0;
  photoModeMock.createPhotoMode.mockClear();
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

describe('MeshSession — cinematic', () => {
  it('defaults to off, with no render path installed', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    expect(session.cinematic).toBe(false);
    expect(session.viewport.renderPath).toBeNull();
  });

  it('setCinematic(opts) installs a real EffectComposer-backed render path and updates session.cinematic', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ bloom: {} });
    expect(session.cinematic).toEqual({ bloom: {} });
    expect(session.viewport.renderPath).not.toBeNull();
    session.dispose();
  });

  it('setCinematic(false) restores the plain flat renderer and resets session.cinematic', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ bloom: {} });
    session.setCinematic(false);
    expect(session.cinematic).toBe(false);
    expect(session.viewport.renderPath).toBeNull();
    session.dispose();
  });

  it('a same-shape update (numeric option change only) reuses the existing path instance', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ bloom: { strength: 0.2 } });
    const first = session.viewport.renderPath;

    session.setCinematic({ bloom: { strength: 0.9 } });

    expect(session.viewport.renderPath).toBe(first);
    expect(session.cinematic).toEqual({ bloom: { strength: 0.9 } });
    session.dispose();
  });

  it('a shape-changing update (an effect toggled on) disposes the old path and installs a new one', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ bloom: {} });
    const first = session.viewport.renderPath!;
    const disposeSpy = vi.spyOn(first, 'dispose');

    session.setCinematic({ bloom: {}, ao: {} });

    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(session.viewport.renderPath).not.toBe(first);
    expect(session.viewport.renderPath).not.toBeNull();
    session.dispose();
  });

  it('persists across setModel — a viewport-scoped preference, not a per-model one like shading', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ bloom: {} });
    const path = session.viewport.renderPath;

    const { model } = makeGltfModel();
    session.setModel(model, { fit: false });

    expect(session.cinematic).toEqual({ bloom: {} });
    expect(session.viewport.renderPath).toBe(path);
    session.dispose();
  });

  it('is a safe no-op to call setCinematic(false) when nothing was ever enabled', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    expect(() => session.setCinematic(false)).not.toThrow();
    expect(session.viewport.renderPath).toBeNull();
  });

  it('setCinematic is a no-op after dispose()', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.dispose();
    expect(() => session.setCinematic({ bloom: {} })).not.toThrow();
    expect(session.cinematic).toBe(false);
  });

  it('constructing with every effect enabled at once does not throw (full pass chain)', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    expect(() =>
      session.setCinematic({ bloom: {}, ao: {}, dof: {}, toneMapping: {}, antialias: 'fxaa' }),
    ).not.toThrow();
    session.dispose();
  });

  it('a shape-changing transition that enables tone mapping is not silently undone by the outgoing path\'s own dispose() (regression: dispose-ordering race)', () => {
    // Bug this guards: CinematicPath.dispose() used to unconditionally reset
    // renderer.toneMapping to NoToneMapping. Viewport.setRenderPath() disposes
    // the OUTGOING path only *after* the incoming one is already constructed —
    // so a transition from one shape (no tone mapping) to a different shape
    // (tone mapping enabled) had the new path's applyToneMapping() call
    // silently wiped out by the old path's dispose() running last. Caught via
    // a real browser screenshot showing zero visible change despite exposure: 3.
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ bloom: {} }); // shape A, tone mapping off

    session.setCinematic({ toneMapping: { exposure: 3 } }); // shape B — a real rebuild, not a reuse

    const renderer = session.viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(3);
    session.dispose();
  });

  it('setCinematic(false) restores NoToneMapping when leaving a tone-mapped cinematic config', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ toneMapping: { exposure: 2 } });

    session.setCinematic(false);

    const renderer = session.viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
    expect(renderer.toneMappingExposure).toBe(1);
  });
});

describe('MeshSession — photoMode', () => {
  it('defaults to off, with no loading state and no render path installed', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    expect(session.photoMode).toBe('off');
    expect(session.viewport.renderPath).toBeNull();
  });

  it('reports "loading" synchronously, before the async construction resolves', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    void session.setPhotoMode({});
    expect(session.photoMode).toBe('loading');
    expect(photoModeMock.createPhotoMode).toHaveBeenCalledOnce();
  });

  it('installs the controller and reports its phase once construction resolves', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const promise = session.setPhotoMode({});
    const controller = makeFakePhotoController('tracing', 2);
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    expect(session.photoMode).toBe('tracing');
    expect(session.viewport.renderPath).toBe(controller);
  });

  it('reports "converged" once the controller itself reports it', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const promise = session.setPhotoMode({});
    const controller = makeFakePhotoController('converged', 64);
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    expect(session.photoMode).toBe('converged');
  });

  it('setPhotoMode(false) disposes the active controller and restores flat', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const promise = session.setPhotoMode({});
    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    await session.setPhotoMode(false);

    // Called twice, correctly: once via viewport.setRenderPath(null)'s own
    // outgoing-path disposal, once via setPhotoMode(false)'s own explicit
    // call — safe only because the real controller's dispose() is
    // idempotent (see makeFakePhotoController's comment).
    expect(controller.dispose).toHaveBeenCalled();
    expect(session.photoMode).toBe('off');
    expect(session.viewport.renderPath).toBeNull();
  });

  it('setPhotoMode(false) is a safe no-op when nothing was ever enabled', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    await expect(session.setPhotoMode(false)).resolves.toBeUndefined();
    expect(session.photoMode).toBe('off');
  });

  it('a newer setPhotoMode(false) while a call is still in flight discards the resolved controller rather than installing it', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const firstPromise = session.setPhotoMode({});
    await session.setPhotoMode(false); // supersedes the in-flight call

    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await firstPromise;

    expect(controller.dispose).toHaveBeenCalledOnce();
    expect(session.photoMode).toBe('off');
    expect(session.viewport.renderPath).toBeNull();
  });

  it('a newer setPhotoMode(opts) while a call is still in flight discards the FIRST resolved controller, keeping the second', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const firstPromise = session.setPhotoMode({ targetSamples: 10 });
    const secondPromise = session.setPhotoMode({ targetSamples: 99 });

    const firstController = makeFakePhotoController();
    const secondController = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(firstController);
    photoModeMock.pending[1]!.resolve(secondController);
    await Promise.all([firstPromise, secondPromise]);

    expect(firstController.dispose).toHaveBeenCalledOnce();
    expect(secondController.dispose).not.toHaveBeenCalled();
    expect(session.viewport.renderPath).toBe(secondController);
  });

  it('setCinematic() claiming the render-tier slot while setPhotoMode() is in flight discards the photo-mode controller once it resolves', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const photoPromise = session.setPhotoMode({});

    session.setCinematic({ bloom: {} }); // synchronous — wins immediately
    const cinematicPathInstalled = session.viewport.renderPath;

    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await photoPromise;

    expect(controller.dispose).toHaveBeenCalledOnce();
    expect(session.viewport.renderPath).toBe(cinematicPathInstalled);
    expect(session.cinematic).toEqual({ bloom: {} });
    session.dispose();
  });

  it('setPhotoMode() resolving AFTER installation clears session.cinematic — no stale "still active" report', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ bloom: {} });

    const promise = session.setPhotoMode({});
    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    expect(session.cinematic).toBe(false);
    expect(session.photoMode).toBe('tracing');
  });

  it('setCinematic() taking over clears a stale session.photoMode report, and does not double-dispose', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const promise = session.setPhotoMode({});
    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    session.setCinematic({ ao: {} });

    expect(controller.dispose).toHaveBeenCalledOnce(); // via viewport.setRenderPath's own outgoing-path disposal
    expect(session.photoMode).toBe('off');

    // setPhotoMode(false) afterward must not try to dispose the
    // already-disposed, no-longer-tracked controller again.
    await session.setPhotoMode(false);
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it('setCinematic(false) does not tear down an active photo-mode controller', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const promise = session.setPhotoMode({});
    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    session.setCinematic(false); // cinematic was never active — must be a no-op here

    expect(controller.dispose).not.toHaveBeenCalled();
    expect(session.photoMode).toBe('tracing');
    expect(session.viewport.renderPath).toBe(controller);
  });

  it('a rejected construction clears loading state and propagates the error', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const promise = session.setPhotoMode({});
    photoModeMock.pending[0]!.reject(new Error('three-gpu-pathtracer unavailable'));

    await expect(promise).rejects.toThrow('three-gpu-pathtracer unavailable');
    expect(session.photoMode).toBe('off');
  });

  it('session.dispose() while a construction is still in flight discards the resolved controller instead of leaking it', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const promise = session.setPhotoMode({});
    session.dispose();

    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it('session.dispose() disposes an active photo-mode controller', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const promise = session.setPhotoMode({});
    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    session.dispose();

    // Called twice, correctly: once via session.dispose()'s own explicit
    // call (ahead of viewport.dispose(), per the doc's ordering
    // requirement), once via viewport.dispose()'s transitive
    // renderPath?.dispose() — safe only because the real controller's
    // dispose() is idempotent.
    expect(controller.dispose).toHaveBeenCalled();
  });
});
