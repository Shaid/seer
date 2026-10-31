/**
 * Presenters put an `IndexedFrame` + palette on screen. `createPresenter()`
 * picks the WebGL2 one and falls back to Canvas2D where WebGL2 is missing.
 */

import type { RetroDisplayOptions } from '@seer-project/retro-display';
import { computeLayout, type FrameLayout, type IndexedFrame, type RgbaPalette, type ScaleMode } from './frame.js';

export interface PresenterOptions {
  /** Default `'integer'`. */
  scale?: ScaleMode;
  /** Width / height of one source pixel, default `1`. See `pixelAspectForDisplay()`. */
  pixelAspect?: number;
  /**
   * Size the canvas to the whole target and centre the frame in black bars
   * (default `true`). With `false` the canvas is exactly the frame's
   * scaled size and the page positions it.
   */
  letterbox?: boolean;
  /**
   * Route the output through `@seer-project/retro-display` (WebGL2 presenter
   * only; ignored by the Canvas2D fallback). Fixed at creation so the output
   * canvas never changes identity; `setRetroOptions()` adjusts it, and
   * `{ profile: 'none' }` turns the effect off.
   */
  retro?: RetroDisplayOptions;
}

export interface FramePresenter {
  /** `'webgl2'` or `'canvas2d'`. */
  readonly kind: 'webgl2' | 'canvas2d';
  /** The output canvas — mount it once; it stays the same for the presenter's lifetime. */
  readonly canvas: HTMLCanvasElement;
  /** Draws `frame` with `palette` (RGBA, 4 bytes per entry). */
  present(frame: IndexedFrame, palette: RgbaPalette): void;
  /**
   * Sets the target area in device pixels (e.g. a container's CSS size ×
   * `devicePixelRatio`). Until called, the target is the frame's own size.
   */
  resize(targetWidth: number, targetHeight: number): void;
  setScale(mode: ScaleMode, pixelAspect?: number): void;
  /** No-op unless the presenter was created with `retro`. */
  setRetroOptions(opts: RetroDisplayOptions): void;
  /** Where the last frame was drawn, in canvas pixels. */
  readonly layout: FrameLayout | null;
  dispose(): void;
}

/** Shared sizing state for both presenters. */
export class PresenterLayout {
  scale: ScaleMode;
  pixelAspect: number;
  readonly letterbox: boolean;
  target: { width: number; height: number } | null = null;
  current: FrameLayout | null = null;

  constructor(opts: PresenterOptions) {
    this.scale = opts.scale ?? 'integer';
    this.pixelAspect = opts.pixelAspect ?? 1;
    this.letterbox = opts.letterbox ?? true;
  }

  /**
   * Resolves the layout for `frame` and the canvas size it implies. With
   * letterboxing the canvas is the target; without it, the frame's rect
   * moved to the origin.
   */
  update(frame: IndexedFrame): { canvasWidth: number; canvasHeight: number; layout: FrameLayout } {
    const targetWidth = this.target?.width ?? Math.round(frame.width * this.pixelAspect);
    const targetHeight = this.target?.height ?? frame.height;
    let layout = computeLayout({
      width: frame.width,
      height: frame.height,
      targetWidth,
      targetHeight,
      mode: this.scale,
      pixelAspect: this.pixelAspect,
    });
    let canvasWidth = Math.max(1, Math.round(targetWidth));
    let canvasHeight = Math.max(1, Math.round(targetHeight));
    if (!this.letterbox) {
      layout = { x: 0, y: 0, width: layout.width, height: layout.height };
      canvasWidth = layout.width;
      canvasHeight = layout.height;
    }
    this.current = layout;
    return { canvasWidth, canvasHeight, layout };
  }
}
