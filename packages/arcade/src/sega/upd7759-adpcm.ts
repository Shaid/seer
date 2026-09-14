/**
 * NEC uPD7759 ADPCM Speech Processor decoder — the chip's own on-die state
 * machine, ported byte-for-byte from MAME's `upd775x_device`
 * (`src/devices/sound/upd7759.{h,cpp}`, BSD-3-Clause, Juergen Buchmueller /
 * Mike Balfour / Howie Cohen / Olivier Galibert / Aaron Giles).
 *
 * Not proprietary and not game-specific — the uPD7759 (and its
 * mask-rom-only siblings 55/56/57/58) is a commodity late-80s/early-90s
 * arcade speech/sample chip, used across many Sega/Capcom/etc titles
 * (Golden Axe's YM2151+uPD7759 sound board is one instance). This module
 * decodes the chip's ADPCM block-header grammar; it does not model the
 * chip's real-time DRQ/NMI handshake pacing (irrelevant for an offline
 * decode — see the module doc below for what the pacing bytes are for).
 *
 * ## The block-header grammar (from MAME's own doc comment)
 *
 *     00000000                    sample end
 *     00dddddd                    silence, duration = (d+1) * 1024 clocks
 *     01ffffff                    send the 256 following nibbles to the converter
 *     10ffffff nnnnnnnn           send the n+1 following nibbles to the converter
 *     11---rrr --ffffff nnnnnnnn  send the n+1 following nibbles, repeat r+1 times
 *
 * "ffffff" (the header's low 6 bits) sets the nibble clock rate: each
 * nibble's decoded value is held for `(ffffff+1) * 4` ticks of the chip's
 * native processing clock (`deviceClock / 4` — 160 kHz for the standard
 * 640 kHz uPD7759 clock). If the nibble count is odd, the stream stays
 * byte-aligned by leaving the last (never-decoded) nibble of the final
 * byte unread — see `decodeUpd7759Slave()`'s nibble loop.
 *
 * ## Standalone vs. slave mode, and the 5-byte slave preamble
 *
 * In "standalone" (master) mode the chip reads this grammar directly out
 * of its own ROM, addressed via a `nn 5a a5 69 55` + 2-byte-MSB-first
 * offset-table header at the ROM's start. In "slave" mode (the mode Golden
 * Axe's Z80 driver selects at boot — see docs/goldenaxe/sys16/
 * data-structure.md § "soundcpu — Z80 sound driver / uPD7759 speech") the
 * chip's ROM reader is disconnected entirely; the *driving CPU* streams
 * bytes into the chip's input port one at a time (each DRQ pulse fires an
 * NMI that pushes the next byte), and the chip consumes whatever byte is
 * currently latched whenever its internal clock reaches the next
 * consuming state. Golden Axe's NMI handler (`$0066` in `epr-12390.ic8`)
 * is a dumb byte-streamer with zero awareness of chip state — it just
 * pushes sequential bytes from a tracked ROM pointer — so the *first five*
 * bytes of every sample get silently consumed/discarded by non-data
 * priming states in the chip's own startup sequence
 * (`STATE_LAST_SAMPLE`/`STATE_DUMMY1`/`STATE_ADDR_MSB`/`STATE_ADDR_LSB`/
 * `STATE_DUMMY2` in MAME's `advance_state()`) before the 6th byte is ever
 * treated as the first real block header. Empirically confirmed: all 20
 * Golden Axe uPD7759 samples begin with the literal byte pattern
 * `FF 00 00 00 00 <header> ...` — matching MAME source comment's "the
 * first command is always 0xFF" note for slave mode, and skipping exactly
 * 5 bytes lands cleanly on a real block header in every case (see
 * `tools/goldenaxe/upd7759-phrases.ts` for the corpus-wide verification:
 * all 20 samples self-terminate on a natural `0x00` end header, strictly
 * inside their own 0x4000-byte ROM bank, 0/20 overruns).
 *
 * `decodeUpd7759Slave()` takes the RAW sample-start offset (pointing at
 * that leading `0xFF`) and skips the 5-byte preamble internally, so
 * callers don't need to know about it.
 */

