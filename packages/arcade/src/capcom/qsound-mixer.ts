/**
 * Capcom QSound (DL-1425) voice mixer: the 16 PCM voices as the CPS1/CPS2 Z80
 * sound driver programs them through the `qsound_w` mailbox, mixed to stereo.
 * Browser-safe (no Node imports): a sound driver port feeds it register
 * writes and an AudioWorklet pulls samples from it.
 *
 * Register model (MAME `qsound.cpp` header comment, encoded in
 * {@link QSOUND_REG}; confirmed against the ddsom/ddtod Z80 channel-reset
 * and sample-select code, see the kolbold docs §4.2):
 *
 * | address              | per voice `ch` = 0..15                                   |
 * |----------------------|----------------------------------------------------------|
 * | `(ch << 3) + 0`      | bank of voice `(ch + 1) & 15` (one channel "late")        |
 * | `(ch << 3) + 1`      | current sample address within the bank (start on key-on) |
 * | `(ch << 3) + 2`      | playback rate, 4.12 fixed point (0x1000 = 1 sample/tick)  |
 * | `(ch << 3) + 3`      | phase: 12-bit fraction in bits 4..15                      |
 * | `(ch << 3) + 4`      | loop length (subtracted when the address reaches the end) |
 * | `(ch << 3) + 5`      | end address within the bank                               |
 * | `(ch << 3) + 6`      | volume (0x4000 = unity, see below)                        |
 * | `0x80 + ch`          | pan: `0x110 + position`, position 0 (left)..32 (right)    |
 * | `0xba + ch`          | echo send                                                 |
 * | `0x93` / `0xd9`      | echo feedback / echo delay end position                   |
 *
 * Every other address is stored and readable but has no audible effect here
 * (the "QSound 3D" filter/delay registers `0xda..0xe7` and the ADPCM voices
 * `0xca..0xd8`, which CPS2 drivers only reset).
 *
 * Playback per voice and output sample (MAME's `qsound_hle.cpp`, the
 * high-level port of the DSP16 program by superctr/ValleyBell; **recalled from
 * memory, not re-read for this module**): `out = (volume * sample) >> 14` with
 * `sample` the signed ROM byte `<< 8`; the address advances by `rate / 4096`
 * and, once it is `>= end`, the loop length is subtracted. There is no
 * one-shot mode — a one-shot is a sample whose loop is a short silent tail.
 * The DSP does not interpolate (`interpolation: 'none'`, the default);
 * `'linear'` is offered for comparison with offline renders.
 *
 * Pan: the QSound DSP reads its pan gains from tables in its own internal ROM,
 * which is not available statically. The default {@link QSOUND_PAN_TABLE} is
 * the law of MAME's older HLE (`qsound.cpp` before the 2018 DSP16 LLE, Paul
 * Leaman / Miguel Angel Horna): `gain[i] = sqrt(i / 32)`, right = `gain[pos]`,
 * left = `gain[32 - pos]` — an equal-power law, **recalled from memory**.
 * Positions past 32 (the DSP's extra "3D" positions up to 97) clamp to 32.
 * Pass `panTable` to use another law.
 *
 * Echo (an approximation, **recalled from memory of `qsound_hle.cpp`,
 * coefficients uncertain**): one mono delay line fed by
 * `sum(out[ch] * send[ch]) / 0x4000`; length `delayEnd - 0x554` DSP samples;
 * the line's output is the average of the delayed sample and the previous
 * output (a one-pole low-pass), fed back at `feedback / 0x4000` and added to
 * both outputs at unit gain. The DSP's FIR filters and per-side
 * filtered/unfiltered delays (`0xde..0xe1`) are not modelled. Disable with
 * `echo: false`.
 *
 * Rate: the DSP runs at 60 MHz / 2 / 1248 = {@link QSOUND_SAMPLE_RATE} Hz.
 * At another `outputRate` the voice steps and the echo delay are scaled, so a
 * worklet can mix straight at the context rate without a resampler.
 */

import { QSOUND_REG } from './qsound.js';

/** QSound DSP output rate: 60 MHz clock / 2 / 1248. */
export const QSOUND_SAMPLE_RATE = 60_000_000 / 2 / 1248;

/** Number of PCM voices. */
export const QSOUND_VOICES = 16;

/** The pan register holds `QSOUND_PAN_BASE + position`, position 0 (left) .. 32 (right), 16 = centre. */
export const QSOUND_PAN_BASE = 0x110;

