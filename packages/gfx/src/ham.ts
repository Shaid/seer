/**
 * Amiga OCS/ECS "Hold-And-Modify" (HAM6) pixel decode.
 *
 * HAM6 spends all 6 bitplanes (64 raw pixel values) not on 64 palette
 * slots but on a *mode* + *payload* pair per pixel: most values modify one
 * RGB channel of the previous pixel's colour rather than select a whole
 * new colour, which is how a 6-bitplane OCS/ECS screen renders far more
 * than 64 distinct colours (up to the full 4096-colour 12-bit gamut).
 *
 * Standard OCS/ECS bit layout — verified against Reunion (Amiga OCS/ECS
 * floppy release, `methanoid` project)'s `ATALK/ATVEZETO.0xx` story
 * slideshow frames: a code-confirmed 16-colour-per-frame palette table
 * decoded under this exact scheme renders 14/14 frames as clean,
 * artifact-free full-colour scenes (vs. speckled red/blue noise when the
 * same raw 6-bit values are mis-read as plain 64-colour Extra-Half-Brite
 * indices):
 *
 * - top 2 bits (bits 5-4 of the raw value) select the mode:
 *   - `00` — direct colour select: the low 4 bits index a 16-colour base
 *     palette (`COLOR00`-`COLOR15`), replacing R, G and B all at once.
 *   - `01` — modify **Blue**: the low 4 bits become the new 4-bit blue
 *     channel; red and green are held from the previous pixel.
 *   - `10` — modify **Red**: same, for the red channel.
 *   - `11` — modify **Green**: same, for the green channel.
 * - Each scanline starts fresh from the base palette's colour 0
 *   (`COLOR00`) — HAM state does not carry across rows.
 */
import { expandColorWord } from './palette.js';

export interface Ham6Options {
  /** 16-colour base palette, raw OCS/ECS `0x0RGB` words (`COLOR00`-`COLOR15`, in that order). */
  palette16: ArrayLike<number>;
}

/**
 * Decode one frame of 6-bit HAM pixel values (row-major, `width * height`
 * bytes, each `0`-`63` — only the low 6 bits are read) to flat 8-bit RGB
 * bytes (`width * height * 3`, no alpha).
 */
export function decodeHam6(indices: Uint8Array, width: number, height: number, opts: Ham6Options): Uint8Array {
  const base: Array<[number, number, number]> = [];
  for (let i = 0; i < 16; i++) base.push(expandColorWord(opts.palette16[i] ?? 0, 'amiga12'));

  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    let [r, g, b] = base[0];
    const rowIn = y * width;
    for (let x = 0; x < width; x++) {
      const v = indices[rowIn + x] & 0x3f;
      const mode = (v >> 4) & 3;
      const payload = (v & 0xf) * 17;
      if (mode === 0) [r, g, b] = base[v & 0xf];
      else if (mode === 1) b = payload;
      else if (mode === 2) r = payload;
      else g = payload;
      const o = (rowIn + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}
