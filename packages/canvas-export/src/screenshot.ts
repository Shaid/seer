import type { CaptureSource } from './capture-source.js';
import { createCanvas2D, downloadBlob } from './dom-download.js';

/**
 * Watermark text is entirely host-supplied — this package never builds the
 * branding string itself, since what belongs in it (asset name, game,
 * platform, project) is data only the host's viewer has.
 */
export interface WatermarkOptions {
  text: string;
  /** Corner the watermark anchors to. Default `'bottom-right'`. */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** CSS font shorthand. Default `'12px sans-serif'`. */
  font?: string;
  /** Text fill color. Default `'rgba(255,255,255,0.85)'`. */
  color?: string;
  /** Backing pill color behind the text, for legibility over any image.
   *  Default `'rgba(0,0,0,0.45)'`. Pass `null` to omit the pill entirely. */
  backgroundColor?: string | null;
  /** Margin from the chosen corner, in CSS pixels at 1x scale (scaled up
   *  with everything else when `composeCaptureCanvas`'s `scale` > 1).
   *  Default `12`. */
  margin?: number;
}

const DEFAULT_WATERMARK: Required<Omit<WatermarkOptions, 'text'>> = {
  position: 'bottom-right',
  font: '12px sans-serif',
  color: 'rgba(255,255,255,0.85)',
  backgroundColor: 'rgba(0,0,0,0.45)',
  margin: 12,
};

/**
 * Draws `opts.text` into the bottom/top-left/right corner of a `width` ×
 * `height` canvas context, with an optional backing pill for legibility.
 * Pure drawing — caller owns the canvas/context lifecycle.
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: WatermarkOptions,
): void {
  const { text, position, font, color, backgroundColor, margin } = {
    ...DEFAULT_WATERMARK,
    ...opts,
  };
  if (!text) return;

  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;
  // Approximate text height from font-size digits in the shorthand (e.g.
  // "12px sans-serif" -> 12) rather than parsing the shorthand properly —
  // good enough for a padding pill, not used for anything precise.
  const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(font);
  const fontSize = sizeMatch ? parseFloat(sizeMatch[1]) : 12;
  const textHeight = fontSize * 1.2;

  const padX = 6;
  const padY = 4;
  const boxWidth = textWidth + padX * 2;
  const boxHeight = textHeight + padY * 2;

  let boxX: number;
  let boxY: number;
  if (position === 'bottom-right') {
    boxX = width - margin - boxWidth;
    boxY = height - margin - boxHeight;
  } else if (position === 'bottom-left') {
    boxX = margin;
    boxY = height - margin - boxHeight;
  } else if (position === 'top-right') {
    boxX = width - margin - boxWidth;
    boxY = margin;
  } else {
    boxX = margin;
    boxY = margin;
  }

  if (backgroundColor) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
  }

  ctx.fillStyle = color;
  ctx.fillText(text, boxX + padX, boxY + boxHeight - padY - (textHeight - fontSize));
  ctx.restore();
}

export interface CaptureOptions {
  watermark?: WatermarkOptions;
  /** Output scale relative to the source canvas's own pixel dimensions.
   *  Default `1` (no scaling). */
  scale?: number;
}

/**
 * Composes a capture-ready canvas from `source`: calls `source.renderNow()`
 * if present, then draws the source canvas (scaled if requested) plus an
 * optional watermark into a fresh canvas and returns it.
 *
 * Identity fast-path: with no watermark and `scale` of `1` (or omitted),
 * this returns `source.canvas` directly rather than copying — the caller
 * gets a live reference to the actual rendering canvas in that case, not a
 * snapshot, which is fine for the synchronous `toBlob()`/`toDataURL()` call
 * a caller is expected to make immediately after (per `CaptureSource`'s
 * contract) but NOT safe to hold onto past the next render.
 */
export function composeCaptureCanvas(
  source: CaptureSource,
  opts: CaptureOptions = {},
): HTMLCanvasElement {
  source.renderNow?.();
  const { watermark, scale = 1 } = opts;

  if (!watermark && scale === 1) {
    return source.canvas;
  }

  const width = Math.round(source.canvas.width * scale);
  const height = Math.round(source.canvas.height * scale);
  const { canvas: out, ctx } = createCanvas2D(width, height, 'composeCaptureCanvas');

  ctx.drawImage(source.canvas, 0, 0, width, height);
  if (watermark) {
    drawWatermark(ctx, width, height, watermark);
  }
  return out;
}

/** Captures `source` (with optional watermark/scale) as a PNG `Blob`. */
export function captureBlob(source: CaptureSource, opts: CaptureOptions = {}): Promise<Blob> {
  const canvas = composeCaptureCanvas(source, opts);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('captureBlob: toBlob produced no blob'));
    }, 'image/png');
  });
}

/**
 * Captures `source` and triggers a browser download named `filename`
 * (`.png` appended if not already present). Revokes the object URL after
 * the click, on a timeout long enough for the download to have started in
 * every browser this project supports.
 */
export async function downloadScreenshot(
  source: CaptureSource,
  filename: string,
  opts: CaptureOptions = {},
): Promise<void> {
  const blob = await captureBlob(source, opts);
  downloadBlob(blob, filename.endsWith('.png') ? filename : `${filename}.png`);
}
