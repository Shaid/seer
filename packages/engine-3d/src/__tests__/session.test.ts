// @vitest-environment jsdom
//
// Same WebGLRenderer/rAF mocking as viewport.test.ts (see its header comment
// for why) — this file only exercises session.ts's own new appearance state
// (shading/smooth/subdivision/textureFilter), not viewport internals, which
// are already covered there.
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model3D, ModelRepresentations } from '../types.js';
import type { RenderPath } from '../render-path.js';

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
    invalidateSceneContents: vi.fn(),
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

/** A minimal fake `RenderPath`, installed directly via `session.viewport.setRenderPath()` (bypassing setCinematic()/setPhotoMode(), which build real paths) — for tests that only need to observe whether `invalidateSceneContents()` gets called, not exercise a real render tier. */
function makeFakeRenderPath(): RenderPath & { invalidateSceneContents: () => void } {
  return {
    render: vi.fn(),
    dispose: vi.fn(),
    invalidateSceneContents: vi.fn(),
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

/** A `makeGltfModel()` whose object also has a named child node — for `setExternalAnimations` tests, which need a track's `nodeName` to resolve against `model.object`. */
function makeGltfModelWithBone(boneName: string): { model: Model3D; bone: THREE.Object3D } {
  const { model } = makeGltfModel();
  const bone = new THREE.Object3D();
  bone.name = boneName;
  model.object.add(bone);
  return { model, bone };
}

/** A minimal one-track `THREE.AnimationClip` animating `nodeName`'s position — enough for `AnimationMixer`/`PropertyBinding` to bind against a real (or, for the mismatch test, absent) node. */
function makeClip(name: string, nodeName: string): THREE.AnimationClip {
  const track = new THREE.VectorKeyframeTrack(`${nodeName}.position`, [0, 1], [0, 0, 0, 1, 1, 1]);
  return new THREE.AnimationClip(name, 1, [track]);
}

/**
 * A `makeGltfModel()` with a straight `THREE.Bone` chain attached, each link
 * offset 0.2 units along +X from its parent — the same "rest pose
 * perpendicular to gravity" shape `spring-bones.test.ts`'s own `makeChain`
 * uses, and for the same reason (a chain resting exactly along gravity has
 * no torque to respond to, which would make "did the sim do anything" tests
 * vacuously true).
 */
function makeGltfModelWithChain(names: string[]): { model: Model3D; bones: THREE.Bone[] } {
  const { model } = makeGltfModel();
  const bones: THREE.Bone[] = [];
  let parent: THREE.Object3D = model.object;
  for (const name of names) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(0.2, 0, 0);
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }
  model.object.updateMatrixWorld(true);
  return { model, bones };
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

// A composited "head" added via addModel() used to be frozen at whatever it
// looked like at load time — setRenderMode/setShading/setSmooth/
// setSubdivision/setTextureFilter only ever touched the model set via
// setModel(). Fixed by having refreshAppearance/refreshPolish/
// setTextureFilter apply to every model in the session's internal
// trackedModels list (which addModel() also pushes into), not just the
// primary `model` — see session.ts's own doc comments on each setter.
describe('MeshSession — appearance toggles reach addModel()-added models too', () => {
  it('setRenderMode affects a model added via addModel, not just the one set via setModel', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model: body, mesh: bodyMesh } = makeGltfModel();
    const { model: head, mesh: headMesh } = makeGltfModel();
    session.setModel(body, { fit: false });
    session.addModel(head);

    session.setRenderMode('wireframe');

    expect((bodyMesh.material as THREE.Material).type).toBe('MeshBasicMaterial');
    expect((headMesh.material as THREE.Material).type).toBe('MeshBasicMaterial');
  });

  it('setShading affects a model added via addModel, not just the one set via setModel', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model: body, mesh: bodyMesh } = makeGltfModel();
    const { model: head, mesh: headMesh } = makeGltfModel();
    session.setModel(body, { fit: false });
    session.addModel(head);

    session.setShading('unlit');

    expect((bodyMesh.material as THREE.Material).type).toBe('MeshBasicMaterial');
    expect((headMesh.material as THREE.Material).type).toBe('MeshBasicMaterial');
  });

  it('setShading does not dispose an earlier tracked model\'s freshly-generated material when applied to a later one (shared-cache clobber regression)', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model: body, mesh: bodyMesh } = makeGltfModel();
    const { model: head, mesh: headMesh } = makeGltfModel();
    session.setModel(body, { fit: false });
    session.addModel(head);

    session.setShading('unlit');
    const bodyDisposeSpy = vi.spyOn(bodyMesh.material as THREE.Material, 'dispose');

    // Re-triggering the same refresh (e.g. a second toggle) must only
    // dispose/rebuild each mesh's OWN stale generated material, never a
    // sibling tracked model's — applyMeshShading previously wiped the
    // whole shared cache on every call, which would dispose body's material
    // out from under it while only rebuilding head's.
    session.setShading('toon');

    expect(bodyDisposeSpy).toHaveBeenCalled(); // body's own stale 'unlit' material IS disposed...
    expect((bodyMesh.material as THREE.Material).type).toBe('MeshToonMaterial'); // ...and replaced with a live 'toon' one, not left dangling
    expect((headMesh.material as THREE.Material).type).toBe('MeshToonMaterial');
  });

  it('setSmooth/setSubdivision rebuild geometry for a model added via addModel', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model: body } = makeGltfModel();
    const { model: head } = makeGltfModel();
    session.setModel(body, { fit: false });
    session.addModel(head);

    session.setSubdivision(2);

    const headMeshAfter = head.object.children[0] as THREE.Mesh;
    expect(headMeshAfter.geometry.getAttribute('position').count).toBeGreaterThan(3);
  });

  it('setTextureFilter affects a model added via addModel, not just the one set via setModel', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model: body } = makeGltfModel();
    const { model: head, mesh: headMesh } = makeGltfModel();
    session.setModel(body, { fit: false });
    session.addModel(head);

    session.setTextureFilter({ mode: 'nearest', anisotropy: 1 });

    const map = (headMesh.material as THREE.MeshStandardMaterial).map!;
    expect(map.magFilter).toBe(THREE.NearestFilter);
  });

  it('a model added via addModel picks up the session\'s already-set texture filter immediately, without waiting for a further setTextureFilter call', () => {
    const session = createMeshSession(makeContainer(), { grid: false, lights: false, frameLimiter: false });
    const { model: body } = makeGltfModel();
    session.setModel(body, { fit: false });
    session.setTextureFilter({ mode: 'nearest', anisotropy: 1 });

    const { model: head, mesh: headMesh } = makeGltfModel();
    session.addModel(head);

    const map = (headMesh.material as THREE.MeshStandardMaterial).map!;
    expect(map.magFilter).toBe(THREE.NearestFilter);
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

  it('a photo-mode takeover resets tone mapping left behind by cinematic (regression: leaks into flat afterward otherwise)', async () => {
    // Bug this guards: CinematicPath.dispose() deliberately leaves
    // renderer.toneMapping alone (see the dispose-ordering regression test
    // above) on the theory that the replacement path always sets its own
    // desired value -- true for another cinematic config, but
    // PhotoModeController never touches tone mapping at all. Without this
    // reset, cinematic -> photo -> flat would leave ACES + the old exposure
    // stuck on the renderer through the whole photo session and into flat.
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setCinematic({ toneMapping: { exposure: 3 } });
    const renderer = session.viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);

    const promise = session.setPhotoMode({});
    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
    expect(renderer.toneMappingExposure).toBe(1);
  });

  it('setCinematic() bumps photoModeGeneration too, so an in-flight setPhotoMode() can\'t install after cinematic churn leaves renderPath back where it started (regression: ABA race)', async () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    // renderPath is null before this call, and (after the churn below) null
    // again by the time it resolves -- without a generation bump in
    // setCinematic(), the `viewport.renderPath !== pathBeforeAwait` check
    // alone can't tell the two apart.
    const promise = session.setPhotoMode({});

    session.setCinematic({});
    session.setCinematic(false);

    const controller = makeFakePhotoController();
    photoModeMock.pending[0]!.resolve(controller);
    await promise;

    expect(session.viewport.renderPath).toBeNull();
    expect(session.photoMode).toBe('off');
    expect(controller.dispose).toHaveBeenCalled();
  });
});

