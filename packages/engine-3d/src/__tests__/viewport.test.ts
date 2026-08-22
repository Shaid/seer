// @vitest-environment jsdom
//
// jsdom implements the DOM shape createViewport() needs (elements,
// addEventListener, style) but NOT a WebGL context (`canvas.getContext`
// throws "not implemented" without the optional `canvas` npm package) and
// not `requestAnimationFrame`/`cancelAnimationFrame`/`ResizeObserver` at
// all. Rather than pull in a real WebGL/canvas stack, `THREE.WebGLRenderer`
// is partially mocked (real `three` otherwise — Scene/Camera/Group/etc are
// pure JS and exercised for real) and rAF/cancelAnimationFrame are stubbed
// with a controllable fake so the render loop's scheduling can be driven by
// hand. This is the one file in the package that needs any of this — every
// other test file runs under plain Node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWebGLRenderer } = vi.hoisted(() => {
  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement;
    outputColorSpace = '';
    setSizeCalls: Array<[number, number]> = [];
    disposeCalls = 0;
    renderCalls = 0;
    shadowMap = { enabled: false, type: 0 };
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
    setSize(w: number, h: number): void {
      this.setSizeCalls.push([w, h]);
    }
    render(): void {
      this.renderCalls++;
    }
    dispose(): void {
      this.disposeCalls++;
    }
  }
  return { FakeWebGLRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const { createViewport } = await import('../viewport.js');
const THREE = await import('three');
type RenderPath = import('../render-path.js').RenderPath;

/** Records every call it receives — used to test the render-path seam without constructing a real EffectComposer/path-tracer. */
function makeFakeRenderPath() {
  const renderCalls: Array<{ delta: number }> = [];
  const setSizeCalls: Array<[number, number, number]> = [];
  const setCameraCalls: THREE.PerspectiveCamera[] = [];
  let invalidateCalls = 0;
  let disposeCalls = 0;
  const path: RenderPath & {
    renderCalls: typeof renderCalls;
    setSizeCalls: typeof setSizeCalls;
    setCameraCalls: typeof setCameraCalls;
    invalidateCalls: number;
    disposeCalls: number;
  } = {
    renderCalls,
    setSizeCalls,
    setCameraCalls,
    get invalidateCalls() {
      return invalidateCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    render(_scene, _camera, delta) {
      renderCalls.push({ delta });
    },
    setSize(w, h, pr) {
      setSizeCalls.push([w, h, pr]);
    },
    setCamera(cam) {
      setCameraCalls.push(cam);
    },
    invalidateSceneContents() {
      invalidateCalls++;
    },
    dispose() {
      disposeCalls++;
    },
  };
  return path;
}

function makeContainer(width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

/** A controllable fake `requestAnimationFrame`/`cancelAnimationFrame` pair — jsdom implements neither, and the real ones wouldn't let a test drive the loop deterministically anyway. */
function makeRafStub() {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  const cancelAnimationFrame = vi.fn((id: number) => {
    pending.delete(id);
  });
  const fire = (id: number) => {
    const cb = pending.get(id);
    pending.delete(id);
    cb?.(0);
  };
  return { requestAnimationFrame, cancelAnimationFrame, fire };
}

let raf: ReturnType<typeof makeRafStub>;

beforeEach(() => {
  raf = makeRafStub();
  vi.stubGlobal('requestAnimationFrame', raf.requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', raf.cancelAnimationFrame);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createViewport — sizing reads the passed container', () => {
  it('two independently-created viewports size from their own container and do not interfere with each other', () => {
    const containerA = makeContainer(400, 300);
    const containerB = makeContainer(800, 200);

    const viewportA = createViewport(containerA, {
      frameLimiter: false,
      grid: false,
      lights: false,
    });
    const viewportB = createViewport(containerB, {
      frameLimiter: false,
      grid: false,
      lights: false,
    });

    expect(viewportA.camera.aspect).toBeCloseTo(400 / 300, 5);
    expect(viewportB.camera.aspect).toBeCloseTo(800 / 200, 5);

    // Resize only A's container and call only A's resize().
    Object.defineProperty(containerA, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(containerA, 'clientHeight', { value: 100, configurable: true });
    viewportA.resize();

    expect(viewportA.camera.aspect).toBeCloseTo(1, 5);
    // B is untouched — there's no module-level global either viewport reads
    // from, only the container each was constructed with.
    expect(viewportB.camera.aspect).toBeCloseTo(800 / 200, 5);

    viewportA.dispose();
    viewportB.dispose();
  });

  it('appends the renderer canvas under the container it was given, not some other element', () => {
    const containerA = makeContainer(400, 300);
    const containerB = makeContainer(400, 300);

    const viewportA = createViewport(containerA, {
      frameLimiter: false,
      grid: false,
      lights: false,
    });
    const viewportB = createViewport(containerB, {
      frameLimiter: false,
      grid: false,
      lights: false,
    });

    expect(containerA.contains(viewportA.renderer.domElement)).toBe(true);
    expect(containerB.contains(viewportB.renderer.domElement)).toBe(true);
    expect(containerA.contains(viewportB.renderer.domElement)).toBe(false);
    expect(containerB.contains(viewportA.renderer.domElement)).toBe(false);

    viewportA.dispose();
    viewportB.dispose();
  });
});

describe('createViewport — dispose()', () => {
  it('cancels its own currently-pending frame, not a stale first-ever id', () => {
    const container = makeContainer(400, 300);
    createViewport(container, { frameLimiter: false, grid: false, lights: false });

    expect(raf.requestAnimationFrame).toHaveBeenCalledTimes(1);
    const firstId = raf.requestAnimationFrame.mock.results[0]!.value as number;

    // Simulate the browser firing the first scheduled frame — the loop
    // reschedules itself, so a second, DIFFERENT id is now the live one.
    raf.fire(firstId);
    expect(raf.requestAnimationFrame).toHaveBeenCalledTimes(2);
    const secondId = raf.requestAnimationFrame.mock.results[1]!.value as number;
    expect(secondId).not.toBe(firstId);
  });

  it('dispose() cancels the render loop and no further frames get scheduled', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });

    const firstId = raf.requestAnimationFrame.mock.results[0]!.value as number;
    raf.fire(firstId); // now on frame 2
    const secondId = raf.requestAnimationFrame.mock.results[1]!.value as number;

    viewport.dispose();
    expect(raf.cancelAnimationFrame).toHaveBeenCalledWith(secondId);

    const callsBeforeFire = raf.requestAnimationFrame.mock.calls.length;
    raf.fire(secondId); // even if a browser had already queued this before cancel
    expect(raf.requestAnimationFrame.mock.calls.length).toBe(callsBeforeFire); // no frame 3
  });

  it("disposing one viewport does not cancel another viewport's render loop", () => {
    const containerA = makeContainer(400, 300);
    const containerB = makeContainer(400, 300);
    const viewportA = createViewport(containerA, {
      frameLimiter: false,
      grid: false,
      lights: false,
    });
    createViewport(containerB, { frameLimiter: false, grid: false, lights: false });

    const idA = raf.requestAnimationFrame.mock.results[0]!.value as number;
    const idB = raf.requestAnimationFrame.mock.results[1]!.value as number;

    viewportA.dispose();
    expect(raf.cancelAnimationFrame).toHaveBeenCalledWith(idA);
    expect(raf.cancelAnimationFrame).not.toHaveBeenCalledWith(idB);
  });
});

/** Fires whichever rAF id was most recently scheduled — since `animate()` always reschedules itself before returning, calling this repeatedly steps through consecutive frames. */
function fireLatest(): void {
  const results = raf.requestAnimationFrame.mock.results;
  const id = results[results.length - 1]!.value as number;
  raf.fire(id);
}

describe('createViewport — render-path seam', () => {
  it('with no path installed, renders via renderer.render() directly (today\'s behavior, unchanged)', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    fireLatest();
    expect(renderer.renderCalls).toBe(1);

    viewport.dispose();
  });

  it('setRenderPath() installs a path and the render loop dispatches to it instead of renderer.render()', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;
    const path = makeFakeRenderPath();

    viewport.setRenderPath(path);
    expect(viewport.renderPath).toBe(path);
    fireLatest();

    expect(path.renderCalls.length).toBe(1);
    expect(renderer.renderCalls).toBe(0);

    viewport.dispose();
  });

  it('setRenderPath() disposes the outgoing path when installing a different one', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const first = makeFakeRenderPath();
    const second = makeFakeRenderPath();

    viewport.setRenderPath(first);
    viewport.setRenderPath(second);

    expect(first.disposeCalls).toBe(1);
    expect(second.disposeCalls).toBe(0);

    viewport.dispose();
  });

  it('re-installing the SAME path instance is a no-op, not a dispose-and-reinstall', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const path = makeFakeRenderPath();

    viewport.setRenderPath(path);
    viewport.setRenderPath(path);

    expect(path.disposeCalls).toBe(0);

    viewport.dispose();
  });

  it('setRenderPath(null) restores the plain renderer.render() path and disposes the outgoing one', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;
    const path = makeFakeRenderPath();

    viewport.setRenderPath(path);
    viewport.setRenderPath(null);
    expect(path.disposeCalls).toBe(1);
    expect(viewport.renderPath).toBeNull();

    fireLatest();
    expect(renderer.renderCalls).toBe(1);
    expect(path.renderCalls.length).toBe(0);

    viewport.dispose();
  });

  it('dispose() disposes the currently-installed render path', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const path = makeFakeRenderPath();
    viewport.setRenderPath(path);

    viewport.dispose();
    expect(path.disposeCalls).toBe(1);
  });

  it('resize() forwards the new size and current pixel ratio to the installed path, after the renderer/camera are already resized', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;
    renderer.setPixelRatio(2);
    const path = makeFakeRenderPath();
    viewport.setRenderPath(path);

    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    viewport.resize();

    expect(path.setSizeCalls).toEqual([[800, 600, 2]]);
    expect(viewport.camera.aspect).toBeCloseTo(800 / 600, 5);

    viewport.dispose();
  });

  it('invalidateSceneContents() forwards to the installed path, and is a safe no-op with none installed', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });

    expect(() => viewport.invalidateSceneContents()).not.toThrow();

    const path = makeFakeRenderPath();
    viewport.setRenderPath(path);
    viewport.invalidateSceneContents();
    expect(path.invalidateCalls).toBe(1);

    viewport.dispose();
  });
});

