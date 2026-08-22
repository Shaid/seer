// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureBlob,
  composeCaptureCanvas,
  downloadScreenshot,
  drawWatermark,
} from '../screenshot.js';
import type { CaptureSource } from '../capture-source.js';

/**
 * jsdom implements the `HTMLCanvasElement`/`CanvasRenderingContext2D` DOM
 * shape but deliberately not real 2D rendering (`getContext('2d')` returns
 * `null` unless the heavyweight `canvas` npm package is installed, which
 * nothing in this repo depends on — see `render-quality-proposal.md`'s
 * "null 2D context is a supported state" finding). This fake context
 * records every call it receives instead of drawing anything, which is
 * enough to test `drawWatermark`'s positioning math and
 * `composeCaptureCanvas`'s branching without a real canvas backend.
 */
type Call = { name: string; args: unknown[] };

function makeFakeContext() {
  const calls: Call[] = [];
  const ctx = {
    calls,
    font: '',
    fillStyle: '',
    textBaseline: '',
    save: () => calls.push({ name: 'save', args: [] }),
    restore: () => calls.push({ name: 'restore', args: [] }),
    measureText: (text: string) => {
      calls.push({ name: 'measureText', args: [text] });
      // Deterministic fake metric: 8px per character, for predictable math.
      return { width: text.length * 8 } as TextMetrics;
    },
    fillRect: (...args: number[]) => calls.push({ name: 'fillRect', args }),
    fillText: (...args: unknown[]) => calls.push({ name: 'fillText', args }),
    drawImage: (...args: unknown[]) => calls.push({ name: 'drawImage', args }),
  };
  return ctx as unknown as CanvasRenderingContext2D & { calls: Call[] };
}

describe('drawWatermark', () => {
  it('does nothing when text is empty', () => {
    const ctx = makeFakeContext();
    drawWatermark(ctx, 800, 600, { text: '' });
    expect(ctx.calls.length).toBe(0);
  });

  it('draws a background pill and the text, in that order', () => {
    const ctx = makeFakeContext();
    drawWatermark(ctx, 800, 600, { text: 'hello' });
    const names = ctx.calls.map((c) => c.name);
    expect(names).toEqual(['save', 'measureText', 'fillRect', 'fillText', 'restore']);
  });

  it('omits the background pill when backgroundColor is null', () => {
    const ctx = makeFakeContext();
    drawWatermark(ctx, 800, 600, { text: 'hello', backgroundColor: null });
    const names = ctx.calls.map((c) => c.name);
    expect(names).toEqual(['save', 'measureText', 'fillText', 'restore']);
  });

  it('positions the pill in the bottom-right corner by default', () => {
    const ctx = makeFakeContext();
    drawWatermark(ctx, 800, 600, { text: 'ab' }); // measureText -> width 16
    const fillRect = ctx.calls.find((c) => c.name === 'fillRect')!;
    const [boxX, boxY, boxWidth, boxHeight] = fillRect.args as number[];
    // boxWidth = textWidth(16) + padX*2(12) = 28; margin default 12
    expect(boxWidth).toBe(28);
    expect(boxX).toBe(800 - 12 - 28);
    // fontSize defaults to 12 -> textHeight 14.4, boxHeight = 14.4 + padY*2(8) = 22.4
    expect(boxHeight).toBeCloseTo(22.4);
    expect(boxY).toBeCloseTo(600 - 12 - 22.4);
  });

  it('positions in each of the four corners correctly', () => {
    const positions = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
    const results = positions.map((position) => {
      const ctx = makeFakeContext();
      drawWatermark(ctx, 800, 600, { text: 'ab', position });
      const [boxX, boxY] = ctx.calls.find((c) => c.name === 'fillRect')!.args as number[];
      return { position, boxX, boxY };
    });
    expect(results[0].boxX).toBeGreaterThan(400); // bottom-right: right half
    expect(results[0].boxY).toBeGreaterThan(300); // bottom half
    expect(results[1].boxX).toBe(12); // bottom-left: flush to margin
    expect(results[1].boxY).toBeGreaterThan(300);
    expect(results[2].boxX).toBeGreaterThan(400);
    expect(results[2].boxY).toBe(12);
    expect(results[3].boxX).toBe(12);
    expect(results[3].boxY).toBe(12);
  });

  it('respects a custom margin', () => {
    const ctx = makeFakeContext();
    drawWatermark(ctx, 800, 600, { text: 'ab', position: 'top-left', margin: 40 });
    const [boxX, boxY] = ctx.calls.find((c) => c.name === 'fillRect')!.args as number[];
    expect(boxX).toBe(40);
    expect(boxY).toBe(40);
  });
});