describe('MeshSession — scene-content invalidation', () => {
  it('setModel() invalidates the installed render path\'s scene contents', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const path = makeFakeRenderPath();
    session.viewport.setRenderPath(path);
    (path.invalidateSceneContents as ReturnType<typeof vi.fn>).mockClear();

    session.setModel(makeGltfModel().model);

    expect(path.invalidateSceneContents).toHaveBeenCalled();
  });

  it('addModel() invalidates the installed render path\'s scene contents', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setModel(makeGltfModel().model);
    const path = makeFakeRenderPath();
    session.viewport.setRenderPath(path);

    session.addModel(makeGltfModel().model);

    expect(path.invalidateSceneContents).toHaveBeenCalled();
  });

  it('setRenderMode()/setShading() (both route through refreshAppearance) invalidate the installed render path', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setModel(makeGltfModel().model);
    const path = makeFakeRenderPath();
    session.viewport.setRenderPath(path);
    (path.invalidateSceneContents as ReturnType<typeof vi.fn>).mockClear();

    session.setRenderMode('wireframe');
    expect(path.invalidateSceneContents).toHaveBeenCalledTimes(1);

    session.setShading('unlit');
    expect(path.invalidateSceneContents).toHaveBeenCalledTimes(2);
  });

  it('setSmooth()/setSubdivision() (both route through refreshPolish -> refreshAppearance) invalidate the installed render path exactly once each, not twice', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setModel(makeGltfModel().model);
    const path = makeFakeRenderPath();
    session.viewport.setRenderPath(path);
    (path.invalidateSceneContents as ReturnType<typeof vi.fn>).mockClear();

    session.setSmooth(true);
    expect(path.invalidateSceneContents).toHaveBeenCalledTimes(1);

    session.setSubdivision(2);
    expect(path.invalidateSceneContents).toHaveBeenCalledTimes(2);
  });

  it('setColorMode() invalidates the installed render path\'s scene contents', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    session.setModel(makeGltfModel().model);
    const path = makeFakeRenderPath();
    session.viewport.setRenderPath(path);
    (path.invalidateSceneContents as ReturnType<typeof vi.fn>).mockClear();

    session.setColorMode('height');

    expect(path.invalidateSceneContents).toHaveBeenCalled();
  });

  it('does not throw with no render path installed (flat tier — invalidateSceneContents is a safe no-op)', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    expect(() => {
      session.setModel(makeGltfModel().model);
      session.addModel(makeGltfModel().model);
      session.setSmooth(true);
      session.setColorMode('height');
    }).not.toThrow();
  });
});

