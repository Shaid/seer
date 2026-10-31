/**
 * Canvas2D fallback presenter: converts on the CPU with `indexedToRgba`
 * into a native-size scratch canvas, then `drawImage`s it scaled with
 * smoothing off. Slower than the WebGL2 path and without retro-display, but
 * it draws the same pixels.
 */

import { indexedToRgba, type IndexedFrame, type RgbaPalette, type ScaleMode } from './frame.js';
import { createWebGLPresenter } from './presenter-gl.js';
import { PresenterLayout, type FramePresenter, type PresenterOptions } from './presenter.js';

export function createCanvas2DPresenter(opts: PresenterOptions = {}): FramePresenter {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('arcade-runtime: Canvas2D unavailable');
  const scratch = document.createElement('canvas');
  const scratchCtx = scratch.getContext('2d')!;
  let image: ImageData | null = null;
  const sizing = new PresenterLayout(opts);
  let disposed = false;

  const present = (frame: IndexedFrame, palette: RgbaPalette): void => {
    if (disposed) throw new Error('arcade-runtime: present() called after dispose()');
    const { width, height } = frame;
    if (!image || image.width !== width || image.height !== height) {
      image = new ImageData(width, height);
      scratch.width = width;
      scratch.height = height;
    }
    indexedToRgba(frame, palette, { out: image.data });
    scratchCtx.putImageData(image, 0, 0);

    const { canvasWidth, canvasHeight, layout } = sizing.update(frame);
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    // Resizing a canvas resets its state, so set this every frame.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, layout.x, layout.y, layout.width, layout.height);
  };

  return {
    kind: 'canvas2d',
    canvas,
    present,
    resize(targetWidth, targetHeight) {
      sizing.target = { width: targetWidth, height: targetHeight };
    },
    setScale(mode: ScaleMode, pixelAspect?: number) {
      sizing.scale = mode;
      if (pixelAspect !== undefined) sizing.pixelAspect = pixelAspect;
    },
    setRetroOptions() {
      // retro-display needs WebGL2; nothing to adjust here.
    },
    get layout() {
      return sizing.current;
    },
    dispose() {
      disposed = true;
      image = null;
    },
  };
}

/** The WebGL2 presenter where available, otherwise the Canvas2D fallback. */
export function createPresenter(opts: PresenterOptions = {}): FramePresenter {
  try {
    return createWebGLPresenter(opts);
  } catch {
    // No WebGL2, a blocklisted driver, or too many live contexts.
  }
  return createCanvas2DPresenter(opts);
}