describe('createViewport — addFrameHook', () => {
  it('runs every rendered frame, after onFrame, in subscription order', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const calls: string[] = [];
    viewport.setOnFrame(() => calls.push('onFrame'));
    viewport.addFrameHook(() => calls.push('hookA'));
    viewport.addFrameHook(() => calls.push('hookB'));

    fireLatest();

    expect(calls).toEqual(['onFrame', 'hookA', 'hookB']);
    viewport.dispose();
  });

  it('the returned unsubscribe removes only that hook', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const calls: string[] = [];
    const unsubA = viewport.addFrameHook(() => calls.push('hookA'));
    viewport.addFrameHook(() => calls.push('hookB'));

    unsubA();
    fireLatest();

    expect(calls).toEqual(['hookB']);
    viewport.dispose();
  });

  it('receives the same deltaSeconds the frame was rendered with', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const path = makeFakeRenderPath();
    viewport.setRenderPath(path);
    let received = -1;
    viewport.addFrameHook((delta) => {
      received = delta;
    });

    fireLatest();

    expect(received).toBe(path.renderCalls[0]!.delta);
    viewport.dispose();
  });
});

describe('createViewport — renderNow()', () => {
  it('draws immediately through the installed render path, with delta 0 (not advancing any animation)', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const path = makeFakeRenderPath();
    viewport.setRenderPath(path);

    viewport.renderNow();

    expect(path.renderCalls).toEqual([{ delta: 0 }]);
    viewport.dispose();
  });

  it('draws via renderer.render() directly with no path installed', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    viewport.renderNow();

    expect(renderer.renderCalls).toBe(1);
    viewport.dispose();
  });

  it('does not call onFrame or any frame hook', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const onFrame = vi.fn();
    const hook = vi.fn();
    viewport.setOnFrame(onFrame);
    viewport.addFrameHook(hook);

    viewport.renderNow();

    expect(onFrame).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    viewport.dispose();
  });

  it('does not call controls.update()', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const updateSpy = vi.spyOn(viewport.controls, 'update');

    viewport.renderNow();

    expect(updateSpy).not.toHaveBeenCalled();
    viewport.dispose();
  });
});