// upd775x_step[state][nibble] -- per-nibble signal delta, MAME's exact table.
const STEP: readonly (readonly number[])[] = [
  [0, 0, 1, 2, 3, 5, 7, 10, 0, 0, -1, -2, -3, -5, -7, -10],
  [0, 1, 2, 3, 4, 6, 8, 13, 0, -1, -2, -3, -4, -6, -8, -13],
  [0, 1, 2, 4, 5, 7, 10, 15, 0, -1, -2, -4, -5, -7, -10, -15],
  [0, 1, 3, 4, 6, 9, 13, 19, 0, -1, -3, -4, -6, -9, -13, -19],
  [0, 2, 3, 5, 8, 11, 15, 23, 0, -2, -3, -5, -8, -11, -15, -23],
  [0, 2, 4, 7, 10, 14, 19, 29, 0, -2, -4, -7, -10, -14, -19, -29],
  [0, 3, 5, 8, 12, 16, 22, 33, 0, -3, -5, -8, -12, -16, -22, -33],
  [1, 4, 7, 10, 15, 20, 29, 43, -1, -4, -7, -10, -15, -20, -29, -43],
  [1, 4, 8, 13, 18, 25, 35, 53, -1, -4, -8, -13, -18, -25, -35, -53],
  [1, 6, 10, 16, 22, 31, 43, 64, -1, -6, -10, -16, -22, -31, -43, -64],
  [2, 7, 12, 19, 27, 37, 51, 76, -2, -7, -12, -19, -27, -37, -51, -76],
  [2, 9, 16, 24, 34, 46, 64, 96, -2, -9, -16, -24, -34, -46, -64, -96],
  [3, 11, 19, 29, 41, 57, 79, 117, -3, -11, -19, -29, -41, -57, -79, -117],
  [4, 13, 24, 36, 50, 69, 96, 143, -4, -13, -24, -36, -50, -69, -96, -143],
  [4, 16, 29, 44, 62, 85, 118, 175, -4, -16, -29, -44, -62, -85, -118, -175],
  [6, 20, 36, 54, 76, 104, 144, 214, -6, -20, -36, -54, -76, -104, -144, -214],
] as const;

// upd775x_state_table[nibble] -- per-nibble ADPCM state-index adjustment.
const STATE_TABLE = [-1, -1, 0, 0, 1, 2, 2, 3, -1, -1, 0, 0, 1, 2, 2, 3] as const;

/** Number of leading slave-mode priming bytes discarded before the first real block header (see module doc). */
export const UPD7759_SLAVE_PREAMBLE_BYTES = 5;

/** Native chip processing rate for the standard 640 kHz uPD7759 clock (clock / 4). */
export const UPD7759_STANDARD_CLOCK = 640_000;
export const UPD7759_NATIVE_RATE = UPD7759_STANDARD_CLOCK / 4; // 160000 Hz

/**
 * Default output gain. The chip's internal `m_sample` accumulator is a
 * genuine int16 (no clamp beyond 16-bit wraparound in MAME's own
 * `update_adpcm`), but real speech data stays in a much smaller range in
 * practice -- Golden Axe's 20 confirmed samples peak at 132-255. This gain
 * brings that observed range up towards full 16-bit scale without
 * clipping (255 * 96 = 24480, within [-32768,32767]); tune per-corpus if a
 * sibling game's samples run hotter.
 */
export const UPD7759_DEFAULT_GAIN = 96;

function wrapInt16(v: number): number {
  return (v << 16) >> 16;
}

/** Persistent ADPCM decode state (mirrors `upd775x_device`'s `m_sample`/`m_adpcm_state`). */
export class Upd7759AdpcmState {
  sample = 0; // int16, wraps on overflow (matches the real device's plain int16_t member)
  adpcmState = 0; // 0..15

  reset(): void {
    this.sample = 0;
    this.adpcmState = 0;
  }

  /** Decode one 4-bit nibble, updating state, and return the new signal value. */
  clock(nibble: number): number {
    nibble &= 0xf;
    this.sample = wrapInt16(this.sample + STEP[this.adpcmState][nibble]);
    this.adpcmState += STATE_TABLE[nibble];
    if (this.adpcmState < 0) this.adpcmState = 0;
    else if (this.adpcmState > 15) this.adpcmState = 15;
    return this.sample;
  }
}

export interface Upd7759DecodeResult {
  /** 16-bit PCM samples at `UPD7759_NATIVE_RATE` (160000 Hz for the standard clock), one value per held tick. */
  pcm: Int16Array;
  /** ROM offset one past the sample's terminating `0x00` header (or the scan limit, if the stream never terminated). */
  endOffset: number;
  /** True if a natural `0x00`-after-a-valid-header terminator was found before hitting `maxBytes`. */
  terminatedCleanly: boolean;
}

