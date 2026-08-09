/**
 * Fractional-position, optionally-looped sample resampling — the one
 * primitive genuinely duplicated (n=2) across this framework's two existing
 * synthesis engines before this package existed: `@seer-project/smus`'s
 * `SmusEngine._renderVoice` and `@seer-project/tracker`'s
 * `Micromod.resample` (`packages/tracker/src/micromod.ts`) are independent
 * hand-rolled looped fractional-position readers with linear interpolation.
 * A third consumer (the SNES DSP's own 4-tap Gaussian interpolation, used by
 * AKAOSNES-family sound drivers) needs the same *shape* — advance a
 * fractional position through a possibly-looped sample buffer — with a
 * different kernel.
 *
 * `smus`'s own resampler is intentionally *not* rewritten to call this
 * (see the seer git history around this package's introduction): its loop
 * handling is entangled with per-sample vibrato-modulated step values and a
 * specific loop-boundary blend fixup that has its own regression test
 * (`consolidation-fixes.test.ts`), and swapping it was explicitly scoped as
 * optional/revert-if-it-changes-golden-output. This module's job is to be
 * the clean, well-specified primitive new consumers reach for — not to
 * force an existing consumer's quirks into it.
 */

/** Which interpolation kernel to use between sample positions. */
export type InterpolationKernel = 'nearest' | 'linear' | 'gaussian4';

/**
 * The SNES S-DSP's 512-entry Gaussian interpolation table (12-bit unsigned
 * values, 0-1305), used by `gaussian4`. Sourced from Mesen2's
 * `Core/SNES/DSP/DspInterpolation.h` (`SourMesen/Mesen2`, a cycle-accurate,
 * actively-maintained SNES emulator) — transcribed programmatically from
 * the real source file, not retyped by hand. Independently sanity-checked:
 * the 4 weights selected for any given fractional offset sum to ~2048
 * (unity gain after the `>>11`/`/2048` normalization every real DSP
 * implementation applies) at every offset checked, confirming both the
 * table values and the tap-selection formula in `gaussian4Tap` below are
 * consistent with each other.
 */
export const GAUSSIAN_TABLE: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
  2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 10,
  11, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 16, 16, 17, 17, 18, 19, 19, 20, 20, 21, 21, 22,
  23, 23, 24, 24, 25, 26, 27, 27, 28, 29, 29, 30, 31, 32, 32, 33, 34, 35, 36, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 59, 60, 61, 62, 64, 65, 66,
  67, 69, 70, 71, 73, 74, 76, 77, 78, 80, 81, 83, 84, 86, 87, 89, 90, 92, 94, 95, 97, 99, 100, 102,
  104, 106, 107, 109, 111, 113, 115, 117, 118, 120, 122, 124, 126, 128, 130, 132, 134, 137, 139,
  141, 143, 145, 147, 150, 152, 154, 156, 159, 161, 163, 166, 168, 171, 173, 175, 178, 180, 183,
  186, 188, 191, 193, 196, 199, 201, 204, 207, 210, 212, 215, 218, 221, 224, 227, 230, 233, 236,
  239, 242, 245, 248, 251, 254, 257, 260, 263, 267, 270, 273, 276, 280, 283, 286, 290, 293, 297,
  300, 304, 307, 311, 314, 318, 321, 325, 328, 332, 336, 339, 343, 347, 351, 354, 358, 362, 366,
  370, 374, 378, 381, 385, 389, 393, 397, 401, 405, 410, 414, 418, 422, 426, 430, 434, 439, 443,
  447, 451, 456, 460, 464, 469, 473, 477, 482, 486, 491, 495, 499, 504, 508, 513, 517, 522, 527,
  531, 536, 540, 545, 550, 554, 559, 563, 568, 573, 577, 582, 587, 592, 596, 601, 606, 611, 615,
  620, 625, 630, 635, 640, 644, 649, 654, 659, 664, 669, 674, 678, 683, 688, 693, 698, 703, 708,
  713, 718, 723, 728, 732, 737, 742, 747, 752, 757, 762, 767, 772, 777, 782, 787, 792, 797, 802,
  806, 811, 816, 821, 826, 831, 836, 841, 846, 851, 855, 860, 865, 870, 875, 880, 884, 889, 894,
  899, 904, 908, 913, 918, 923, 927, 932, 937, 941, 946, 951, 955, 960, 965, 969, 974, 978, 983,
  988, 992, 997, 1001, 1005, 1010, 1014, 1019, 1023, 1027, 1032, 1036, 1040, 1045, 1049, 1053, 1057,
  1061, 1066, 1070, 1074, 1078, 1082, 1086, 1090, 1094, 1098, 1102, 1106, 1109, 1113, 1117, 1121,
  1125, 1128, 1132, 1136, 1139, 1143, 1146, 1150, 1153, 1157, 1160, 1164, 1167, 1170, 1174, 1177,
  1180, 1183, 1186, 1190, 1193, 1196, 1199, 1202, 1205, 1207, 1210, 1213, 1216, 1219, 1221, 1224,
  1227, 1229, 1232, 1234, 1237, 1239, 1241, 1244, 1246, 1248, 1251, 1253, 1255, 1257, 1259, 1261,
  1263, 1265, 1267, 1269, 1270, 1272, 1274, 1275, 1277, 1279, 1280, 1282, 1283, 1284, 1286, 1287,
  1288, 1290, 1291, 1292, 1293, 1294, 1295, 1296, 1297, 1297, 1298, 1299, 1300, 1300, 1301, 1302,
  1302, 1303, 1303, 1303, 1304, 1304, 1304, 1304, 1304, 1305, 1305,
];