describe('createViewport — requestEveryFrame lease', () => {
  it('a held lease bypasses the frame limiter — ticks that would otherwise be gated still render', () => {
    const container = makeContainer(400, 300);
    // A very slow target (1fps) so, absent a lease, consecutive ticks with
    // no wall-clock advancement between them are gated after the first.
    const viewport = createViewport(container, {
      frameLimiter: { targetFps: 1 },
      grid: false,
      lights: false,
    });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    fireLatest(); // first tick always renders — nothing to compare it against yet
    const rendersBeforeLease = renderer.renderCalls;

    const release = viewport.requestEveryFrame();
    fireLatest();
    fireLatest();
    fireLatest();
    expect(renderer.renderCalls).toBe(rendersBeforeLease + 3);

    release();
    viewport.dispose();
  });

  it('release() is idempotent — calling it twice does not under-count an outstanding nested lease', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, {
      frameLimiter: { targetFps: 1 },
      grid: false,
      lights: false,
    });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    const releaseA = viewport.requestEveryFrame();
    const releaseB = viewport.requestEveryFrame();
    releaseA();
    releaseA(); // double-release must not decrement past what A actually held

    fireLatest(); // still leased by B — must still bypass the gate
    fireLatest();
    expect(renderer.renderCalls).toBe(2);

    releaseB();
    viewport.dispose();
  });

  it("a lease's own render cost does not corrupt the limiter's adaptive rate for frames after it ends", () => {
    // Drives performance.now() (which viewport.ts's animate() reads to time
    // recordWork) and the limiter's own gate clock off the SAME fake clock,
    // so a scenario can be constructed where a corrupted average would be
    // observable through render counts alone.
    let fakeNowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);

    // Round-number FPS targets, not 60/30 — 1000/60 is a repeating binary
    // fraction, and accumulating it via `+=` over many probe ticks below
    // hits occasional floating-point boundary misses in `shouldRender()`'s
    // plain `<` comparison (a pre-existing characteristic of that
    // comparison, unrelated to what this test is actually checking). 100
    // and 50 divide `1000` exactly, so every accumulated timestamp is
    // exact and the probe below is fully deterministic.
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, {
      frameLimiter: { now: () => fakeNowMs, targetFps: 100, fallbackFps: 50, sampleFrames: 5 },
      grid: false,
      lights: false,
    });
    const path = makeFakeRenderPath();
    const originalRender = path.render.bind(path);
    // Each render "costs" 20ms of wall-clock time while this flag is on —
    // heavy enough to blow the 100fps budget many times over if it were
    // fed into recordWork.
    let expensive = false;
    path.render = (scene, camera, delta) => {
      originalRender(scene, camera, delta);
      if (expensive) fakeNowMs += 20;
    };
    viewport.setRenderPath(path);

    const release = viewport.requestEveryFrame();
    expensive = true;
    // >= sampleFrames leased renders, each individually over budget — if
    // these wrongly fed recordWork, 5 samples would be enough to trip the
    // drop threshold.
    for (let i = 0; i < 5; i++) fireLatest();
    expensive = false;
    release();

    // Now feed real, cheap, evenly-spaced ticks. If the limiter is still at
    // its 100fps target (uncorrupted), advancing the clock by exactly one
    // 100fps interval per tick renders every single tick. If it had been
    // corrupted to the 50fps fallback, roughly half of these would be
    // gated instead.
    const rendersBeforeProbe = path.renderCalls.length;
    const probeTicks = 20;
    for (let i = 0; i < probeTicks; i++) {
      fakeNowMs += 10;
      fireLatest();
    }
    expect(path.renderCalls.length - rendersBeforeProbe).toBe(probeTicks);

    viewport.dispose();
    vi.restoreAllMocks();
  });

  it("release() resets the limiter's clock so the very next real tick is not treated as an unwanted immediate catch-up render", () => {
    let fakeNowMs = 0;
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, {
      frameLimiter: { now: () => fakeNowMs, targetFps: 60 },
      grid: false,
      lights: false,
    });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    fireLatest(); // establish a baseline last-render time
    const release = viewport.requestEveryFrame();

    // Time passes with no shouldRender() calls at all while leased —
    // lastFrameTime would otherwise go stale by this whole stretch.
    fakeNowMs += 5000;
    fireLatest(); // a leased render — bypasses the gate, doesn't touch lastFrameTime
    release();

    // Immediately after release, with no further time elapsed: had the
    // clock not been reset, the stale gap from before the lease would make
    // this tick fire regardless. With the reset, it must NOT fire yet.
    const rendersAfterRelease = renderer.renderCalls;
    fireLatest();
    expect(renderer.renderCalls).toBe(rendersAfterRelease);

    // A full interval (plus a hair of margin, so this doesn't ride the
    // exact boundary of a repeating binary fraction) later, it fires
    // normally again.
    fakeNowMs += 1000 / 60 + 1;
    fireLatest();
    expect(renderer.renderCalls).toBe(rendersAfterRelease + 1);

    viewport.dispose();
  });
});

