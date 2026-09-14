/**
 * Sega "System 16" family tile-graphics + palette-word decoders.
 *
 * Covers System 16A/16B (and siblings sharing the same Sega tilemap/palette
 * hardware — System 18, Out Run family, etc.) — not just Golden Axe. Browser
 * + Node safe (no platform-specific imports), so both `tools/` (offline
 * pipeline) and `src/` (runtime engine/viewer) can share it.
 *
 * Ground truth for this module: MAME's committed source
 * (`src/mame/sega/segas16b.cpp`, `src/mame/sega/segaic16.cpp`), fetched and
 * cross-checked against `data/goldenaxe/sys16/goldnaxe.zip` during the
 * initial goldenaxe/sys16 RE pass — see
 * `docs/goldenaxe/sys16/data-structure.md` for the full evidence trail and
 * confidence labels. Summary:
 *
 *  - Tile ROM decode (`decodeSega16Tiles8x8`): MAME's `GFXDECODE_ENTRY(
 *    "tiles", 0, gfx_8x8x3_planar, 0, 1024)` (segas16b.cpp) is CONFIRMED for
 *    Golden Axe's "tiles" ROM region (CRC32-exact match to the shipped
 *    dump). The exact byte/bit arithmetic this function implements (N full
 *    bitplanes, one per equal RGN_FRAC(1,N) share of the ROM data, 8
 *    bytes/tile/plane, MSB-first pixel bit within each row byte) was
 *    reconstructed from ROM byte-count arithmetic and the standard MAME
 *    "N-plane planar, no interleave" convention rather than the literal
 *    `gfx_layout` struct (not located in the portion of MAME source
 *    fetched this session) — but is now CONFIRMED at the pixel level too:
 *    rendering all 16384 tiles from `data/goldenaxe/sys16/goldnaxe.zip`
 *    with this function reproduces perfectly legible English text ("MAGIC:",
 *    a full A-Z alphabet strip, "...his brother was killed... Death Adder")
 *    and Japanese katakana, plus coherent background/character art — not
 *    achievable by chance from a wrong plane order, bit order, or tile
 *    size. See docs/goldenaxe/sys16/data-structure.md for the render.
 *
 *  - Palette word decode (`decodeSega16PaletteWord`): the bit layout is
 *    CONFIRMED verbatim from `sega_16bit_common_base::paletteram_w` in
 *    segaic16.cpp (Golden Axe uses this default, not a philko/hangon
 *    override) — and independently cross-checked bit-for-bit against
 *    Charles MacDonald's community System 16B hardware notes ("D15: Shade
 *    hi/lo, D14: Blue bit 0, D13: Green bit 0, D12: Red bit 0, D11-D8: Blue
 *    bits 4-1, ...", https://jammarcade.net/images/2024/04/s16b.txt,
 *    fetched during the goldenaxe/sys16 maincpu-disassembly pass) — two
 *    independent sources (MAME's emulator source and a hand-written
 *    hardware-notes doc) agree exactly. The RGB *scale* is now CONFIRMED
 *    too: `computeResistorWeights()` is a direct, generic port of MAME's
 *    `compute_resistor_weights()` (`src/emu/video/resnet.cpp`, fetched raw
 *    and grepped this pass — not summarized), driven with the exact
 *    per-bit resistor values `segaic16.cpp`'s constructor uses for the
 *    "normal" (non-shadow/non-hilight) palette pen: `{3900, 2000, 1000,
 *    500, 250, 0}` ohms for bits 0-4 plus the always-off shadow/hilight
 *    tristate bit. `combineWeights()` ports `combine_weights()`
 *    (`src/emu/video/resnet.h`: `T(sum_of(weight[i]*bit[i]) + 0.5)`,
 *    i.e. round-half-up truncation) exactly. In practice this
 *    binary-weighted ladder is very close to linear (a genuine property of
 *    binary-weighted — as opposed to R-2R — resistor DACs), so the two
 *    curves agree for most of the 32-entry range and differ by exactly 1
 *    LSB at a handful of values (e.g. 5-bit index 11: DAC gives 91, linear
 *    approximation gave 90) — this is what "byte-exact" actually looks
 *    like here, not a dramatic re-color. The shadow/hilight resistor set
 *    (`{3900, 2000, 1000, 500, 250, 470}`, selected per-pixel at render
 *    time by palette-RAM bit 15 and the tile/sprite priority flags) is not
 *    modeled — this module always returns the "normal" pen, matching what
 *    `paletteram_w` writes to `offset + 0*m_palette_entries` unconditionally,
 *    which is what every static-ROM asset in this pipeline uses (there is
 *    no priority-flag data available to select the shadow/hilight pen from
 *    a flat ROM dump).
 *
 *  - Sprite pixel decode (`decodeSega16Sprites4bpp`): CONFIRMED against the
 *    same MacDonald hardware notes ("Sprite pattern data is arranged as
 *    groups of words, within each word every four bits defines one pixel...
 *    MSB          LSB / aaaabbbbccccdddd") — 4 bits/pixel, 4 pixels per
 *    16-bit big-endian word, MSB-first. Pixel value 0 is transparent; 15 is
 *    an end-of-line marker (also transparent) that on real hardware stops a
 *    sprite's per-line variable-width strip renderer — this module does not
 *    model that renderer (it has no access to runtime sprite-attribute RAM,
 *    which is not present anywhere in the static ROM dump), so it decodes
 *    the raw nibble stream only, with 0 and 15 left as ordinary palette
 *    indices for the caller to treat as transparent if desired. See
 *    docs/goldenaxe/sys16/data-structure.md "sprites" for the full 16-byte
 *    sprite-RAM attribute record layout (also from MacDonald's notes) and
 *    why it can't be applied without a live/emulator capture.
 */

