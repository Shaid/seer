/**
 * Colour grading via the Canvas 2D context's own `ctx.filter` property —
 * *not* the CSS/DOM `style.filter` property. `ctx.filter` is a real
 * pixel-level operation applied during `drawImage`, so it is identical
 * between the live preview and anything `toBlob()`/a recorder captures.
 * `style.filter` is compositor-level only and would not appear in an
 * export. Callers set `ctx.filter = buildGradingFilterString(opts)` before
 * each `ctx.drawImage(...)` in their draw path.
 */
export interface GradingOptions {
  /** Default `1` (no change). */
  brightness?: number;
  /** Default `1` (no change). */
  contrast?: number;
  /** Default `1` (no change). */
  saturate?: number;
  /** Degrees. Default `0` (no change). */
  hueRotate?: number;
}

const DEFAULT_GRADING: Required<GradingOptions> = {
  brightness: 1,
  contrast: 1,
  saturate: 1,
  hueRotate: 0,
};

/**
 * Builds a `ctx.filter` value from `opts`. Returns the literal `'none'`
 * when every parameter is at its neutral default, so callers can compare
 * against `'none'` to skip setting `ctx.filter` entirely on the common
 * ungraded path.
 */
export function buildGradingFilterString(opts: GradingOptions = {}): string {
  const { brightness, contrast, saturate, hueRotate } = {
    ...DEFAULT_GRADING,
    ...opts,
  };
  if (brightness === 1 && contrast === 1 && saturate === 1 && hueRotate === 0) {
    return 'none';
  }
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturate}) hue-rotate(${hueRotate}deg)`;
}

/** Feature-detects `ctx.filter` support (unsupported on Safari < 18.0). */
export function isCtxFilterSupported(ctx: CanvasRenderingContext2D): boolean {
  return 'filter' in ctx;
}
