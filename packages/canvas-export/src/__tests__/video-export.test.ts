// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaptureSurface, pickVideoMimeType, recordClip } from '../video-export.js';
import type { CaptureSource } from '../capture-source.js';
import type { RecordClipDriver } from '../video-export.js';

describe('pickVideoMimeType', () => {
  it('returns null when nothing is supported', () => {
    expect(pickVideoMimeType(() => false)).toBeNull();
  });

  it('prefers an explicit `preferred` type when supported', () => {
    const isSupported = (t: string) => t === 'video/webm;codecs=vp8' || t === 'my-custom-type';
    expect(pickVideoMimeType(isSupported, 'my-custom-type')).toBe('my-custom-type');
  });

  it('falls back past an unsupported `preferred` to the standard order', () => {
    const isSupported = (t: string) => t === 'video/webm;codecs=vp8';
    expect(pickVideoMimeType(isSupported, 'video/webm;codecs=vp9')).toBe('video/webm;codecs=vp8');
  });

  it('walks vp9 -> vp8 -> av01 -> generic webm -> mp4, in order', () => {
    const order = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm;codecs=av01',
      'video/webm',
      'video/mp4',
    ];
    for (let i = 0; i < order.length; i++) {
      // Only this candidate and everything after it are "supported" — the
      // pick must be the first supported one, i.e. this one.
      const supportedFrom = new Set(order.slice(i));
      const isSupported = (t: string) => supportedFrom.has(t);
      expect(pickVideoMimeType(isSupported)).toBe(order[i]);
    }
  });

  it('reaches mp4 as the final fallback (the Safari case)', () => {
    expect(pickVideoMimeType((t) => t === 'video/mp4')).toBe('video/mp4');
  });
});

function makeCanvas(width = 320, height = 240): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

describe('createCaptureSurface', () => {
  it('with no watermark, returns source.canvas directly (zero-cost path)', () => {
    const canvas = makeCanvas();
    const source: CaptureSource = { canvas };
    const surface = createCaptureSurface(source);
    expect(surface.canvas).toBe(canvas);
  });

  it('render() calls source.renderNow() in the zero-cost path', () => {
    const renderNow = vi.fn();
    const source: CaptureSource = { canvas: makeCanvas(), renderNow };
    const surface = createCaptureSurface(source);
    surface.render();
    expect(renderNow).toHaveBeenCalledOnce();
  });

  it('with a watermark, builds a same-size offscreen canvas', () => {
    const canvas = makeCanvas(320, 240);
    const source: CaptureSource = { canvas };
    const fakeCtx = {
      save: () => {},
      restore: () => {},
      measureText: () => ({ width: 40 }) as TextMetrics,
      fillRect: () => {},
      fillText: () => {},
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx);

    const surface = createCaptureSurface(source, { watermark: { text: 'x' } });
    expect(surface.canvas).not.toBe(canvas);
    expect(surface.canvas.width).toBe(320);
    expect(surface.canvas.height).toBe(240);

    vi.restoreAllMocks();
  });

  it('throws a clear error when a watermark is requested but no 2D context is available', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const source: CaptureSource = { canvas: makeCanvas() };
    expect(() => createCaptureSurface(source, { watermark: { text: 'x' } })).toThrow(
      /2D context unavailable/,
    );
    vi.restoreAllMocks();
  });
});

/** A fake MediaStreamTrack that records every requestFrame() call. */
function makeFakeTrack() {
  return { requestFrame: vi.fn() };
}

/**
 * A fake MediaRecorder standing in for the real browser API, which jsdom
 * does not implement at all. `start()`/`stop()` are recorded on `calls` (a
 * shared array threaded through every fake so ordering across driver and
 * recorder calls is observable in one place); `stop()` fires the 'stop'
 * listener on a microtask, matching real `MediaRecorder`'s asynchronous
 * stop event closely enough for `recordClip`'s `await stopped` to resolve
 * correctly in a test.
 */
