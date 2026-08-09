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
    constructor() {
      this.domElement = document.createElement('canvas');
    }
    setPixelRatio(): void {}
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

const { createViewport } = await import('../viewport.ts');

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

    const viewportA = createViewport(containerA, { frameLimiter: false, grid: false, lights: false });
    const viewportB = createViewport(containerB, { frameLimiter: false, grid: false, lights: false });

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

    const viewportA = createViewport(containerA, { frameLimiter: false, grid: false, lights: false });
    const viewportB = createViewport(containerB, { frameLimiter: false, grid: false, lights: false });

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

  it('disposing one viewport does not cancel another viewport\'s render loop', () => {
    const containerA = makeContainer(400, 300);
    const containerB = makeContainer(400, 300);
    const viewportA = createViewport(containerA, { frameLimiter: false, grid: false, lights: false });
    createViewport(containerB, { frameLimiter: false, grid: false, lights: false });

    const idA = raf.requestAnimationFrame.mock.results[0]!.value as number;
    const idB = raf.requestAnimationFrame.mock.results[1]!.value as number;

    viewportA.dispose();
    expect(raf.cancelAnimationFrame).toHaveBeenCalledWith(idA);
    expect(raf.cancelAnimationFrame).not.toHaveBeenCalledWith(idB);
  });
});