/** One decoded 8x8 tile sheet: flat tile-major palette-index buffer. */
export interface DecodedTileSheet {
  /** Palette-index bytes, tile-major then row-major then column-major (length = tileCount * tileWidth * tileHeight). */
  indices: Uint8Array;
  tileCount: number;
  tileWidth: number;
  tileHeight: number;
}

/**
 * Decode an 8x8 Sega System 16-family tile ROM region: `planes` full,
 * non-interleaved bitplanes concatenated back-to-back (one plane per
 * physical ROM chip on real hardware), 8 bytes per tile per plane (one byte
 * per pixel row), bit 7 = leftmost pixel of that row in every plane.
 *
 * Pixel value = plane bits combined LSB-first by plane index (plane 0 is
 * bit 0 of the resulting index, matching MAME's GFXDECODE `{ RGN_FRAC(0,n),
 * RGN_FRAC(1,n), ... }` plane order for this family).
 *
 * `data.length` need not be an exact multiple of `planes * 8` — any
 * trailing remainder bytes are ignored (mirrors MAME silently truncating a
 * partial final tile).
 */
export function decodeSega16Tiles8x8(data: Uint8Array, planes: number): DecodedTileSheet {
  const planeSize = Math.floor(data.length / planes);
  const tileCount = Math.floor(planeSize / 8);
  const indices = new Uint8Array(tileCount * 64);

  for (let t = 0; t < tileCount; t++) {
    for (let row = 0; row < 8; row++) {
      const rowBytes: number[] = new Array(planes);
      for (let p = 0; p < planes; p++) {
        rowBytes[p] = data[p * planeSize + t * 8 + row] ?? 0;
      }
      for (let col = 0; col < 8; col++) {
        let pixel = 0;
        for (let p = 0; p < planes; p++) {
          const bit = (rowBytes[p] >> (7 - col)) & 1;
          pixel |= bit << p;
        }
        indices[t * 64 + row * 8 + col] = pixel;
      }
    }
  }

  return { indices, tileCount, tileWidth: 8, tileHeight: 8 };
}

/**
 * Decode a Sega System 16-family sprite ROM region into a flat 4-bit
 * pixel-index stream (one byte per pixel, values 0-15).
 *
 * Each 16-bit big-endian word packs 4 pixels MSB-first
 * (`aaaabbbbccccdddd`). `data.length` need not be a multiple of 2; any
 * trailing odd byte is ignored. This is a raw unpack only — it does not
 * apply sprite-attribute geometry (start address/pitch/zoom/end-markers),
 * since that lives in runtime sprite RAM, not the ROM. Pixel value 0 is
 * transparent and 15 is a line-end marker on real hardware (see the module
 * doc comment); this function leaves both as plain index values.
 */
export function decodeSega16Sprites4bpp(data: Uint8Array): Uint8Array {
  const wordCount = Math.floor(data.length / 2);
  const out = new Uint8Array(wordCount * 4);
  for (let w = 0; w < wordCount; w++) {
    const word = (data[w * 2] << 8) | data[w * 2 + 1];
    out[w * 4 + 0] = (word >> 12) & 0xf;
    out[w * 4 + 1] = (word >> 8) & 0xf;
    out[w * 4 + 2] = (word >> 4) & 0xf;
    out[w * 4 + 3] = word & 0xf;
  }
  return out;
}

