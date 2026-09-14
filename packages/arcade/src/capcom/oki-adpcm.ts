/**
 * OKI MSM6295 4-bit ADPCM ("Dialogic/VOX-family" ADPCM) decoder + the
 * chip's phrase-table (sample directory) reader.
 *
 * Not proprietary and not game-specific — the MSM6295 is a commodity
 * arcade sample-playback chip used across dozens of late-80s/early-90s
 * Capcom/Konami/Data East/etc titles. This module is a straight,
 * byte-for-byte port of MAME's own `oki_adpcm_state` (`src/devices/sound/
 * okiadpcm.h`/`.cpp`, BSD-3-Clause, Andrew Gardner & Aaron Giles) via
 * vgmtrans's already-ported C++ copy (`vgmtrans/src/main/formats/common/
 * OkiAdpcm.{h,cpp}` — same MAME algorithm, already known-good against real
 * commercial ROMs across vgmtrans's whole CPS1 game library, not just one
 * title). Originally verified against Knights of the Round's (CPS1) own
 * `oki` ROM region; the `CPS1_*` constants below are that game-family's
 * empirically-tuned tuning values, kept alongside the chip decoder since
 * they're the reason this lives under `capcom/` rather than a
 * platform-neutral location.
 *
 * Browser + Node safe (no platform-specific imports).
 */

// step_index adjustment per nibble's low 3 bits, per the OKI/Dialogic table.
const INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8] as const;

// diffLookup[step*16 + nibble] precomputed exactly like MAME's compute_tables().
const DIFF_LOOKUP = computeDiffLookup();

function computeDiffLookup(): Int32Array {
  const nbl2bit = [
    [1, 0, 0, 0], [1, 0, 0, 1], [1, 0, 1, 0], [1, 0, 1, 1],
    [1, 1, 0, 0], [1, 1, 0, 1], [1, 1, 1, 0], [1, 1, 1, 1],
    [-1, 0, 0, 0], [-1, 0, 0, 1], [-1, 0, 1, 0], [-1, 0, 1, 1],
    [-1, 1, 0, 0], [-1, 1, 0, 1], [-1, 1, 1, 0], [-1, 1, 1, 1],
  ];
  const table = new Int32Array(49 * 16);
  for (let step = 0; step <= 48; step++) {
    const stepval = Math.floor(16.0 * Math.pow(11.0 / 10.0, step));
    for (let nib = 0; nib < 16; nib++) {
      const [sign, b1, b2, b3] = nbl2bit[nib];
      table[step * 16 + nib] =
        sign * (stepval * b1 + Math.floor(stepval / 2) * b2 + Math.floor(stepval / 4) * b3 + Math.floor(stepval / 8));
    }
  }
  return table;
}

/** Persistent decode state for one ADPCM stream (OKI's `oki_adpcm_state`). */
export class OkiAdpcmState {
  signal = 0;
  step = 0;

  reset(): void {
    this.signal = 0;
    this.step = 0;
  }

  /** Decode one 4-bit nibble, updating state, and return the new signed 12-bit-range sample. */
  clock(nibble: number): number {
    nibble &= 0xf;
    this.signal += DIFF_LOOKUP[this.step * 16 + nibble];
    if (this.signal > 2047) this.signal = 2047;
    else if (this.signal < -2048) this.signal = -2048;

    this.step += INDEX_SHIFT[nibble & 7];
    if (this.step > 48) this.step = 48;
    else if (this.step < 0) this.step = 0;

    return this.signal;
  }
}

/**
 * Decode a raw OKI MSM6295 ADPCM byte stream (as stored in the sample ROM,
 * one phrase's [start, end] byte range) into 16-bit PCM. Each byte holds
 * two 4-bit nibbles, high nibble first (matches MAME/vgmtrans's
 * `byte >> (((n & 1) << 2) ^ 4)`, n=0 -> shift 4, n=1 -> shift 0).
 *
 * `gain` defaults to 1.0 (raw chip output, -2048..2047 range i.e. ~12-bit).
 * vgmtrans's CPS1 profile amplifies by 11.0x before clamping to 16-bit
 * full scale (`CPS1_OKI_GAIN`) since the raw signal only spans ~12 bits of
 * a 16-bit buffer — pass `gain: 11.0` for parity with that reference
 * decode when producing a normally-loud PCM buffer.
 */
export function decodeOkiAdpcm(bytes: Uint8Array, gain = 1.0): Int16Array {
  const state = new OkiAdpcmState();
  const out = new Int16Array(bytes.length * 2);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    for (let half = 0; half < 2; half++) {
      const nibble = (byte >> (((half & 1) << 2) ^ 4)) & 0xf;
      const sample = state.clock(nibble);
      const amplified = sample * gain;
      out[n++] = Math.max(-32768, Math.min(32767, Math.round(amplified)));
    }
  }
  return out;
}

/** MSM6295 native output rate at CPS1's board clock: 1 MHz / 132, rounded (matches vgmtrans's `CPS1_OKIMSM6295_SAMPLE_RATE`). */
export const CPS1_OKI_SAMPLE_RATE = 7576;

/** vgmtrans's empirically-tuned amplification factor for CPS1's OKI channel (raw ~12-bit signal -> comfortable 16-bit PCM level). */
export const CPS1_OKI_GAIN = 11.0;

export interface OkiPhrase {
  /** Phrase/command number (1-127; 0 is reserved/unused on real hardware). */
  phrase: number;
  /** Byte offset of the first ADPCM byte within the OKI sample ROM region. */
  start: number;
  /** Byte offset one past the last ADPCM byte (exclusive), i.e. `end + 1` of the inclusive hardware field. */
  end: number;
}

/**
 * Parse the standard MSM6295 phrase table: 128 fixed 8-byte entries at the
 * start of the sample ROM (phrase 0 reserved/unused; phrases 1-127 each
 * give a 3-byte big-endian start address + 3-byte big-endian *inclusive*
 * end address, followed by 2 unused bytes). An entry is "empty" when its
 * first 2 bytes are 0xFFFF or 0 (matches vgmtrans's `CPS1SampColl::
 * parseSampleInfo()`, itself the real hardware's own addressing
 * convention — not CPS1-specific).
 */
export function parseOkiPhraseTable(rom: Uint8Array): OkiPhrase[] {
  const phrases: OkiPhrase[] = [];
  for (let phrase = 1; phrase < 128; phrase++) {
    const off = phrase * 8;
    if (off + 8 > rom.length) break;
    const sampAddr = (rom[off] << 8) | rom[off + 1];
    if (sampAddr === 0xffff || sampAddr === 0) continue;
    const start = (rom[off] << 16) | (rom[off + 1] << 8) | rom[off + 2];
    const endInclusive = (rom[off + 3] << 16) | (rom[off + 4] << 8) | rom[off + 5];
    const end = endInclusive > start ? endInclusive + 1 : start;
    phrases.push({ phrase, start, end });
  }
  return phrases;
}
