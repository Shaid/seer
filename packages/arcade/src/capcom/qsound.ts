/**
 * Capcom QSound (DL-1425, a WEDSP16A-M14 DSP16A core) sample decoder + the
 * Z80 sound driver's command-mailbox protocol constants.
 *
 * Ground truth is MAME's own `qsound_device` (`src/devices/sound/
 * qsound.cpp`), a modern low-level emulation (LLE) that actually runs the
 * chip's internal DSP16A microcode ROM — since the *real* hardware itself
 * does all the sample decoding/mixing/filtering inside that DSP program,
 * MAME's device model necessarily reproduces the DSP's own external-ROM
 * read path byte-for-byte, which is what this module ports.
 *
 * PCM sample format (`qsound_device::dsp_sample_r()`):
 *   "on CPS2, bit 0-7 of external ROM data is tied to ground" — i.e. the
 *   chip's external ROM data bus is only 8 bits wide even though the DSP
 *   addresses a nominal 16-bit sample space; the raw ROM byte is placed in
 *   the *upper* 8 bits of that 16-bit word, with the low 8 bits fixed at
 *   zero (`return u16(byte) << 8;`). Since everything downstream (the
 *   DSP's own filter/mix math, and MAME's own `m_samples[]` -> float
 *   conversion `sample_t(m_samples[ch]) * (1.0/32768.0)`) treats a 16-bit
 *   sample as *signed*, `u16(byte) << 8` read back as a signed 16-bit
 *   value is arithmetically identical to: reinterpret the raw ROM byte as
 *   a standard two's-complement **signed 8-bit** sample, then scale to
 *   16-bit by multiplying by 256 (`<< 8`). This is confirmed two ways for
 *   real ddsom/ddtod `qsound` ROM data (not just read off the C++ source):
 *
 *   1. Byte-value means cluster near 127-128 in every sampled ROM region
 *      regardless of interpretation (an inherent property of any
 *      byte-vs-byte±128 reinterpretation of the same bipolar signal, not
 *      discriminating on its own).
 *   2. Sample-to-sample delta (a smoothness proxy — real audio has a
 *      low-frequency-dominant, low-derivative waveform) is 4-9x *smaller*
 *      under the signed-native reading than under an unsigned-with-128-bias
 *      reading, consistently across every region sampled in both games'
 *      `qsound` ROMs.
 *
 * No compression, no ADPCM, no differencing — this is the simplest
 * possible 8-bit linear PCM encoding. All of the "QSound is a proprietary
 * codec" folklore refers to the DSP's *playback* processing (resampling,
 * reverb, stereo positioning, filtering) done in real time by the DSP
 * microcode, not to any transform on the stored sample bytes themselves.
 *
 * Command protocol (`qsound_device::qsound_w/r`, `Z80 qsound_sub_map` in
 * `src/mame/capcom/cps1.cpp`, shared verbatim by CPS2 per its own comment
 * "used by capcom/cps2.cpp too"): the Z80 writes a 16-bit data word (high
 * byte at offset 0, low byte at offset 1) then an 8-bit DSP-internal-RAM
 * address (offset 2, which also asserts the DSP's INT line and triggers
 * the write); offset 7 reads back a ready flag (bit 7 set = DSP ready for
 * the next command). Confirmed for real by disassembling a CPS2 game's
 * `audiocpu` Z80 program (Dungeons & Dragons: Shadow over Mystara): a
 * boot-time "silence all 16 channels" routine computes each channel's
 * `(ch<<3)`-based register address via 3x `RLC` (rotate-left, equivalent
 * to `<<3` mod 256) and adds the exact sub-register offsets documented in
 * qsound.cpp's header comment (`+0xba` reverb contribution, `+0x06`
 * volume, `+0x02` playback rate) — an independent, blind structural
 * derivation from real disassembled arithmetic landing exactly on MAME's
 * documented register map.
 *
 * This is the chip layer only — pure sample decode plus the mailbox
 * register/port map. The Z80 driver's CPS2 music-sequence format (song
 * tables, track event grammar, instrument/envelope/pitch tables) that
 * *drives* this chip lives in `./qsound-driver.js`, since that grammar is a
 * CPS2 sound-driver convention, not a property of the QSound chip itself.
 */

/** Decode one raw QSound sample-ROM byte into a signed 16-bit PCM sample. */
export function decodeQsoundSample(byte: number): number {
  const signed = byte < 0x80 ? byte : byte - 0x100; // two's complement 8-bit
  return signed * 256; // dsp_sample_r(): u16(byte) << 8, read back as signed
}

/** Decode a raw QSound sample-ROM byte range into 16-bit PCM (1:1 length, mono). */
export function decodeQsoundPcm(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = decodeQsoundSample(bytes[i]);
  return out;
}

/**
 * DSP-internal-RAM register addresses the Z80 host can write to via the
 * `qsound_w` mailbox (offset 2's data byte) — from qsound.cpp's header
 * comment, confirmed against a real CPS2 game's boot-time channel-reset
 * routine (see module doc comment above).
 */
export const QSOUND_REG = {
  /** `((ch - 1) << 3) & 0x78`, ch = 1..16: sample bank for the *next* read (one-read latency, see qsound.cpp). */
  sampleBank: (ch: number) => ((ch - 1) << 3) & 0x78,
  /** `(ch << 3) | 0x01`, ch = 1..16: channel sample offset within its bank. */
  sampleOffset: (ch: number) => (ch << 3) | 0x01,
  /** `(ch << 3) | 0x02`, ch = 1..16: channel playback rate (phase increment). */
  playbackRate: (ch: number) => (ch << 3) | 0x02,
  /** `(ch << 3) | 0x03`, ch = 1..16: channel sample period counter. */
  periodCounter: (ch: number) => (ch << 3) | 0x03,
  /** `(ch << 3) | 0x04`, ch = 1..16: channel loop offset (relative to end). */
  loopOffset: (ch: number) => (ch << 3) | 0x04,
  /** `(ch << 3) | 0x05`, ch = 1..16: channel end sample offset. */
  endOffset: (ch: number) => (ch << 3) | 0x05,
  /** `(ch << 3) | 0x06`, ch = 1..16: channel volume. */
  volume: (ch: number) => (ch << 3) | 0x06,
  /** `ch | 0x80`, ch = 1..16: left/right position on sound stage. */
  panPosition: (ch: number) => ch | 0x80,
  /** `ch + 0xba`, ch = 0..15 (0-indexed here, matches a boot-reset loop): channel reverb contribution. */
  reverbContribution: (ch: number) => ch + 0xba,
  /** Delayed reverb volume (single register, not per-channel). */
  delayedReverbVolume: 0x93,
  /** Reverb delay (add 0x0554 per qsound.cpp). */
  reverbDelay: 0xd9,
  leftFilteredDelay: 0xde,
  leftUnfilteredDelay: 0xdf,
  rightFilteredDelay: 0xe0,
  rightUnfilteredDelay: 0xe1,
  /** Write non-zero to commit the delay registers above. */
  commitDelays: 0xe2,
  leftFilteredVolume: 0xe4,
  leftUnfilteredVolume: 0xe5,
  rightFilteredVolume: 0xe6,
  rightUnfilteredVolume: 0xe7,
} as const;

/** Z80-side I/O port addresses for the QSound mailbox (`qsound_sub_map`, `src/mame/capcom/cps1.cpp`). */
export const QSOUND_PORT = {
  dataHigh: 0xd000,
  dataLow: 0xd001,
  address: 0xd002,
  bankSwitch: 0xd003,
  ready: 0xd007,
} as const;