/** Echo delay end positions are offset by this many DSP samples (`0xd9`, "add 0x0554" in qsound.cpp). */
export const QSOUND_ECHO_DELAY_BASE = 0x554;

/** Default pan law: `sqrt(i / 32)` for i = 0..32 (MAME pre-2018 HLE, from memory). */
export const QSOUND_PAN_TABLE: Float64Array = Float64Array.from({ length: 33 }, (_, i) => Math.sqrt(i / 32));

/** `(left, right)` gains for a pan position 0..32 under `table` (default {@link QSOUND_PAN_TABLE}). */
export function qsoundPanGains(position: number, table: ArrayLike<number> = QSOUND_PAN_TABLE): [number, number] {
  const p = Math.max(0, Math.min(32, Math.trunc(position)));
  return [table[32 - p], table[p]];
}

export interface QsoundMixerOptions {
  /** The QSound sample ROM (signed 8-bit PCM), addressed as `(bank << 16) | address`. */
  rom: Uint8Array;
  /** Output rate in Hz, default {@link QSOUND_SAMPLE_RATE}. */
  outputRate?: number;
  /** `'none'` (the DSP, default) or `'linear'`. */
  interpolation?: 'none' | 'linear';
  /** 33 gains for positions 0..32 (right uses `[pos]`, left `[32 - pos]`). */
  panTable?: ArrayLike<number>;
  /** Echo on (default) or off. */
  echo?: boolean;
}

/** One PCM voice as the registers describe it. */
export interface QsoundVoiceState {
  bank: number;
  /** Current position in the bank, fractional. */
  position: number;
  rate: number;
  loopLength: number;
  end: number;
  volume: number;
  /** Pan position 0..32. */
  pan: number;
  echoSend: number;
}

interface Voice extends QsoundVoiceState {
  gainL: number;
  gainR: number;
}

/**
 * Sixteen QSound PCM voices mixed to stereo. Feed it with {@link write} the
 * way the Z80 does (`addr`, 16-bit `data`), pull samples with {@link render}.
 */
export class QsoundMixer {
  readonly outputRate: number;
  readonly interpolation: 'none' | 'linear';
  readonly echoEnabled: boolean;
  private readonly rom: Uint8Array;
  private readonly romMask: number;
  private readonly panTable: ArrayLike<number>;
  /** DSP samples per output sample. */
  private readonly stepScale: number;
  private readonly regs = new Uint16Array(256);
  private readonly voices: Voice[] = [];
  private echoLine = new Float64Array(1);
  private echoPos = 0;
  private echoLast = 0;
  private echoLength = 1;

  constructor(opts: QsoundMixerOptions) {
    this.rom = opts.rom;
    // power-of-two ROMs wrap like the address bus; others clamp through modulo
    const n = opts.rom.length;
    this.romMask = n > 0 && (n & (n - 1)) === 0 ? n - 1 : -1;
    this.outputRate = opts.outputRate ?? QSOUND_SAMPLE_RATE;
    if (!(this.outputRate > 0)) throw new Error('QsoundMixer: outputRate must be positive');
    this.interpolation = opts.interpolation ?? 'none';
    this.echoEnabled = opts.echo ?? true;
    this.panTable = opts.panTable ?? QSOUND_PAN_TABLE;
    if (this.panTable.length < 33) throw new Error('QsoundMixer: panTable needs 33 entries');
    this.stepScale = QSOUND_SAMPLE_RATE / this.outputRate;
    for (let i = 0; i < QSOUND_VOICES; i++) {
      this.voices.push({ bank: 0, position: 0, rate: 0, loopLength: 0, end: 0, volume: 0, pan: 16, echoSend: 0, gainL: 0, gainR: 0 });
    }
    this.reset();
  }

  /** Power-on: every register 0, voices silent and centred, echo line cleared. */
  reset(): void {
    this.regs.fill(0);
    for (const v of this.voices) {
      v.bank = 0;
      v.position = 0;
      v.rate = 0;
      v.loopLength = 0;
      v.end = 0;
      v.volume = 0;
      v.echoSend = 0;
      this.setPan(v, 16);
    }
    this.echoLength = 1;
    this.echoLine = new Float64Array(1);
    this.echoPos = 0;
    this.echoLast = 0;
  }

  /** Last value written to a register (0..255). */
  read(addr: number): number {
    return this.regs[addr & 0xff];
  }

