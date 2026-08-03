/**
 * Expands an `IndexedSurface`'s palette-index framebuffer to interleaved
 * RGBA bytes, using whatever palette produced those indices (typically a
 * `PieceBank`'s derived local palette, but any `RGBAColor[]` works — e.g.
 * a future runtime accent-ramp palette per the walker plan's
 * `cyclePalette` integration).
 */

export interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Index 0 is reserved, by convention, as the surface-background sentinel:
 * every `IndexedSurface` starts cleared to 0, and `PieceBank.fromRGBA`
 * never assigns a real atlas color to it. Rendered as opaque black.
 */
export const BACKGROUND_COLOR: RGBAColor = { r: 0, g: 0, b: 0, a: 255 };

/**
 * Expand an index buffer to `Uint8ClampedArray` RGBA bytes (the shape both
 * `ImageData` and a PixiJS `BufferImageSource` want). An index with no
 * matching palette entry renders as opaque black — defensive; a correctly
 * built `PieceBank` palette never produces one.
 */
export function indicesToRGBA(indices: Uint8Array, palette: RGBAColor[]): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const c = palette[indices[i] as number] ?? BACKGROUND_COLOR;
    const o = i * 4;
    out[o] = c.r;
    out[o + 1] = c.g;
    out[o + 2] = c.b;
    out[o + 3] = c.a;
  }
  return out;
}