/** RGB triple in 0-255 range. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Generic port of MAME's `compute_resistor_weights()`
 * (`src/emu/video/resnet.cpp`), restricted to the single-network,
 * no-pulldown/no-pullup case (the only case Sega's System 16-family palette
 * DAC setup uses). For each resistor `k`, models a voltage divider where
 * resistor `k` alone is pulled to Vcc (contributing `1/resistanceK` to the
 * "high" side) and every other resistor is pulled to ground (contributing
 * to the "low" side), then scales every resistor's computed single-bit
 * output so the sum across all resistors being "on" simultaneously lands
 * exactly on `maxval` (MAME's autoscale, `scaler < 0`).
 */
export function computeResistorWeights(minval: number, maxval: number, resistancesOhms: readonly number[]): number[] {
  const n = resistancesOhms.length;
  const w = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    let r0inv = 1 / 1e12; // no pulldown resistor -> near-infinite resistance to ground
    let r1inv = 1 / 1e12; // no pullup resistor -> near-infinite resistance to Vcc
    for (let j = 0; j < n; j++) {
      if (resistancesOhms[j] === 0) continue;
      if (j === k) r1inv += 1 / resistancesOhms[j];
      else r0inv += 1 / resistancesOhms[j];
    }
    const r0 = 1 / r0inv;
    const r1 = 1 / r1inv;
    const vout = ((maxval - minval) * r0) / (r1 + r0) + minval;
    w[k] = Math.min(maxval, Math.max(minval, vout));
  }
  const maxOut = w.reduce((a, b) => a + b, 0);
  const scale = maxval / maxOut;
  return w.map((x) => x * scale);
}

/** Port of MAME's `combine_weights()` (`src/emu/video/resnet.h`): `T(sum(weight[i] * bit[i]) + 0.5)`. */
export function combineWeights(weights: readonly number[], bits: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i] * bits[i];
  return Math.floor(sum + 0.5);
}

/**
 * CONFIRMED per-bit resistor values for the "normal" (non-shadow/hilight)
 * System 16-family palette pen, verbatim from `sega_16bit_common_base`'s
 * constructor (`src/mame/sega/segaic16.cpp`): bits 0-4 use 3900/2000/1000/
 * 500/250 ohm resistors; the 6th slot is the shadow/hilight tristate bit,
 * which is always 0 (disconnected) for the normal pen.
 */
const NORMAL_PEN_RESISTANCES_OHMS = [3900, 2000, 1000, 500, 250, 0] as const;

/** Precomputed 0-255 weight per resistor (index 0-4 = colour bits 0-4; index 5 = always-off tristate bit), matching MAME's boot-time `compute_resistor_weights` call exactly. */
const NORMAL_PEN_WEIGHTS = computeResistorWeights(0, 255, NORMAL_PEN_RESISTANCES_OHMS);

/** Precomputed 5-bit (0-31) -> 8-bit (0-255) DAC lookup table for the "normal" palette pen. */
const NORMAL_PEN_LUT: readonly number[] = Array.from({ length: 32 }, (_, v) =>
  combineWeights(NORMAL_PEN_WEIGHTS, [v & 1, (v >> 1) & 1, (v >> 2) & 1, (v >> 3) & 1, (v >> 4) & 1, 0])
);

/**
 * Decode one Sega System 16-family palette RAM word into 8-bit RGB.
 *
 * CONFIRMED bit layout (`sega_16bit_common_base::paletteram_w`,
 * src/mame/sega/segaic16.cpp): `sBGR BBBB GGGG RRRR` — bit 15 selects
 * shadow/hilight (not modeled here — this always returns the "normal"
 * color, matching what real hardware writes to the base palette pen
 * unconditionally), bits 14/13/12 are an extra low-order bit for B/G/R
 * respectively, bits 11-8/7-4/3-0 are the B/G/R nibbles.
 *
 * CONFIRMED RGB scale: each reconstructed 5-bit channel value (0-31) is
 * looked up in `NORMAL_PEN_LUT`, MAME's real non-linear (binary-weighted
 * resistor-ladder) DAC curve — see the module doc comment and
 * `computeResistorWeights`/`combineWeights` above for the derivation.
 */
export function decodeSega16PaletteWord(word: number): RGB {
  const r5 = ((word >> 12) & 0x01) | ((word << 1) & 0x1e);
  const g5 = ((word >> 13) & 0x01) | ((word >> 3) & 0x1e);
  const b5 = ((word >> 14) & 0x01) | ((word >> 7) & 0x1e);
  return { r: NORMAL_PEN_LUT[r5], g: NORMAL_PEN_LUT[g5], b: NORMAL_PEN_LUT[b5] };
}
