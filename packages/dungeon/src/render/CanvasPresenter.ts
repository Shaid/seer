/**
 * Presents an `IndexedSurface` to a 2D canvas context via `putImageData`.
 * This is the simplest presenter — no PixiJS `Application`, no WebGL — so
 * it's what the Node golden test and the browser harness both use, and
 * it's the natural isolation check when a render looks wrong: if
 * `CanvasPresenter` shows the same bug as `PixiPresenter`, the fault is in
 * the compositor, not the Pixi texture upload.
 */
import type { IndexedSurface } from '../raster/IndexedSurface.ts';
import { indicesToRGBA, type RGBAColor } from '../raster/palette.ts';

export class CanvasPresenter {
  private readonly ctx: CanvasRenderingContext2D;
  /**
   * Always `1` — `present()` blits at 1:1 canvas-pixel = surface-pixel, no
   * internal upscale (unlike `PixiPresenter`, which integer-scales its
   * sprite). Present for API symmetry with `PixiPresenter.scale`/
   * `toSurfacePoint`, e.g. a shared picking helper that accepts either
   * presenter. If the host additionally CSS-scales the `<canvas>` element
   * for display (as `tools/walker` does), converting a mouse event's CSS
   * pixel to a canvas pixel — via `canvas.width / canvas.getBoundingClientRect().width`
   * — is a separate, host-side concern this class has no way to see.
   */
  readonly scale = 1;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  /** Expand `surface` through `palette` and blit it to the canvas at (0, 0), 1:1. */
  present(surface: IndexedSurface, palette: RGBAColor[]): void {
    const rgba = indicesToRGBA(surface.data, palette);
    const imageData = new ImageData(rgba, surface.width, surface.height);
    this.ctx.putImageData(imageData, 0, 0);
  }

  /** Identity mapping (`scale` is always 1) — see the `scale` doc comment for what it does *not* account for. */
  toSurfacePoint(containerX: number, containerY: number): { x: number; y: number } {
    return { x: Math.floor(containerX), y: Math.floor(containerY) };
  }
}
