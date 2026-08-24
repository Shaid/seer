/**
 * Amiga colour-word expansion.
 *
 * Two wire formats cover OCS/ECS and AGA:
 * - `amiga12`: one 16-bit word `0x0RGB` (OCS/ECS COLORxx registers,
 *   ILBM CMAP-derived tables) — each nibble scales ×17 to 8 bits.
 * - `amiga24`: one 32-bit longword `0x00RRGGBB` (AGA `LoadRGB32` wire
 *   format) — already 8 bits per channel.
 */

export type ColorWordFormat = 'amiga12' | 'amiga24';

/** Expand one colour word to a 24-bit `[r, g, b]` triple. */
export function expandColorWord(word: number, format: ColorWordFormat): [number, number, number] {
  if (format === 'amiga12') {
    return [((word >> 8) & 0xf) * 17, ((word >> 4) & 0xf) * 17, (word & 0xf) * 17];
  }
  return [(word >> 16) & 0xff, (word >> 8) & 0xff, word & 0xff];
}

/**
 * Expand an array of colour words to a flat `[r, g, b, r, g, b, …]` palette,
 * the shape `indicesToRGBA` consumes.
 */
export function expandPalette(words: ArrayLike<number>, format: ColorWordFormat): number[] {
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) out.push(...expandColorWord(words[i], format));
  return out;
}

/**
 * Even greyscale ramp across `2 ** planes` levels as a flat RGB palette.
 *
 * A labelled **placeholder**, not a decoded palette — the default render
 * for bitmaps whose real colour table hasn't been independently confirmed
 * yet ("only apply colour once the palette is independently confirmed").
 * Never treat output built from this as colour-confirmed.
 */
export function greyscaleRamp(planes: number): number[] {
  if (!Number.isInteger(planes) || planes < 1 || planes > 8) {
    throw new Error(`greyscaleRamp: planes must be an integer in [1, 8], got ${planes}`);
  }
  const count = 1 << planes;
  const rgb: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = Math.round((i * 255) / Math.max(1, count - 1));
    rgb.push(v, v, v);
  }
  return rgb;
}