describe('createViewport — setCamera()', () => {
  it('repoints controls.object to the new camera', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const next = new THREE.PerspectiveCamera(60, 1, 0.1, 100);

    viewport.setCamera(next);

    expect(viewport.camera).toBe(next);
    expect(viewport.controls.object).toBe(next);
    viewport.dispose();
  });

  it('the render loop uses the new camera on the very next frame', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const path = makeFakeRenderPath();
    viewport.setRenderPath(path);
    const next = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const setCameraSpy = vi.fn(path.setCamera);
    path.setCamera = setCameraSpy;

    viewport.setCamera(next);

    expect(setCameraSpy).toHaveBeenCalledWith(next);
    viewport.dispose();
  });

  it('resize() after a camera swap updates the NEW camera, not the old one', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const original = viewport.camera;
    const next = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    viewport.setCamera(next);

    Object.defineProperty(container, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true });
    viewport.resize();

    expect(next.aspect).toBeCloseTo(2, 5);
    expect(original.aspect).not.toBeCloseTo(2, 5);
    viewport.dispose();
  });
});

describe('createViewport — setSceneBounds() / setGridBounds() alias', () => {
  it('setGridBounds is a forwarding alias for setSceneBounds — same grid-fitting behavior', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: 'auto', lights: false });
    const box = new THREE.Box3(
      new THREE.Vector3(-2, 0, -2),
      new THREE.Vector3(2, 1, 2),
    );

    expect(() => viewport.setGridBounds(box)).not.toThrow();
    // Both names must be present and callable — the alias doesn't replace
    // the canonical name.
    expect(typeof viewport.setSceneBounds).toBe('function');
    expect(typeof viewport.setGridBounds).toBe('function');

    viewport.dispose();
  });

  it('is a no-op when grid was not "auto"', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));

    expect(() => viewport.setSceneBounds(box)).not.toThrow();
    expect(() => viewport.setGridBounds(box)).not.toThrow();

    viewport.dispose();
  });
});

