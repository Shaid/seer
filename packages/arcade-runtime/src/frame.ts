/**
 * The indexed-framebuffer contract between a board renderer and a presenter,
 * plus the pure maths both presenters share.
 *
 * A board renders palette *indices*, as the hardware did: every pixel is an
 * index into palette RAM, and the palette is resolved only at presentation.
 * That keeps a palette fade or flash a palette write rather than a redraw,
 * and lets a regression test hash the indices without any colour maths.
 */

/** One rendered frame: a palette index per pixel, row-major, top-left origin. */
export interface IndexedFrame {
  width: number;
  height: number;
  /** `width * height` palette indices. */
  pixels: Uint16Array;
}

/**
 * A resolved palette: 4 bytes (R, G, B, A) per entry, so entry `i` starts at
 * byte `i * 4`. Use `paletteEntries()` for the entry count.
 */
export type RgbaPalette = Uint8Array;

export function paletteEntries(palette: RgbaPalette): number {
  return palette.length >>> 2;
}

export function createIndexedFrame(width: number, height: number): IndexedFrame {
  return { width, height, pixels: new Uint16Array(width * height) };
}

export interface IndexedToRgbaOptions {
  /** Write the palette's alpha instead of forcing 255. Default `false`. */
  keepAlpha?: boolean;
  /** Reused output buffer of at least `width * height * 4` bytes. */
  out?: Uint8ClampedArray;
}

/**
 * CPU reference conversion of an indexed frame to RGBA bytes, ready for
 * `new ImageData(...)` or a PNG writer. The WebGL presenter's shader
 * produces the same colours: alpha forced opaque, and an index past the end
 * of the palette drawn as opaque black.
 */
export function indexedToRgba(frame: IndexedFrame, palette: RgbaPalette, opts: IndexedToRgbaOptions = {}): Uint8ClampedArray {
  const { width, height, pixels } = frame;
  const count = width * height;
  if (pixels.length < count) throw new Error(`arcade-runtime: frame has ${pixels.length} pixels, expected ${count}`);
  const out = opts.out ?? new Uint8ClampedArray(count * 4);
  if (out.length < count * 4) throw new Error('arcade-runtime: indexedToRgba out buffer too small');
  const entries = paletteEntries(palette);
  const keepAlpha = opts.keepAlpha ?? false;
  for (let i = 0, o = 0; i < count; i++, o += 4) {
    const idx = pixels[i]!;
    if (idx < entries) {
      const p = idx << 2;
      out[o] = palette[p]!;
      out[o + 1] = palette[p + 1]!;
      out[o + 2] = palette[p + 2]!;
      out[o + 3] = keepAlpha ? palette[p + 3]! : 255;
    } else {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Palette textures are laid out this many entries per row. */
export const PALETTE_TEXTURE_WIDTH = 256;

export interface PackedPalette {
  /** RGBA8 texels, `width * height * 4` bytes. */
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Lays a palette out as a 256-wide RGBA8 texture (entry `i` at texel
 * `(i & 255, i >> 8)`), since a 1-row texture would exceed
 * `MAX_TEXTURE_SIZE` for a large palette (CPS2 has 0xC00+ entries; a 16-bit
 * index can reach 65536). Alpha is forced to 255, and the padding past the
 * last entry is opaque black, matching `indexedToRgba`.
 */
export function packPaletteTexture(palette: RgbaPalette, out?: Uint8Array): PackedPalette {
  const entries = paletteEntries(palette);
  const width = PALETTE_TEXTURE_WIDTH;
  const height = Math.max(1, Math.ceil(entries / width));
  const size = width * height * 4;
  const data = out && out.length === size ? out : new Uint8Array(size);
  data.set(palette.subarray(0, entries * 4));
  for (let o = 3; o < entries * 4; o += 4) data[o] = 255;
  for (let o = entries * 4; o < size; o += 4) {
    data[o] = 0;
    data[o + 1] = 0;
    data[o + 2] = 0;
    data[o + 3] = 255;
  }
  return { data, width, height };
}

/**
 * How the frame fills the presenter's target area:
 * - `'integer'` — the largest whole-number vertical scale that fits (at
 *   least 1), so every source row is the same height; the horizontal size
 *   follows from the pixel aspect ratio.
 * - `'fit'` — the largest fractional scale that keeps the aspect ratio.
 * - `'fill'` — stretch to the whole target, aspect ratio ignored.
 */
export type ScaleMode = 'integer' | 'fit' | 'fill';

export interface LayoutOptions {
  /** Source frame size in pixels. */
  width: number;
  height: number;
  /** Target area in device pixels. */
  targetWidth: number;
  targetHeight: number;
  mode?: ScaleMode;
  /** Width / height of one source pixel on the original monitor, default `1`. */
  pixelAspect?: number;
}

/** Where the frame lands inside the target, in whole device pixels. */
export interface FrameLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the destination rectangle for a frame, centred in the target.
 * Every output value is an integer, so the GL viewport and the 2D
 * `drawImage` rectangle land on the pixel grid.
 */
export function computeLayout(opts: LayoutOptions): FrameLayout {
  const { width, height, targetWidth, targetHeight } = opts;
  const mode = opts.mode ?? 'integer';
  const par = opts.pixelAspect ?? 1;
  if (!(par > 0)) throw new Error(`arcade-runtime: pixelAspect must be > 0 (got ${par})`);
  if (mode === 'fill') return { x: 0, y: 0, width: Math.max(1, Math.round(targetWidth)), height: Math.max(1, Math.round(targetHeight)) };

  // Display-space size of the frame at scale 1.
  const srcW = width * par;
  const srcH = height;
  let outW: number;
  let outH: number;
  if (mode === 'integer') {
    const n = Math.max(1, Math.floor(Math.min(targetWidth / srcW, targetHeight / srcH)));
    outH = height * n;
    outW = Math.round(srcW * n);
  } else {
    const s = Math.min(targetWidth / srcW, targetHeight / srcH);
    outW = Math.max(1, Math.round(srcW * s));
    outH = Math.max(1, Math.round(srcH * s));
  }
  return {
    x: Math.floor((targetWidth - outW) / 2),
    y: Math.floor((targetHeight - outH) / 2),
    width: outW,
    height: outH,
  };
}

/**
 * The pixel aspect ratio of a `width`×`height` frame shown full-screen on a
 * monitor of `displayAspect` (default 4:3). Black Tiger's 256×224 visible
 * area gives `(4/3) / (256/224) = 7/6`; pass `3/4` for a rotated
 * (vertical) monitor.
 */
export function pixelAspectForDisplay(width: number, height: number, displayAspect = 4 / 3): number {
  return displayAspect / (width / height);
}
