/**
 * Palette indices → RGBA bytes.
 */

export interface IndicesToRGBAOptions {
  /**
   * Which palette index renders fully transparent. `null` (the default)
   * makes every pixel opaque. Explicitly `number | null` rather than a
   * boolean or an implicit 0: index 0 is a real opaque colour (usually
   * black) in many of these games, so transparency must be opted into per
   * call, never assumed.
   */
  transparentIndex?: number | null;
  /** Optional 1-bit mask plane (1 byte per pixel, non-zero = opaque). Overrides `transparentIndex`. */
  mask?: Uint8Array;
}

/**
 * Convert one palette-index byte per pixel into RGBA. `palette` is a flat
 * `[r, g, b, …]` array (see `expandPalette`/`greyscaleRamp`); indices past
 * its end render black.
 */
export function indicesToRGBA(
  indices: Uint8Array,
  palette: number[],
  opts: IndicesToRGBAOptions = {},
): Uint8Array {
  const { transparentIndex = null, mask } = opts;
  const out = new Uint8Array(indices.length * 4);

  for (let i = 0; i < indices.length; i++) {
    const c = indices[i];
    const ci = c * 3;
    const o = i * 4;
    out[o] = palette[ci] ?? 0;
    out[o + 1] = palette[ci + 1] ?? 0;
    out[o + 2] = palette[ci + 2] ?? 0;
    if (mask) out[o + 3] = mask[i] ? 255 : 0;
    else out[o + 3] = transparentIndex !== null && c === transparentIndex ? 0 : 255;
  }
  return out;
}
