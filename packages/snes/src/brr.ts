/**
 * SNES S-DSP "BRR" (Bit Rate Reduced) sample codec — the hardware ADPCM-like
 * format every SNES game's sample-based instruments are stored in. Not
 * game-specific — a fixed piece of SNES hardware, shared machine knowledge
 * across every seer SNES project the same way `ppu.ts` is for tile
 * graphics.
 *
 * **Algorithm confirmed against a real, cycle-accurate SNES emulator's
 * source** (`SourMesen/Mesen2`, `Core/SNES/DSP/DspVoice.cpp`,
 * `DspVoice::DecodeBrrSample`) — the exact nibble sign-extension, per-filter
 * prediction formulas, and 16-bit clamp this file implements are transcribed
 * from that function, not from a written description or from memory. Every
 * `case` in `applyFilter` below corresponds 1:1 to a `case` in that
 * function's `switch(filter)`.
 *
 * **Correction, cross-validated against a second, independent source**: an
 * earlier version of this decoder stopped at the 16-bit clamp. Real
 * hardware does one more step Mesen2's own comment spells out directly --
 * *"clamped to 16 bits at the end and then clipped to 15 bits... This
 * 15-bit value is the value output and the value used as S(x-1) or S(x-2)"*
 * -- implemented as `_sampleBuffer[i] = Clamp16(s) * 2` into a real
 * `int16_t[12]` array (doubling a clamped value whose magnitude is
 * `>= 0x4000` overflows 16 bits and wraps, a genuine "sign error" quirk,
 * not a bug in either reference). `everything8215/ff6`'s own independent
 * `tools/brr.py` decoder (not derived from Mesen2) implements the exact
 * same net effect via an explicit 15-bit wraparound check -- two
 * independently-written decoders agreeing is why this is filed as
 * confirmed, not just plausible. See `decodeBrrBlock`'s inline comment for
 * the exact formula this file now uses.
 *
 * **Block format** (9 bytes: 1 header + 8 data = 16 4-bit samples):
 * header bit layout `SSSSFFLE` (MSB first) — bits 4-7 `shift` (0-15, `0-12`
 * normal, `13-15` forced to a fixed value per the DSP's own documented
 * clamp behaviour), bits 2-3 `filter` (0-3, selects one of 4 IIR
 * predictors), bit 1 `loop`, bit 0 `end`. Each data byte holds 2
 * samples — **high nibble first**, confirmed from `DecodeBrrSample`'s own
 * `samples[4]` array construction (`BrrData & 0xF0` before `BrrData & 0xF`).
 *
 * Deliberately NOT included here: any length-prefixed "blob" container
 * format for a run of consecutive BRR blocks. Real S-DSP hardware has no
 * such framing — voices reference raw BRR blocks directly via the DSP's
 * `DIR` table — so a driver's own ROM data convention for packaging BRR
 * data (a length prefix, a directory of pointers, etc.) belongs in that
 * driver's own module, built on `decodeBrrBlock` below.
 */

export const BRR_BLOCK_SIZE = 9;
export const BRR_SAMPLES_PER_BLOCK = 16;

export interface BrrBlockHeader {
  /** 0-15. 0-12 shift the sign-extended nibble normally; 13-15 force a fixed value regardless of the nibble's magnitude. */
  shift: number;
  /** 0-3, selects one of 4 fixed IIR predictors (0 = none). */
  filter: 0 | 1 | 2 | 3;
  /** True if playback should restart at this sample's loop point once this block finishes — real hardware resolves the actual restart address via the DSP's own `DIR`-table loop address, not from anything in the bitstream itself. */
  loop: boolean;
  /** True if this is the last block of the sample's stored data. */
  end: boolean;
}

export function decodeBrrHeader(headerByte: number): BrrBlockHeader {
  return {
    shift: (headerByte >> 4) & 0xf,
    filter: ((headerByte >> 2) & 0x3) as 0 | 1 | 2 | 3,
    loop: (headerByte & 0x2) !== 0,
    end: (headerByte & 0x1) !== 0,
  };
}

/** Sign-extend a 4-bit nibble (0-15) to a signed integer in [-8, 7]. */
function signExtend4(nibble: number): number {
  return nibble >= 8 ? nibble - 16 : nibble;
}