describe('createViewport — keyLight', () => {
  it('exposes the key DirectionalLight when lights are enabled', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });

    expect(viewport.keyLight).not.toBeNull();
    expect(viewport.keyLight?.isDirectionalLight).toBe(true);

    viewport.dispose();
  });

  it('is null when the key light is disabled', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, {
      frameLimiter: false,
      grid: false,
      lights: { key: false },
    });

    expect(viewport.keyLight).toBeNull();
    viewport.dispose();
  });

  it('is null when lighting is disabled entirely', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false });

    expect(viewport.keyLight).toBeNull();
    viewport.dispose();
  });
});

function findAmbientLight(scene: InstanceType<typeof THREE.Scene>): InstanceType<typeof THREE.AmbientLight> | null {
  for (const child of scene.children) {
    if ((child as { isAmbientLight?: boolean }).isAmbientLight) return child as InstanceType<typeof THREE.AmbientLight>;
  }
  return null;
}

function findMesh(scene: InstanceType<typeof THREE.Scene>): InstanceType<typeof THREE.Mesh> | null {
  for (const child of scene.children) {
    if ((child as { isMesh?: boolean }).isMesh) return child as InstanceType<typeof THREE.Mesh>;
  }
  return null;
}

describe('createViewport — setShadows()', () => {
  it('enables the renderer shadow map and the key light\'s castShadow', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    viewport.setShadows(true);

    expect(renderer.shadowMap.enabled).toBe(true);
    expect(viewport.keyLight?.castShadow).toBe(true);
    viewport.dispose();
  });

  it('disables both again on setShadows(false), restoring castShadow to false', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    viewport.setShadows(true);
    viewport.setShadows(false);

    expect(renderer.shadowMap.enabled).toBe(false);
    expect(viewport.keyLight?.castShadow).toBe(false);
    viewport.dispose();
  });

  it('applies ShadowOptions to the key light when an object (not a bare boolean) is passed', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });

    viewport.setShadows({ mapSize: 512 });

    expect(viewport.keyLight?.shadow.mapSize.x).toBe(512);
    viewport.dispose();
  });

  it('is a safe no-op with no key light — does not throw, still toggles the renderer flag', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, {
      frameLimiter: false,
      grid: false,
      lights: { key: false },
    });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    expect(() => viewport.setShadows(true)).not.toThrow();
    expect(renderer.shadowMap.enabled).toBe(true);
    viewport.dispose();
  });

  it('dims ambient light to 40% of its configured intensity while enabled, and restores exactly on disable', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, {
      frameLimiter: false,
      grid: false,
      lights: { ambient: { intensity: 1.2 } },
    });
    const ambient = findAmbientLight(viewport.scene)!;
    expect(ambient.intensity).toBeCloseTo(1.2);

    viewport.setShadows(true);
    expect(ambient.intensity).toBeCloseTo(1.2 * 0.4);

    viewport.setShadows(false);
    expect(ambient.intensity).toBeCloseTo(1.2);

    viewport.dispose();
  });

  it('ViewportOptions.shadows applies at construction time, equivalent to calling setShadows() immediately after', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, {
      frameLimiter: false,
      grid: false,
      shadows: true,
    });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    expect(renderer.shadowMap.enabled).toBe(true);
    expect(viewport.keyLight?.castShadow).toBe(true);
    viewport.dispose();
  });

  it('omitting ViewportOptions.shadows leaves shadows off — zero behavior change for an existing consumer', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    const renderer = viewport.renderer as unknown as InstanceType<typeof FakeWebGLRenderer>;

    expect(renderer.shadowMap.enabled).toBe(false);
    expect(viewport.keyLight?.castShadow).toBe(false);
    viewport.dispose();
  });

  it('no shadow-catcher plane exists until setSceneBounds() establishes real bounds', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });

    viewport.setShadows(true);
    expect(findMesh(viewport.scene)).toBeNull();

    viewport.dispose();
  });

  it('setShadows(true) immediately creates the catcher against bounds set BEFORE shadows were enabled', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2));

    viewport.setSceneBounds(box);
    expect(findMesh(viewport.scene)).toBeNull(); // not yet — shadows aren't on

    viewport.setShadows(true);
    expect(findMesh(viewport.scene)).not.toBeNull();

    viewport.dispose();
  });

  it('setSceneBounds() after shadows are already on creates/updates the catcher and refits the shadow camera', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    viewport.setShadows(true);
    const originalRight = viewport.keyLight!.shadow.camera.right;

    const box = new THREE.Box3(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 10, 50));
    viewport.setSceneBounds(box);

    const mesh = findMesh(viewport.scene);
    expect(mesh).not.toBeNull();
    expect(viewport.keyLight!.shadow.camera.right).toBeGreaterThan(originalRight);

    viewport.dispose();
  });

  it('setSceneBounds() with shadows OFF never creates a catcher', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2));

    viewport.setSceneBounds(box);

    expect(findMesh(viewport.scene)).toBeNull();
    viewport.dispose();
  });

  it('setShadows(false) removes and disposes the catcher', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2));
    viewport.setSceneBounds(box);
    viewport.setShadows(true);
    const catcher = findMesh(viewport.scene)!;
    const disposeSpy = vi.spyOn(catcher.geometry, 'dispose');

    viewport.setShadows(false);

    expect(findMesh(viewport.scene)).toBeNull();
    expect(disposeSpy).toHaveBeenCalled();
    viewport.dispose();
  });

  it('re-enabling after a disable rebuilds a fresh catcher, not a disposed stale one', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2));
    viewport.setSceneBounds(box);

    viewport.setShadows(true);
    const first = findMesh(viewport.scene);
    viewport.setShadows(false);
    viewport.setShadows(true);
    const second = findMesh(viewport.scene);

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    viewport.dispose();
  });

  it('dispose() disposes an active shadow catcher', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false });
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2));
    viewport.setSceneBounds(box);
    viewport.setShadows(true);
    const catcher = findMesh(viewport.scene)!;
    const disposeSpy = vi.spyOn(catcher.geometry, 'dispose');

    viewport.dispose();

    expect(disposeSpy).toHaveBeenCalled();
  });

  it('the grid and the shadow catcher never sit at exactly the same y (no z-fighting)', () => {
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: 'auto' });
    const box = new THREE.Box3(new THREE.Vector3(-2, 1, -2), new THREE.Vector3(2, 3, 2));

    viewport.setShadows(true);
    viewport.setSceneBounds(box);

    const catcher = findMesh(viewport.scene)!;
    const grid = viewport.scene.children.find(
      (c) => c instanceof THREE.GridHelper,
    ) as InstanceType<typeof THREE.GridHelper>;
    expect(grid).toBeDefined();
    expect(catcher.position.y).not.toBe(grid.position.y);
    expect(catcher.position.y).toBeLessThan(grid.position.y);

    viewport.dispose();
  });
});

