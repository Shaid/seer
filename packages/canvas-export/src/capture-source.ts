/**
 * The seam that makes capture asset-agnostic — anything with a canvas and
 * (optionally) a way to guarantee its pixels are current can be
 * screenshotted or recorded through this package, whether it's a 3D mesh
 * viewport, a 2D sprite canvas, or a WebGL2 shader pass.
 */
export interface CaptureSource {
  /**
   * The canvas to capture.
   *
   * MUST be implemented as a getter, not a captured reference, for any
   * host that replaces its canvas element on redraw (a 2D sprite viewer
   * that does `canvasWrap.innerHTML = ''` and rebuilds a fresh `<canvas>`
   * per frame is the concrete case this guards against) — a `CaptureSource`
   * built once with a plain field would otherwise hold a detached node.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * Ensures `canvas`'s pixels are current before a synchronous read.
   * Required for any WebGL source that doesn't set `preserveDrawingBuffer`
   * — without it, `toBlob()`/`toDataURL()` can read an already-cleared or
   * about-to-be-swapped buffer instead of the last rendered frame.
   *
   * Omit only for a source whose buffer is always already current when
   * read (e.g. a Canvas2D context, which has no separate front/back
   * buffer to go stale).
   *
   * CONTRACT: callers MUST read the canvas synchronously after calling
   * this — no intervening `await`, no yielding to the event loop. A
   * subsequent render (this source's own render loop, or an unrelated
   * one sharing the GL context) can overwrite the buffer before a delayed
   * read gets to it.
   */
  renderNow?(): void;
}