function makeFakeMediaRecorderClass(calls: string[]) {
  class FakeMediaRecorder {
    static isTypeSupported(type: string): boolean {
      return type.startsWith('video/webm');
    }
    private listeners = new Map<string, Array<(e?: unknown) => void>>();
    constructor(
      public stream: unknown,
      public options: unknown,
    ) {}
    addEventListener(type: string, cb: (e?: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(cb);
      this.listeners.set(type, list);
    }
    start(): void {
      calls.push('recorder.start');
      const chunk = { data: new Blob(['frame'], { type: 'video/webm' }) };
      for (const cb of this.listeners.get('dataavailable') ?? []) cb(chunk);
    }
    stop(): void {
      calls.push('recorder.stop');
      queueMicrotask(() => {
        for (const cb of this.listeners.get('stop') ?? []) cb();
      });
    }
  }
  return FakeMediaRecorder;
}

/**
 * jsdom's `HTMLCanvasElement.prototype` has no `captureStream` at all —
 * `vi.spyOn` requires a property to already exist, so it's assigned
 * directly here instead (and removed in `afterEach` below) rather than
 * wrapped.
 */
function setUpRecordingGlobals(calls: string[]) {
  const track = makeFakeTrack();
  (HTMLCanvasElement.prototype as unknown as { captureStream: () => MediaStream }).captureStream =
    () => ({ getVideoTracks: () => [track] }) as unknown as MediaStream;
  vi.stubGlobal('MediaRecorder', makeFakeMediaRecorderClass(calls));
  return { track };
}

function makeDriver(calls: string[]): RecordClipDriver {
  return {
    start: () => calls.push('driver.start'),
    stop: () => calls.push('driver.stop'),
  };
}

describe('recordClip', () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
  });

  it('starts the driver before recording and stops it after, around the recorder', () => {
    setUpRecordingGlobals(calls);
    const driver = makeDriver(calls);
    const source: CaptureSource = { canvas: makeCanvas() };

    const promise = recordClip(source, { driver, durationSeconds: 0.1, fps: 10 });

    return promise.then(() => {
      expect(calls[0]).toBe('driver.start');
      expect(calls[1]).toBe('recorder.start');
      expect(calls[calls.length - 2]).toBe('driver.stop');
      expect(calls[calls.length - 1]).toBe('recorder.stop');
    });
  });

  it('commits exactly durationSeconds * fps frames via requestFrame()', async () => {
    const { track } = setUpRecordingGlobals(calls);
    const source: CaptureSource = { canvas: makeCanvas() };
    await recordClip(source, { driver: makeDriver(calls), durationSeconds: 1, fps: 24 });
    expect(track.requestFrame).toHaveBeenCalledTimes(24);
  });

  it('rounds duration*fps to at least 1 frame', async () => {
    const { track } = setUpRecordingGlobals(calls);
    const source: CaptureSource = { canvas: makeCanvas() };
    await recordClip(source, { driver: makeDriver(calls), durationSeconds: 0.001, fps: 1 });
    expect(track.requestFrame).toHaveBeenCalledTimes(1);
  });

  it('reports monotonically increasing progress ending at exactly 1', async () => {
    setUpRecordingGlobals(calls);
    const source: CaptureSource = { canvas: makeCanvas() };
    const fractions: number[] = [];
    await recordClip(source, {
      driver: makeDriver(calls),
      durationSeconds: 0.5,
      fps: 10,
      onProgress: (f) => fractions.push(f),
    });
    expect(fractions.length).toBe(5);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
    }
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it('stops early when the abort signal fires mid-recording, but still tears down', async () => {
    const { track } = setUpRecordingGlobals(calls);
    const source: CaptureSource = { canvas: makeCanvas() };
    const controller = new AbortController();

    await recordClip(source, {
      driver: makeDriver(calls),
      durationSeconds: 10,
      fps: 10,
      signal: controller.signal,
      onProgress: (f) => {
        if (f >= 0.3) controller.abort();
      },
    });

    expect(track.requestFrame.mock.calls.length).toBeLessThan(100);
    expect(calls).toContain('driver.stop');
    expect(calls).toContain('recorder.stop');
  });

  it('returns a blob assembled from every dataavailable chunk, with the negotiated mime type', async () => {
    setUpRecordingGlobals(calls);
    const source: CaptureSource = { canvas: makeCanvas() };
    const result = await recordClip(source, { driver: makeDriver(calls), durationSeconds: 0.1, fps: 10 });
    expect(result.mimeType.startsWith('video/webm')).toBe(true);
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.blob.type).toBe(result.mimeType);
  });

  it('durationSeconds in the result reflects totalFrames / fps, not the requested duration', async () => {
    setUpRecordingGlobals(calls);
    const source: CaptureSource = { canvas: makeCanvas() };
    // 0.33s at 10fps rounds to 3 frames -> 0.3s actual, not 0.33.
    const result = await recordClip(source, { driver: makeDriver(calls), durationSeconds: 0.33, fps: 10 });
    expect(result.durationSeconds).toBeCloseTo(0.3);
  });

  it('throws when no supported mime type exists in this browser', async () => {
    vi.stubGlobal(
      'MediaRecorder',
      class {
        static isTypeSupported(): boolean {
          return false;
        }
      },
    );
    const source: CaptureSource = { canvas: makeCanvas() };
    await expect(
      recordClip(source, { driver: makeDriver(calls), durationSeconds: 0.1 }),
    ).rejects.toThrow(/no supported video mime type/);
  });

  it('throws when captureStream(0) yields a track with no requestFrame (no on-demand support)', async () => {
    (HTMLCanvasElement.prototype as unknown as { captureStream: () => MediaStream }).captureStream =
      () => ({ getVideoTracks: () => [{}] }) as unknown as MediaStream;
    vi.stubGlobal('MediaRecorder', makeFakeMediaRecorderClass(calls));
    const source: CaptureSource = { canvas: makeCanvas() };
    await expect(
      recordClip(source, { driver: makeDriver(calls), durationSeconds: 0.1 }),
    ).rejects.toThrow(/on-demand captureStream/);
  });

  it('honors an explicit mimeType override when supported', async () => {
    setUpRecordingGlobals(calls);
    const source: CaptureSource = { canvas: makeCanvas() };
    const result = await recordClip(source, {
      driver: makeDriver(calls),
      durationSeconds: 0.1,
      fps: 10,
      mimeType: 'video/webm;codecs=vp8',
    });
    expect(result.mimeType).toBe('video/webm;codecs=vp8');
  });
});