describe('createTurntable', () => {
  it('start() enables autoRotate at a speed matching durationSeconds (default direction, cw)', async () => {
    const { createTurntable } = await import('../turntable.js');
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false, cameraPosition: [0, 0, 5] });
    const turntable = createTurntable(viewport, { durationSeconds: 6 });

    turntable.start();

    expect(viewport.controls.autoRotate).toBe(true);
    // cw needs a positive autoRotateSpeed -- see turntable.ts's own doc comment on the sign flip.
    expect(viewport.controls.autoRotateSpeed).toBeCloseTo(60 / 6, 10);
    turntable.dispose();
    viewport.dispose();
  });

  it("start() with direction 'ccw' uses a negative autoRotateSpeed", async () => {
    const { createTurntable } = await import('../turntable.js');
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false, cameraPosition: [0, 0, 5] });
    const turntable = createTurntable(viewport, { durationSeconds: 6, direction: 'ccw' });

    turntable.start();

    expect(viewport.controls.autoRotateSpeed).toBeCloseTo(-60 / 6, 10);
    turntable.dispose();
    viewport.dispose();
  });

  it('stop() disables autoRotate without moving the camera', async () => {
    const { createTurntable } = await import('../turntable.js');
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false, cameraPosition: [0, 0, 5] });
    const turntable = createTurntable(viewport, { durationSeconds: 6 });
    const before = viewport.camera.position.clone();

    turntable.start();
    turntable.stop();

    expect(viewport.controls.autoRotate).toBe(false);
    expect(viewport.camera.position.equals(before)).toBe(true);
    turntable.dispose();
    viewport.dispose();
  });

  it('dispose() also disables autoRotate', async () => {
    const { createTurntable } = await import('../turntable.js');
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false, cameraPosition: [0, 0, 5] });
    const turntable = createTurntable(viewport, { durationSeconds: 6 });

    turntable.start();
    turntable.dispose();

    expect(viewport.controls.autoRotate).toBe(false);
    viewport.dispose();
  });

  it('step() moves the camera around the target at a constant radius, tracking elapsedSeconds', async () => {
    const { createTurntable } = await import('../turntable.js');
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false, cameraPosition: [0, 0, 5] });
    const radiusBefore = viewport.camera.position.distanceTo(viewport.controls.target);
    const turntable = createTurntable(viewport, { durationSeconds: 8, loops: 1 });

    turntable.step(1);
    expect(turntable.elapsedSeconds).toBeCloseTo(1, 10);
    turntable.step(1);
    expect(turntable.elapsedSeconds).toBeCloseTo(2, 10);

    const radiusAfter = viewport.camera.position.distanceTo(viewport.controls.target);
    expect(radiusAfter).toBeCloseTo(radiusBefore, 5);
    turntable.dispose();
    viewport.dispose();
  });

  it('step() reaches a full rotation back to the start position after durationSeconds * loops', async () => {
    const { createTurntable } = await import('../turntable.js');
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false, cameraPosition: [0, 0, 5] });
    const start = viewport.camera.position.clone();
    const turntable = createTurntable(viewport, { durationSeconds: 4, loops: 1 });

    for (let i = 0; i < 4; i++) turntable.step(1);

    expect(viewport.camera.position.x).toBeCloseTo(start.x, 4);
    expect(viewport.camera.position.y).toBeCloseTo(start.y, 4);
    expect(viewport.camera.position.z).toBeCloseTo(start.z, 4);
    turntable.dispose();
    viewport.dispose();
  });

  it('step() never touches controls.autoRotate, so it composes with a concurrent live render loop without racing', async () => {
    const { createTurntable } = await import('../turntable.js');
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false, cameraPosition: [0, 0, 5] });
    const turntable = createTurntable(viewport, { durationSeconds: 8 });

    turntable.step(0.5);

    expect(viewport.controls.autoRotate).toBe(false);
    turntable.dispose();
    viewport.dispose();
  });

  it('elevation is applied once, on the first camera-moving call, without being re-applied on every step', async () => {
    const { createTurntable } = await import('../turntable.js');
    const container = makeContainer(400, 300);
    const viewport = createViewport(container, { frameLimiter: false, grid: false, lights: false, cameraPosition: [0, 0, 5] });
    const elevation = Math.PI / 3;
    const turntable = createTurntable(viewport, { durationSeconds: 8, elevation });

    turntable.step(0);
    const offset = viewport.camera.position.clone().sub(viewport.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);

    expect(spherical.phi).toBeCloseTo(elevation, 5);
    turntable.dispose();
    viewport.dispose();
  });
});