describe('MeshSession — setExternalAnimations', () => {
  it('binds an externally-sourced clip to the model set via setModel, not the clip\'s own (nonexistent here) source object', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model } = makeGltfModelWithBone('bone0');
    session.setModel(model);
    expect(session.animation).toBeNull(); // model itself has no baked clips

    session.setExternalAnimations([makeClip('walk', 'bone0')]);

    expect(session.animation).not.toBeNull();
    expect(session.animation!.clipNames).toEqual(['walk']);
  });

  it('is a no-op when no model has ever been set via setModel', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    expect(() => session.setExternalAnimations([makeClip('walk', 'bone0')])).not.toThrow();
    expect(session.animation).toBeNull();
  });

  it('replaces (disposes) a controller built from the model\'s own embedded animations', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model } = makeGltfModelWithBone('bone0');
    model.animations.push(makeClip('idle', 'bone0'));
    session.setModel(model);
    expect(session.animation!.clipNames).toEqual(['idle']);

    session.setExternalAnimations([makeClip('walk', 'bone0')]);

    expect(session.animation!.clipNames).toEqual(['walk']);
  });

  it('an empty clip array clears the controller rather than leaving a stale one bound', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model } = makeGltfModelWithBone('bone0');
    session.setModel(model);
    session.setExternalAnimations([makeClip('walk', 'bone0')]);
    expect(session.animation).not.toBeNull();

    session.setExternalAnimations([]);

    expect(session.animation).toBeNull();
  });

  it('a track whose node name has no match under the model degrades gracefully instead of throwing — the retargeting stopgap case', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model } = makeGltfModelWithBone('bone0');
    session.setModel(model);

    expect(() => session.setExternalAnimations([makeClip('walk', 'bone_not_present_on_this_rig')])).not.toThrow();
    // The controller is still built and playable — three.js silently
    // no-ops the unresolvable track (a console.warn, not an error) rather
    // than failing the whole clip, exactly the "degrades gracefully"
    // behavior the class-body animation retarget relies on.
    expect(session.animation!.clipNames).toEqual(['walk']);
  });

  it('setModel() disposes any externally-sourced controller from a previous model, same as it does for a native one', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model: first } = makeGltfModelWithBone('bone0');
    session.setModel(first);
    session.setExternalAnimations([makeClip('walk', 'bone0')]);
    expect(session.animation).not.toBeNull();

    session.setModel(makeGltfModel().model);

    expect(session.animation).toBeNull();
  });
});