function clamp16(v: number): number {
  if (v < -32768) return -32768;
  if (v > 32767) return 32767;
  return v;
}

/** Reinterpret the low 16 bits of `v` as a signed 16-bit integer (standard truncating narrowing conversion, matching C++'s `int16_t` assignment). Used for the real hardware's own doubled-sample wraparound, see `decodeBrrBlock`'s doc comment. */
function wrapToInt16(v: number): number {
  return ((v & 0xffff) << 16) >> 16;
}

/**
 * Apply one of the DSP's 4 fixed IIR predictors to a shift-scaled residual
 * `s`, given the two previously-decoded (post-wraparound-halved) samples.
 * Formulas transcribed verbatim from `DspVoice::DecodeBrrSample`'s
 * `switch(filter)`.
 */
function applyFilter(filter: 0 | 1 | 2 | 3, s: number, prev1: number, prev2: number): number {
  switch (filter) {
    case 0:
      return s;
    case 1:
      return s + prev1 + ((-prev1) >> 4);
    case 2:
      return s + (prev1 << 1) + ((-((prev1 << 1) + prev1)) >> 5) - prev2 + (prev2 >> 4);
    case 3:
      return (
        s + (prev1 << 1) + ((-(prev1 + (prev1 << 2) + (prev1 << 3))) >> 6) - prev2 + (((prev2 << 1) + prev2) >> 4)
      );
  }
}

export interface DecodedBrrBlock {
  header: BrrBlockHeader;
  /** 16 decoded 16-bit-range signed samples (the real, doubled-and-wrapped hardware output -- see the module doc comment). */
  samples: Int16Array;
  /** Feed directly as the next block's `prev1`/`prev2` params -- already halved (`outputSample >> 1`), matching the real filter-prediction input, **not** equal to `samples[14]`/`samples[15]` (see the module doc comment on the doubling/wraparound). */
  prev1: number;
  prev2: number;
}

/** Decode one 9-byte BRR block (`block[0]` = header, `block[1..8]` = 8 data bytes = 16 nibbles). `prev1`/`prev2` are the previous block's returned `prev1`/`prev2` (already the halved filter-feedback form, not raw output samples -- 0, 0 for the very first block of a sample). */
export function decodeBrrBlock(block: Uint8Array, prev1: number, prev2: number): DecodedBrrBlock {
  const header = decodeBrrHeader(block[0]!);
  const samples = new Int16Array(BRR_SAMPLES_PER_BLOCK);
  let p1 = prev1;
  let p2 = prev2;
  for (let i = 0; i < BRR_SAMPLES_PER_BLOCK; i++) {
    const byte = block[1 + (i >> 1)]!;
    const nibble = i % 2 === 0 ? (byte >> 4) & 0xf : byte & 0xf;
    const signed = signExtend4(nibble);
    let s: number;
    if (header.shift <= 12) {
      s = (signed << header.shift) >> 1;
    } else {
      s = signed < 0 ? -0x800 : 0;
    }
    // Real hardware (`_sampleBuffer[i] = Clamp16(s) * 2`, `_sampleBuffer` is `int16_t[12]`) doubles
    // the clamped prediction and stores it through a 16-bit-wide assignment -- for a clamped value
    // whose magnitude is >= 0x4000, doubling it overflows int16 range and wraps (a real, documented
    // hardware quirk: "clamped to 16 bits... then clipped to 15 bits... can result in sign error"),
    // NOT just a x2 gain. This wrapped-and-doubled value is both the actual output sample AND (after
    // an exact >>1 to undo the doubling) the feedback fed to the next sample's filter prediction --
    // an earlier version of this decoder used the plain `clamp16(...)` value for both, silently
    // dropping this wraparound and running every prediction one nibble further from real hardware's
    // actual decode than it should have been.
    const outputSample = wrapToInt16(clamp16(applyFilter(header.filter, s, p1, p2)) * 2);
    samples[i] = outputSample;
    p2 = p1;
    p1 = outputSample >> 1;
  }
  return { header, samples, prev1: p1, prev2: p2 };
}