function makeCanvas(width = 800, height = 600): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

describe('composeCaptureCanvas', () => {
  it('calls renderNow() before reading anything, when present', () => {
    const canvas = makeCanvas();
    const renderNow = vi.fn();
    const source: CaptureSource = { canvas, renderNow };
    composeCaptureCanvas(source);
    expect(renderNow).toHaveBeenCalledOnce();
  });

  it('does not throw when renderNow is absent', () => {
    const source: CaptureSource = { canvas: makeCanvas() };
    expect(() => composeCaptureCanvas(source)).not.toThrow();
  });

  it('identity fast-path: returns source.canvas directly with no watermark and scale 1', () => {
    const canvas = makeCanvas();
    const source: CaptureSource = { canvas };
    const result = composeCaptureCanvas(source);
    expect(result).toBe(canvas);
  });

  it('identity fast-path also applies when scale is explicitly 1', () => {
    const canvas = makeCanvas();
    const source: CaptureSource = { canvas };
    const result = composeCaptureCanvas(source, { scale: 1 });
    expect(result).toBe(canvas);
  });

  it('builds a fresh canvas when scale != 1', () => {
    const canvas = makeCanvas(800, 600);
    const source: CaptureSource = { canvas };
    const fakeCtx = makeFakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx);

    const result = composeCaptureCanvas(source, { scale: 2 });
    expect(result).not.toBe(canvas);
    expect(result.width).toBe(1600);
    expect(result.height).toBe(1200);
    expect(fakeCtx.calls.some((c) => c.name === 'drawImage')).toBe(true);

    vi.restoreAllMocks();
  });

  it('builds a fresh canvas and draws the watermark when a watermark is given', () => {
    const canvas = makeCanvas(800, 600);
    const source: CaptureSource = { canvas };
    const fakeCtx = makeFakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx);

    const result = composeCaptureCanvas(source, { watermark: { text: 'Model — Game — seer' } });
    expect(result).not.toBe(canvas);
    expect(fakeCtx.calls.some((c) => c.name === 'fillText')).toBe(true);

    vi.restoreAllMocks();
  });

  it('throws a clear error if the 2D context is unavailable', () => {
    const canvas = makeCanvas();
    const source: CaptureSource = { canvas };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => composeCaptureCanvas(source, { scale: 2 })).toThrow(/2D context unavailable/);
    vi.restoreAllMocks();
  });
});

describe('captureBlob / downloadScreenshot', () => {
  const fakeBlob = new Blob(['fake-png-bytes'], { type: 'image/png' });

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      callback(fakeBlob);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captureBlob resolves with the produced blob', async () => {
    const source: CaptureSource = { canvas: makeCanvas() };
    const blob = await captureBlob(source);
    expect(blob).toBe(fakeBlob);
  });

  it('captureBlob rejects when toBlob produces no blob', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      callback(null);
    });
    const source: CaptureSource = { canvas: makeCanvas() };
    await expect(captureBlob(source)).rejects.toThrow(/no blob/);
  });

  it('downloadScreenshot appends a .png extension when missing', async () => {
    const source: CaptureSource = { canvas: makeCanvas() };
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURL = vi.fn(() => 'blob:fake-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    await downloadScreenshot(source, 'my-model');

    expect(clickSpy).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('downloadScreenshot does not double up an existing .png extension', async () => {
    const source: CaptureSource = { canvas: makeCanvas() };
    let downloadedName = '';
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'download', {
          get: () => downloadedName,
          set: (v: string) => {
            downloadedName = v;
          },
        });
        (el as HTMLAnchorElement).click = () => {};
      }
      return el;
    });
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake-url', revokeObjectURL: () => {} });

    await downloadScreenshot(source, 'my-model.png');
    expect(downloadedName).toBe('my-model.png');

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