/**
 * 4-tap Gaussian-weighted sum for taps at integer sample indices
 * `i-1, i, i+1, i+2`, where `frac` (0..1) is the fractional distance past
 * `i`. `at(idx)` resolves an arbitrary integer index to a sample value —
 * callers supply the loop/one-shot boundary behaviour via `at`, this
 * function only does the weighting.
 *
 * Formula and index-symmetry (`255-offset`/`511-offset`/`256+offset`/`offset`)
 * per Mesen2's `DspInterpolation::Gauss` — see `GAUSSIAN_TABLE`'s doc
 * comment for provenance.
 */
function gaussian4Tap(i: number, frac: number, at: (idx: number) => number): number {
  const offset = Math.max(0, Math.min(255, Math.floor(frac * 256)));
  const g = GAUSSIAN_TABLE;
  const sum =
    g[255 - offset]! * at(i - 1) +
    g[511 - offset]! * at(i) +
    g[256 + offset]! * at(i + 1) +
    g[offset]! * at(i + 2);
  return sum / 2048;
}

/** Result of a `resampleLooped` call. */
export interface ResampleResult {
  /** Fractional source position after the call — feed back in as `pos` for the next call on the same voice. */
  pos: number;
  /** Number of output samples actually written (equals `count` unless a one-shot source ran out). */
  written: number;
  /** True if a one-shot (non-looped) source was exhausted during this call. Never true for a looped source. */
  ended: boolean;
}

/**
 * Advance a fractional read position through `src` by `step` per output
 * sample, writing `count` interpolated samples into `out` starting at
 * `outOffset`.
 *
 * Looping: `loopEnd > loopStart` loops the region `[loopStart, loopEnd)`
 * once the read position reaches `loopEnd` (wrapping via modulo, so a step
 * size that doesn't evenly divide the loop length still tracks phase
 * correctly across many wraps rather than re-snapping each time).
 * `loopEnd <= loopStart` means one-shot: playback simply stops (returning
 * `ended: true` and `written < count`) once the position would read past
 * `src.length`.
 */
export function resampleLooped(
  src: Float32Array,
  pos: number,
  step: number,
  loopStart: number,
  loopEnd: number,
  out: Float32Array,
  outOffset: number,
  count: number,
  kernel: InterpolationKernel,
): ResampleResult {
  const looped = loopEnd > loopStart;
  const loopLen = loopEnd - loopStart;

  const resolve = (idx: number): number => {
    if (looped) {
      if (idx < loopStart) return idx < 0 ? src[0]! : src[Math.min(idx, src.length - 1)]!;
      const wrapped = loopStart + ((((idx - loopStart) % loopLen) + loopLen) % loopLen);
      return src[wrapped]!;
    }
    if (idx < 0) return src[0]!;
    if (idx >= src.length) return src[src.length - 1]!;
    return src[idx]!;
  };

  let written = 0;
  let ended = false;
  for (let n = 0; n < count; n++) {
    if (!looped && pos >= src.length) {
      ended = true;
      break;
    }
    const i = Math.floor(pos);
    const frac = pos - i;

    let sample: number;
    if (kernel === 'nearest') {
      sample = resolve(i);
    } else if (kernel === 'linear') {
      sample = resolve(i) * (1 - frac) + resolve(i + 1) * frac;
    } else {
      sample = gaussian4Tap(i, frac, resolve);
    }

    out[outOffset + n] = sample;
    written++;
    pos += step;
    if (looped && pos >= loopEnd) {
      pos = loopStart + ((pos - loopStart) % loopLen);
    }
  }

  return { pos, written, ended };
}