/**
 * Decode one uPD7759 slave-mode sample: a raw ROM byte range beginning
 * with the 5-byte priming preamble (see module doc), followed by the
 * standard block-header ADPCM grammar, ending at a `0x00` header once a
 * real header has been seen. Byte-for-byte port of MAME's
 * `upd775x_device::advance_state()`'s `STATE_BLOCK_HEADER` /
 * `STATE_NIBBLE_COUNT` / `STATE_NIBBLE_MSN` / `STATE_NIBBLE_LSN` cases,
 * expanded from "one decoded value per nibble" to "one PCM sample per
 * held tick" (`sampleRate * 4` ticks per nibble, `1024 * duration` ticks
 * per silence block) so relative timing between differently-rated blocks
 * in the same stream is preserved, exactly as the real chip holds its DAC
 * output between ADPCM clocks.
 *
 * `startOffset` points at the sample's leading `0xFF` (the phrase-table
 * offset), not at the first real header — the preamble skip happens here.
 */
export function decodeUpd7759Slave(rom: Uint8Array, startOffset: number, gain = UPD7759_DEFAULT_GAIN, maxBytes = 0x20000): Upd7759DecodeResult {
  let pos = startOffset + UPD7759_SLAVE_PREAMBLE_BYTES;
  const limit = Math.min(rom.length, startOffset + maxBytes);
  const state = new Upd7759AdpcmState();
  const ticks: number[] = [];
  let firstValidHeader = false;
  let repeatCount = 0;
  let repeatOffset = 0;
  let terminatedCleanly = false;

  const pushHeld = (value: number, count: number) => {
    for (let i = 0; i < count; i++) ticks.push(value);
  };

  while (pos < limit) {
    if (repeatCount > 0) {
      repeatCount--;
      pos = repeatOffset;
    }
    const header = rom[pos++];
    const kind = header & 0xc0;

    if (kind === 0x00) {
      // Silence: (d+1) * 1024 native-clock ticks of a reset (zero) signal.
      const durTicks = ((header & 0x3f) + 1) * 1024;
      state.reset();
      pushHeld(0, durTicks);
      if (header === 0 && firstValidHeader) {
        terminatedCleanly = true;
        break;
      }
    } else if (kind === 0x40 || kind === 0x80) {
      const sampleRate = (header & 0x3f) + 1;
      let nibbles: number;
      if (kind === 0x40) {
        nibbles = 256;
      } else {
        if (pos >= limit) break;
        nibbles = rom[pos++] + 1;
      }
      const ticksPerNibble = sampleRate * 4;
      for (let i = 0; i < nibbles; i++) {
        if (pos >= limit) break;
        const byte = rom[pos];
        const nibble = i % 2 === 0 ? byte >> 4 : byte & 0xf;
        if (i % 2 === 1) pos++;
        const value = state.clock(nibble);
        pushHeld(value, ticksPerNibble);
      }
      if (nibbles % 2 === 1) pos++; // odd nibble count: last nibble of the final byte is never read, but stays byte-aligned
    } else {
      // 0xc0: repeat loop. r+1 repeats of the byte range starting right after
      // this header. MAME's own advance_state() does NOT special-case what
      // that next byte is -- it just returns to STATE_BLOCK_HEADER and lets
      // the *generic* header dispatch (the same `header & 0xc0` switch above)
      // read it on the next iteration, same as this port does. The grammar
      // comment's "11---rrr --ffffff nnnnnnnn" shorthand describes the
      // authored ROM-data convention (a repeat header is normally followed by
      // an 0x80-kind rate+count block), not a distinct parsing rule -- if a
      // ROM's authored data broke that convention MAME would decode it
      // exactly as this port does (whatever kind the next header's top bits
      // say), not specially. UNEXERCISED by any of Golden Axe's 20 confirmed
      // samples (none use a 0xc0 header) -- flag for a closer look if this
      // decoder is ever reused on a game whose samples do hit this path.
      repeatCount = (header & 7) + 1;
      repeatOffset = pos;
      // MAME: 36 native-clock ticks transitional cost, holding whatever the current signal is.
      pushHeld(state.sample, 36);
    }

    if (header !== 0) firstValidHeader = true;
  }

  const pcm = new Int16Array(ticks.length);
  for (let i = 0; i < ticks.length; i++) {
    let v = Math.round(ticks[i] * gain);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    pcm[i] = v;
  }

  return { pcm, endOffset: pos, terminatedCleanly };
}