describe('MeshSession — spring bones', () => {
  it('an explicit config drives a real quaternion change across steps', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, bones } = makeGltfModelWithChain(['A', 'B', 'C']);
    session.setModel(model, { fit: false });

    session.setSpringBones({ config: { chains: [{ joints: [{ node: 'A' }, { node: 'B' }, { node: 'C' }] }] } });
    expect(session.springBones).not.toBe(false);

    const before = bones.map((b) => b.quaternion.clone());
    for (let i = 0; i < 30; i++) session.stepSpringBones(1 / 60);
    const after = bones.map((b) => b.quaternion.clone());
    expect(before.some((q, i) => q.angleTo(after[i]!) > 0)).toBe(true);
  });

  it('setSpringBones(false) stops further motion, leaving the rig wherever physics last left it', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, bones } = makeGltfModelWithChain(['A', 'B']);
    session.setModel(model, { fit: false });
    session.setSpringBones({ config: { chains: [{ joints: [{ node: 'A' }, { node: 'B' }] }] } });

    for (let i = 0; i < 30; i++) session.stepSpringBones(1 / 60);
    const atDisable = bones[1]!.quaternion.clone();

    session.setSpringBones(false);
    expect(session.springBones).toBe(false);
    session.stepSpringBones(1 / 60); // no-op — no solver to advance
    expect(bones[1]!.quaternion.angleTo(atDisable)).toBeCloseTo(0, 10);
  });

  it('reads a config baked into the model\'s glTF extras (userData.SEER_spring_bones) when none is passed explicitly', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, bones } = makeGltfModelWithChain(['A', 'B']);
    model.object.userData.SEER_spring_bones = { chains: [{ joints: [{ node: 'A' }, { node: 'B' }] }] };
    session.setModel(model, { fit: false });

    session.setSpringBones({});
    const before = bones[1]!.quaternion.clone();
    for (let i = 0; i < 30; i++) session.stepSpringBones(1 / 60);
    expect(bones[1]!.quaternion.angleTo(before)).toBeGreaterThan(0);
  });

  it('autoDerive guesses a config from bone names when nothing is baked or explicit', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, bones } = makeGltfModelWithChain(['C_MANT1', 'C_MANT2', 'C_MANT3']);
    session.setModel(model, { fit: false });

    session.setSpringBones({ autoDerive: true });
    const before = bones[2]!.quaternion.clone();
    for (let i = 0; i < 30; i++) session.stepSpringBones(1 / 60);
    expect(bones[2]!.quaternion.angleTo(before)).toBeGreaterThan(0);
  });

  it('without autoDerive, an unnamed rig with no baked config resolves to no solver at all', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, bones } = makeGltfModelWithChain(['C_MANT1', 'C_MANT2']);
    session.setModel(model, { fit: false });

    session.setSpringBones({}); // no config, no autoDerive
    const before = bones[1]!.quaternion.clone();
    for (let i = 0; i < 30; i++) session.stepSpringBones(1 / 60);
    expect(bones[1]!.quaternion.angleTo(before)).toBeCloseTo(0, 10);
  });

  it('skipAnimatedBones (default true) drops a chain the active clip already keyframes', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, bones } = makeGltfModelWithChain(['A', 'B']);
    session.setModel(model, { fit: false });
    session.setExternalAnimations([makeClip('sway', 'A')]);

    session.setSpringBones({ config: { chains: [{ joints: [{ node: 'A' }, { node: 'B' }] }] } });
    const before = bones[1]!.quaternion.clone();
    for (let i = 0; i < 30; i++) session.stepSpringBones(1 / 60);
    // The chain contains 'A', which the active clip keyframes — the whole
    // chain should have been excluded, so nothing simulates it.
    expect(bones[1]!.quaternion.angleTo(before)).toBeCloseTo(0, 10);
  });

  it('skipAnimatedBones: false simulates even a bone the active clip animates', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, bones } = makeGltfModelWithChain(['A', 'B']);
    session.setModel(model, { fit: false });
    session.setExternalAnimations([makeClip('sway', 'A')]);

    session.setSpringBones({
      config: { chains: [{ joints: [{ node: 'A' }, { node: 'B' }] }] },
      skipAnimatedBones: false,
    });
    const before = bones[1]!.quaternion.clone();
    for (let i = 0; i < 30; i++) session.stepSpringBones(1 / 60);
    expect(bones[1]!.quaternion.angleTo(before)).toBeGreaterThan(0);
  });

  it('setExternalAnimations re-resolves the animated-bone exclusion against the new clips', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model, bones } = makeGltfModelWithChain(['A', 'B']);
    session.setModel(model, { fit: false });
    session.setSpringBones({ config: { chains: [{ joints: [{ node: 'A' }, { node: 'B' }] }] } });

    // No animation yet — the chain should simulate freely.
    const before = bones[1]!.quaternion.clone();
    for (let i = 0; i < 10; i++) session.stepSpringBones(1 / 60);
    expect(bones[1]!.quaternion.angleTo(before)).toBeGreaterThan(0);

    // Now animate 'A' — re-resolution should exclude the chain, freezing it
    // at wherever the sim already left it.
    session.setExternalAnimations([makeClip('sway', 'A')]);
    const atExclude = bones[1]!.quaternion.clone();
    for (let i = 0; i < 30; i++) session.stepSpringBones(1 / 60);
    expect(bones[1]!.quaternion.angleTo(atExclude)).toBeCloseTo(0, 10);
  });

  it('setModel resets spring bones to false, tearing down the previous model\'s solver', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    const { model: first } = makeGltfModelWithChain(['A', 'B']);
    session.setModel(first, { fit: false });
    session.setSpringBones({ config: { chains: [{ joints: [{ node: 'A' }, { node: 'B' }] }] } });
    expect(session.springBones).not.toBe(false);

    session.setModel(makeGltfModel().model, { fit: false });
    expect(session.springBones).toBe(false);
    expect(() => session.stepSpringBones(1 / 60)).not.toThrow();
  });

  it('is a no-op with no model set', () => {
    const session = createMeshSession(makeContainer(), { grid: false, frameLimiter: false });
    expect(() => session.setSpringBones({ autoDerive: true })).not.toThrow();
    expect(session.springBones).toBe(false);
  });
});
