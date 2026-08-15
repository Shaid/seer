/**
 * Tiny RGBA raster canvas for probe artifacts — byte plots, ribbons,
 * contact sheets, spectrograms, captions. Pure in-memory; commands hand
 * the finished `rgba` to `@seer-project/pipeline`'s `writePNG`.
 */

import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphFor } from './font.js';

export type RGB = readonly [number, number, number];

export interface Canvas {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export function createCanvas(width: number, height: number, fill: RGB = [0, 0, 0]): Canvas {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = fill[0];
    rgba[i * 4 + 1] = fill[1];
    rgba[i * 4 + 2] = fill[2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

export function setPixel(c: Canvas, x: number, y: number, color: RGB): void {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const o = (y * c.width + x) * 4;
  c.rgba[o] = color[0];
  c.rgba[o + 1] = color[1];
  c.rgba[o + 2] = color[2];
  c.rgba[o + 3] = 255;
}

export function fillRect(c: Canvas, x: number, y: number, w: number, h: number, color: RGB): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) setPixel(c, xx, yy, color);
  }
}

/** Copy an RGBA image (e.g. a decoded bitmap from @seer-project/gfx) onto the canvas, clipping at the edges. */
export function blitRGBA(
  c: Canvas,
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dx: number,
  dy: number,
): void {
  for (let y = 0; y < srcHeight; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= c.height) continue;
    for (let x = 0; x < srcWidth; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= c.width) continue;
      const s = (y * srcWidth + x) * 4;
      const d = (ty * c.width + tx) * 4;
      c.rgba[d] = src[s];
      c.rgba[d + 1] = src[s + 1];
      c.rgba[d + 2] = src[s + 2];
      c.rgba[d + 3] = 255;
    }
  }
}

/** Render caption text at (x, y) with the inline 5×7 font. Returns the pixel width drawn. */
export function drawText(
  c: Canvas,
  x: number,
  y: number,
  text: string,
  color: RGB,
  scale = 1,
): number {
  let cx = x;
  for (const ch of text) {
    const glyph = glyphFor(ch);
    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (glyph[gy][gx] !== '#') continue;
        fillRect(c, cx + gx * scale, y + gy * scale, scale, scale, color);
      }
    }
    cx += (GLYPH_WIDTH + 1) * scale;
  }
  return cx - x;
}

/** Map a 0..1 value to a heat colour (black → blue → magenta → yellow → white). */
export function heatColor(v: number): RGB {
  const t = Math.max(0, Math.min(1, v));
  if (t < 0.25) return [0, 0, Math.round((t / 0.25) * 255)];
  if (t < 0.5) return [Math.round(((t - 0.25) / 0.25) * 255), 0, 255];
  if (t < 0.75) return [255, Math.round(((t - 0.5) / 0.25) * 255), Math.round(255 - ((t - 0.5) / 0.25) * 255)];
  return [255, 255, Math.round(((t - 0.75) / 0.25) * 255)];
}
