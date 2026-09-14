/**
 * AKAOSNES sound-driver-specific helpers layered on top of this package's
 * hardware primitives. Neither of these is real S-DSP hardware — they're
 * this driver family's own conventions, confirmed byte-identical across two
 * independent AKAOSNES-driven consumers (Final Fantasy IV/V/VI and Chrono
 * Trigger), which is why they're bundled here as a small, separately
 * documented module rather than mixed into the hardware-primitive files
 * (`brr.ts`, `envelope.ts`, etc). A driver family's note-to-pitch/tuning
 * formula and BRR-blob container convention are generally NOT hardware and
 * do not belong in a hardware package — this module is the one exception
 * that earned its way in by being genuinely shared, not derived.
 */

import { decodeBrrBlock } from './brr.js';

/**
 * The real driver's 12-entry per-semitone pitch table (ARAM `$178F`, file
 * offset `0x051C9F`), dumped directly from the live uploaded `SPCCode`
 * blob during a from-scratch SPC700 disassembly (see
 * `docs/ffvi/snes/data-structure.md` §18.9 for the full trace) — not
 * derived or guessed. Index 11 is exactly `0x1000` — the SNES DSP's own
 * native "unity pitch" register constant — confirming these are equal-
 * tempered semitone steps (ratio ≈ 2^(1/12) between entries) referenced to
 * `absNote === 59` (`octave2 === 4, semitone === 11`) as the driver's
 * zero-detune point.
 */
export const PITCH_TABLE: readonly number[] = [
  0x0879, 0x08fa, 0x0983, 0x0a14, 0x0aad, 0x0b50, 0x0bfc, 0x0cb2, 0x0d74, 0x0e41, 0x0f1a, 0x1000,
];

/** The DSP pitch register's native "unity" (unmodified) playback-rate value -- `PITCH_TABLE[11]`. */
export const PITCH_UNITY = 0x1000;

/**
 * Convert a played note (an absolute semitone number, e.g. AKAOSNES V4's
 * `octave*12 + noteIndex + transpose` — see
 * `docs/ffvi/snes/data-structure.md` §18.2) and an instrument's raw tuning
 * byte into a resample step (samples of source consumed per output
 * sample), for a BRR sample stored at the DSP's native 32000 Hz rate.
 *
 * **Traced from the real SPC700 driver code, not a third-party
 * reimplementation** (§18.9 has the full byte-level trace; ARAM `$0554`,
 * file `0x050A64`).
 *
 * Real algorithm, integer-exact per the trace:
 * ```
 * absNote = note - 10
 * semitone = absNote mod 12 (0-11); octave2 = floor(absNote / 12)
 * pitchBase = PITCH_TABLE[semitone]
 * tuningSum = (tuning1 + tuningOffset) & 0xFF   -- tuningOffset from the TUNING VCMD, default 0
 * scaled = hi(pitchBase)*tuningSum + floor(lo(pitchBase)*tuningSum / 256)
 * scaled += floor((tuning2 * hi(scaled)) / 256)  -- the source's second-byte correction
 * scaled += (tuningSum has bit7 set ? 0 : pitchBase)
 * finalPitch = scaled * 2^(octave2 - 4)
 * ```
 * The final add condition is literal in the source: `ADC A,$F760+X`,
 * `PUSH PSW`, then `POP PSW`/`BMI` around the add. It therefore uses the
 * saved sign flag of the 8-bit tuning sum, represented here by bit 7 of
 * `tuningSum`.
 */
export function noteToResampleStep(note: number, tuning1: number, tuningOffset = 0, tuning2 = 0): number {
  const absNote = note - 10;
  const octave2 = Math.floor(absNote / 12);
  const semitone = absNote - octave2 * 12; // floor-division remainder, always 0-11 (JS `%` would stay negative for negative absNote)
  const pitchBase = PITCH_TABLE[semitone]!;
  const tuningSumRaw = tuning1 + tuningOffset;
  const tuningSum = tuningSumRaw & 0xff;
  const hi = pitchBase >> 8;
  const lo = pitchBase & 0xff;
  // CalcFreq's two MUL/add-word stages are 16-bit SPC arithmetic. The
  // second tuning byte is consumed as the high-byte correction below.
  let scaled = (hi * tuningSum + ((lo * tuningSum) >> 8)) & 0xffff;
  scaled = (scaled + Math.floor(((tuning2 & 0xff) * (scaled >> 8)) / 256)) & 0xffff;
  if ((tuningSum & 0x80) === 0) scaled = (scaled + pitchBase) & 0xffff;
  const finalPitch = scaled * Math.pow(2, octave2 - 4);
  return finalPitch / PITCH_UNITY;
}

const BRR_BLOCK_SIZE = 9;
const BRR_SAMPLES_PER_BLOCK = 16;

export interface DecodedBrrBlob {
  /** Flat decoded PCM, one Int16-range sample per BRR nibble, in block order across the whole blob. */
  pcm: Int16Array;
  /** Number of 9-byte blocks decoded. */
  blockCount: number;
}

/**
 * Decode a full length-prefixed BRR blob (this driver's confirmed
 * AKAOSNES blob format, independently confirmed against the real ROM —
 * see `docs/ffvi/snes/data-structure.md` §18.3): each of AKAOSNES's sample
 * blobs (`SampleBRRPtrs`) is a 2-byte little-endian length prefix followed
 * by that many bytes of raw 9-byte BRR blocks — a driver ROM-data
 * convention, not anything real S-DSP hardware has (hardware just
 * addresses raw BRR blocks via the `DIR` table).
 *
 * Filter prediction (`prev1`/`prev2`) carries continuously across block
 * boundaries in one linear pass — matching real hardware decode order,
 * and sufficient for an offline decode-once-then-loop player (the loop
 * *point* is a `SampleLoopStart`-derived sample index into this flat
 * buffer, resolved by the caller — see `akao-samples.ts` — not a
 * mid-stream restart-address jump the way the live DSP hardware itself
 * would apply it).
 */
export function decodeBrrBlob(rom: Uint8Array, fileOffset: number): DecodedBrrBlob {
  const length = rom[fileOffset]! | (rom[fileOffset + 1]! << 8);
  if (length % BRR_BLOCK_SIZE !== 0) {
    throw new RangeError(`BRR blob at file offset 0x${fileOffset.toString(16)}: length ${length} is not a multiple of ${BRR_BLOCK_SIZE}`);
  }
  const blockCount = length / BRR_BLOCK_SIZE;
  const pcm = new Int16Array(blockCount * BRR_SAMPLES_PER_BLOCK);
  let p1 = 0;
  let p2 = 0;
  const dataStart = fileOffset + 2;
  for (let b = 0; b < blockCount; b++) {
    const block = rom.subarray(dataStart + b * BRR_BLOCK_SIZE, dataStart + (b + 1) * BRR_BLOCK_SIZE);
    const decoded = decodeBrrBlock(block, p1, p2);
    pcm.set(decoded.samples, b * BRR_SAMPLES_PER_BLOCK);
    p1 = decoded.prev1;
    p2 = decoded.prev2;
  }
  return { pcm, blockCount };
}