  /** A read-only snapshot of voice `ch` (0..15). */
  voice(ch: number): QsoundVoiceState {
    const v = this.voices[ch & 15];
    return { bank: v.bank, position: v.position, rate: v.rate, loopLength: v.loopLength, end: v.end, volume: v.volume, pan: v.pan, echoSend: v.echoSend };
  }

  /** A mailbox write: 16-bit `data` to DSP register `addr` (what the Z80's `0xd000..0xd002` sequence does). */
  write(addr: number, data: number): void {
    addr &= 0xff;
    data &= 0xffff;
    this.regs[addr] = data;
    if (addr < 0x80) {
      const ch = addr >> 3;
      const v = this.voices[ch];
      switch (addr & 7) {
        case 0:
          this.voices[(ch + 1) & 15].bank = data & 0x7fff;
          break;
        case 1:
          v.position = data + (v.position - Math.floor(v.position));
          break;
        case 2:
          v.rate = data;
          break;
        case 3:
          v.position = Math.floor(v.position) + (data >> 4) / 4096;
          break;
        case 4:
          v.loopLength = data;
          break;
        case 5:
          v.end = data;
          break;
        case 6:
          v.volume = data;
          break;
        default:
          break;
      }
      return;
    }
    if (addr >= 0x80 && addr < 0x90) {
      this.setPan(this.voices[addr - 0x80], data - QSOUND_PAN_BASE);
      return;
    }
    if (addr >= QSOUND_REG.reverbContribution(0) && addr < QSOUND_REG.reverbContribution(16)) {
      this.voices[addr - QSOUND_REG.reverbContribution(0)].echoSend = data;
      return;
    }
    if (addr === QSOUND_REG.reverbDelay) this.resizeEcho(data);
  }

  private setPan(v: Voice, position: number): void {
    v.pan = Math.max(0, Math.min(32, position));
    [v.gainL, v.gainR] = qsoundPanGains(v.pan, this.panTable);
  }

  private resizeEcho(endPos: number): void {
    const dspLen = Math.max(1, (endPos - QSOUND_ECHO_DELAY_BASE) & 0xffff);
    const len = Math.max(1, Math.round(dspLen / this.stepScale));
    if (len === this.echoLength) return;
    this.echoLength = len;
    this.echoLine = new Float64Array(len);
    this.echoPos = 0;
  }

  private sampleAt(bank: number, addr: number): number {
    let a = bank * 0x10000 + addr;
    a = this.romMask >= 0 ? a & this.romMask : a % this.rom.length;
    const b = this.rom[a];
    return (b < 0x80 ? b : b - 0x100) * 256;
  }

  /**
   * Mixes `count` samples into `left`/`right` from `offset` (overwriting),
   * as floats where one full-scale 16-bit sample at unity volume is 1.0.
   */
  render(left: Float32Array, right: Float32Array, offset: number, count: number): void {
    const voices = this.voices;
    const lin = this.interpolation === 'linear';
    const fb = this.regs[QSOUND_REG.delayedReverbVolume] / 0x4000;
    for (let i = 0; i < count; i++) {
      let l = 0;
      let r = 0;
      let echoIn = 0;
      for (let ch = 0; ch < QSOUND_VOICES; ch++) {
        const v = voices[ch];
        const end = v.end === 0 ? 0x10000 : v.end;
        let pos = v.position;
        if (v.volume) {
          const ip = Math.floor(pos);
          let s: number;
          if (lin) {
            let nx = ip + 1;
            if (nx >= end) nx -= v.loopLength;
            const f = pos - ip;
            s = this.sampleAt(v.bank, ip & 0xffff) * (1 - f) + this.sampleAt(v.bank, nx & 0xffff) * f;
          } else s = this.sampleAt(v.bank, ip & 0xffff);
          const out = (v.volume * s) / 0x4000;
          l += out * v.gainL;
          r += out * v.gainR;
          if (v.echoSend) echoIn += (out * v.echoSend) / 0x4000;
        }
        if (v.rate) {
          pos += (v.rate / 4096) * this.stepScale;
          if (Math.floor(pos) >= end) pos -= v.loopLength;
          if (pos < 0) pos = 0;
          v.position = pos;
        }
      }
      if (this.echoEnabled) {
        const old = this.echoLine[this.echoPos];
        const out = (old + this.echoLast) / 2;
        this.echoLast = out;
        this.echoLine[this.echoPos] = echoIn + out * fb;
        if (++this.echoPos >= this.echoLength) this.echoPos = 0;
        l += out;
        r += out;
      }
      left[offset + i] = l / 32768;
      right[offset + i] = r / 32768;
    }
  }
}
