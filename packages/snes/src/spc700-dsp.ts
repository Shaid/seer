/**
 * A real S-DSP per-sample audio engine — the full real DSP register file
 * (128 bytes: per-voice `VOL(L)/VOL(R)/P(L)/P(H)/SRCN/ADSR1/ADSR2/GAIN/
 * ENVX/OUTX` x8, plus global `MVOL(L)/MVOL(R)/EVOL(L)/EVOL(R)/KON/KOFF/FLG/
 * ENDX/EFB/PMON/NON/EON/DIR/ESA/EDL/FFC0-7`), driven entirely by what a real
 * SPC700 CPU (`spc700-cpu.ts`) writes via the `$F2`/`$F3` register-select/
 * data port pair. Produces one real stereo sample every DSP clock (32 CPU
 * cycles = 1/32000s, matching `DSP_SAMPLE_RATE`).
 *
 * Fixed SNES hardware, not game-specific — same tier as `brr.ts`/
 * `envelope.ts`/`echo.ts`, which this module *reuses* rather than
 * duplicates: ADSR/GAIN envelope stepping (`stepEnvelope`/
 * `stepGainEnvelope`), BRR block decode (`decodeBrrBlock`),
 * Gaussian-interpolated resampling (`@seer-project/audio-dsp`'s
 * `resampleLooped`), and the echo unit (`stepEcho`) are all driven here by
 * real register values — this is the module that makes those shared
 * primitives into a complete, register-driven S-DSP rather than a driver's
 * own higher-level approximation of one. Register addresses and per-voice
 * register-block layout confirmed against blargg's `snes_spc`
 * (`~/Development/snes_spc/snes_spc/SPC_DSP.h`'s `r_*`/`v_*` enums).
 *
 * **BRR playback**: real hardware decodes BRR blocks lazily, 16 samples at a
 * time, as playback consumes them. This module instead **eagerly decodes an
 * entire sample once at KON (key-on) time** — reading raw BRR bytes directly
 * out of the same ARAM buffer the CPU writes to, resolving the sample's
 * start/loop addresses via the real DSP `DIR`-table 4-byte-per-entry format
 * (`(DIR<<8) + srcn*4` -> `[startLo,startHi,loopLo,loopHi]`) — then plays
 * back through `resampleLooped`'s existing looped-position machinery. This
 * is a **deliberate, scoped simplification**: BRR decode is a pure function
 * of the stored bytes (no real-time-pacing dependency), so eager-decode-
 * once produces byte-identical audio content to real hardware's lazy
 * streaming decode for the whole-sample-content case that matters for an
 * offline renderer (a handful of scripted songs, not real-time ARAM
 * mutation mid-playback) — cached per start address so repeated notes on
 * the same instrument don't redecode. What's *not* replicated: the real
 * 5-sample KON startup delay quirk (voices start audible immediately here)
 * and mid-stream ARAM mutation of already-decoded sample data.
 *
 * **Explicitly out of scope**: `FLG`'s echo-buffer-write-disable bit is not
 * honoured (echo always writes). `PMON` is implemented below using the
 * standard S-DSP previous-voice sample modulation formula.
 *
 * **`NON` (noise generator) is implemented**, ported from blargg's
 * `snes_spc` (`~/Development/snes_spc/snes_spc/SPC_DSP.cpp`'s
 * `misc_30`/`voice_V3c`) — the same lineage `spc700-cpu.ts` already cites.
 * Real hardware: a single shared 15-bit LFSR (`noise`, reset value
 * `0x4000`), clocked once per output sample at a rate selected by `FLG`'s
 * low 5 bits (the same 32-entry rate-period table `ENVELOPE_RATE_PERIOD`
 * already uses for ADSR, reused here rather than re-declared) via
 * `feedback = (noise<<13) ^ (noise<<14); noise = (feedback & 0x4000) ^
 * (noise>>1)`; for any voice with its `NON` bit set, the
 * Gaussian-interpolated BRR sample output is replaced by
 * `(int16_t)(noise*2)` immediately before envelope/volume are applied —
 * BRR decoding and position-advance still run unconditionally in parallel
 * (matching real hardware's fixed pipeline), only the final sample value is
 * swapped. **Known simplification**: real hardware's noise-rate counter
 * and the per-voice envelope-rate counters are all phase-locked to one
 * shared global counter with per-rate phase offsets (`counter_offsets` in
 * the same source); this module gives noise its own free-running countdown
 * reset to the full period on each fire (like `envelope.ts`'s own
 * `EnvelopeState.counter` simplification) — matches real hardware's noise
 * *rate* and LFSR *sequence* exactly, not its exact sub-sample phase
 * alignment against unrelated voices' envelope updates.
 */

import { decodeBrrBlock } from './brr.js';
import {
  decodeAdsrRegisters,
  stepEnvelope,
  stepGainEnvelope,
  initEnvelopeState,
  releaseVoice,
  ENVELOPE_RATE_PERIOD,
  type EnvelopeState,
} from './envelope.js';
import { createEchoState, stepEcho } from './echo.js';
import type { EchoState } from './echo.js';
import { resampleLooped } from '@seer-project/audio-dsp';

// ── Register addresses (SPC_DSP.h's r_*/v_* enums) ─────────────────────

export const REG = {
  MVOLL: 0x0c,
  MVOLR: 0x1c,
  EVOLL: 0x2c,
  EVOLR: 0x3c,
  KON: 0x4c,
  KOFF: 0x5c,
  FLG: 0x6c,
  ENDX: 0x7c,
  EFB: 0x0d,
  PMON: 0x2d,
  NON: 0x3d,
  EON: 0x4d,
  DIR: 0x5d,
  ESA: 0x6d,
  EDL: 0x7d,
  FIR0: 0x0f, // 8 coefficients at 0x0F, 0x1F, ..., 0x7F
} as const;

/** Per-voice register offsets within a voice's 0x10-byte block (`voice*0x10 + V_*`). */
export const V = {
  VOLL: 0x00,
  VOLR: 0x01,
  PITCHL: 0x02,
  PITCHH: 0x03,
  SRCN: 0x04,
  ADSR0: 0x05,
  ADSR1: 0x06,
  GAIN: 0x07,
  ENVX: 0x08,
  OUTX: 0x09,
} as const;

const VOICE_COUNT = 8;
const BRR_BLOCK_SIZE = 9;
const PITCH_UNITY = 0x1000; // 14-bit pitch register, 0x1000 = 1.0 resample step

function int8(v: number): number {
  return v & 0x80 ? v - 0x100 : v;
}

interface DecodedSample {
  pcm: Float32Array;
  loopStartSample: number;
}

interface VoiceRuntime {
  playing: boolean;
  sample: DecodedSample | null;
  pos: number;
  envelope: EnvelopeState;
  releasedByEndx: boolean;
}

/** A real, register-driven S-DSP. Shares its ARAM buffer with a `Spc700Cpu` instance (construct the CPU with the same `Uint8Array`). */
export class Spc700Dsp {
  readonly regs = new Uint8Array(128);
  private readonly ram: Uint8Array;
  private readonly onKeyOn?: (voiceIndex: number) => void;
  private readonly voices: VoiceRuntime[];
  private readonly echo: EchoState;
  /** Cache of decoded whole-sample PCM, keyed by the DIR-table start address (ARAM byte offset) -- see module doc comment on the eager-decode-once simplification. */
  private readonly sampleCache = new Map<number, DecodedSample>();
  private prevKon = 0;
  /** Shared 15-bit noise LFSR state, real hardware reset value -- see module doc comment. */
  private noise = 0x4000;
  /** Ticks remaining until the next LFSR update; `0` fires immediately on the first `step()`, matching `EnvelopeState.counter`'s own "fire on first tick" convention. */
  private noiseCounter = 0;

  constructor(ram: Uint8Array, onKeyOn?: (voiceIndex: number) => void) {
    if (ram.length !== 0x10000) throw new RangeError(`Spc700Dsp: ram must be exactly 64KB, got ${ram.length}`);
    this.ram = ram;
    this.onKeyOn = onKeyOn;
    this.voices = [];
    for (let i = 0; i < VOICE_COUNT; i++) {
      this.voices.push({ playing: false, sample: null, pos: 0, envelope: initEnvelopeState(), releasedByEndx: false });
    }
    this.echo = createEchoState(1); // real length applied lazily once EDL is known -- see stepEcho call site
  }

  /** $F3 read (register already selected via $F2, per real hardware -- the CPU core calls this with the resolved 0-127 address). */
  read(addr: number): number {
    return this.regs[addr & 0x7f]!;
  }

  /** $F3 write. */
  write(addr: number, value: number): void {
    const a = addr & 0x7f;
    const v = value & 0xff;
    this.regs[a] = v;
    if (a === REG.ENDX) this.regs[REG.ENDX] = 0; // real hardware: any write to ENDX clears it, regardless of the written value
  }

  /** Return the voices whose real DSP state is still keyed/playing. */
  playingVoiceIndices(): number[] {
    return this.voices.flatMap((voice, index) => voice.playing ? [index] : []);
  }

  private decodeSampleAt(startAddr: number, loopAddr: number): DecodedSample {
    const cached = this.sampleCache.get(startAddr);
    if (cached) return cached;

    const samples: number[] = [];
    let p1 = 0;
    let p2 = 0;
    let addr = startAddr & 0xffff;
    let loopStartSample = 0;
    let sawLoopAddr = false;
    const maxBlocks = 4096; // safety bound -- no real BRR sample approaches this
    for (let b = 0; b < maxBlocks; b++) {
      if (addr === (loopAddr & 0xffff) && !sawLoopAddr) {
        loopStartSample = samples.length;
        sawLoopAddr = true;
      }
      const block = this.ram.subarray(addr, addr + BRR_BLOCK_SIZE);
      const decoded = decodeBrrBlock(block, p1, p2);
      for (let i = 0; i < decoded.samples.length; i++) samples.push(decoded.samples[i]!);
      p1 = decoded.prev1;
      p2 = decoded.prev2;
      if (decoded.header.end) break;
      addr = (addr + BRR_BLOCK_SIZE) & 0xffff;
    }
    const pcm = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) pcm[i] = samples[i]! / 32768;
    const result: DecodedSample = { pcm, loopStartSample: sawLoopAddr ? loopStartSample : pcm.length };
    this.sampleCache.set(startAddr, result);
    return result;
  }

  private startVoice(v: VoiceRuntime, voiceIdx: number): void {
    const base = voiceIdx * 0x10;
    const srcn = this.regs[base + V.SRCN]!;
    const dirPage = this.regs[REG.DIR]! << 8;
    const dirAddr = (dirPage + srcn * 4) & 0xffff;
    const startAddr = this.ram[dirAddr]! | (this.ram[(dirAddr + 1) & 0xffff]! << 8);
    const loopAddr = this.ram[(dirAddr + 2) & 0xffff]! | (this.ram[(dirAddr + 3) & 0xffff]! << 8);
    v.sample = this.decodeSampleAt(startAddr, loopAddr);
    v.pos = 0;
    v.playing = true;
    v.releasedByEndx = false;
    v.envelope = initEnvelopeState();
  }

  /** Advance the DSP by exactly one output sample (1/32000s). Returns `[left, right]` in `[-1, 1]`. */
  step(): [number, number] {
    const konNow = this.regs[REG.KON]!;
    const konEdge = konNow & ~this.prevKon;
    this.prevKon = konNow;
    const koffNow = this.regs[REG.KOFF]!;
    const flg = this.regs[REG.FLG]!;
    const softReset = (flg & 0x80) !== 0;
    const mute = (flg & 0x40) !== 0;

    if (softReset) {
      for (const v of this.voices) v.playing = false;
      this.regs[REG.KON] = 0;
      this.prevKon = 0;
      return [0, 0];
    }

    const mvolL = int8(this.regs[REG.MVOLL]!) / 128;
    const mvolR = int8(this.regs[REG.MVOLR]!) / 128;
    // Raw signed register values -- `stepEcho` (./echo.js) does its own `/128` scaling
    // internally, matching its existing `feedback`/`firCoeffs` convention (see the call site below).
    const evolLRaw = int8(this.regs[REG.EVOLL]!);
    const evolRRaw = int8(this.regs[REG.EVOLR]!);
    const eon = this.regs[REG.EON]!;
    const non = this.regs[REG.NON]!;

    // Noise LFSR: one shared update per output sample, gated by FLG's rate bits -- see module doc
    // comment for the real feedback formula (ported from snes_spc) and the phase-lock simplification.
    if (--this.noiseCounter <= 0) {
      const feedback = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (feedback & 0x4000) ^ (this.noise >> 1);
      this.noiseCounter = ENVELOPE_RATE_PERIOD[flg & 0x1f]!;
    }

    let dryL = 0;
    let dryR = 0;
    let echoSendL = 0;
    let echoSendR = 0;
    let endxAccum = this.regs[REG.ENDX]!;
    // PMON uses the immediately preceding voice's signed, envelope-applied
    // raw sample. Voice 0 has no predecessor and therefore sees zero.
    let previousRawSample = 0;

    for (let i = 0; i < VOICE_COUNT; i++) {
      const voice = this.voices[i]!;
      const base = i * 0x10;
      const bit = 1 << i;

      if (konEdge & bit) {
        this.startVoice(voice, i);
        this.onKeyOn?.(i);
      }
      if (koffNow & bit) {
        if (voice.playing) releaseVoice(voice.envelope);
      }

      if (!voice.playing || !voice.sample) continue;

      const basePitch = (this.regs[base + V.PITCHL]! | ((this.regs[base + V.PITCHH]! & 0x3f) << 8)) & 0x3fff;
      // The S-DSP treats the prior voice output as a signed 15-bit
      // modulation value and scales the current pitch by (1 + output).
      // Keeping this in integer register units preserves the hardware's
      // truncation before the resampler sees the resulting step.
      const pitch = (this.regs[REG.PMON]! & bit)
        ? Math.max(0, Math.min(0x3fff, (basePitch * (0x8000 + previousRawSample)) >> 15))
        : basePitch;
      const step = pitch / PITCH_UNITY;

      const sample = voice.sample;
      const oneShot = sample.loopStartSample >= sample.pcm.length;
      const loopEnd = oneShot ? sample.loopStartSample : sample.pcm.length;
      const tmp = sampleScratch;
      const { pos, written, ended } = resampleLooped(sample.pcm, voice.pos, step, sample.loopStartSample, loopEnd, tmp, 0, 1, 'gaussian4');
      voice.pos = pos;
      if (!oneShot && !voice.releasedByEndx && voice.pos >= sample.pcm.length) {
        // Real hardware sets ENDX the first time a looped sample's BRR "end" block is reached, even
        // though playback itself continues (via the loop wraparound `resampleLooped` already applies).
        endxAccum |= bit;
        voice.releasedByEndx = true;
      }
      if (written === 0 || ended) {
        voice.playing = false;
        endxAccum |= bit;
        continue;
      }

      // Noise substitution: BRR decode/position-advance above still ran unconditionally (matching
      // real hardware's fixed pipeline) -- only the sample VALUE fed into envelope/volume changes.
      if (non & bit) {
        tmp[0] = (((this.noise * 2) << 16) >> 16) / 32768;
      }

      const adsr1 = this.regs[base + V.ADSR0]!;
      const adsr2 = this.regs[base + V.ADSR1]!;
      const gainReg = this.regs[base + V.GAIN]!;
      const adsrParams = decodeAdsrRegisters(adsr1, adsr2);
      let envGain: number;
      if (adsrParams.enabled) {
        stepEnvelope(voice.envelope, adsrParams);
        envGain = voice.envelope.value / 0x7ff;
      } else {
        stepGainEnvelope(voice.envelope, gainReg);
        envGain = voice.envelope.value / 0x7ff;
      }
      if (envGain <= 0 && voice.envelope.stage === 'release') {
        voice.playing = false;
        previousRawSample = 0;
        continue;
      }

      const volL = int8(this.regs[base + V.VOLL]!) / 128;
      const volR = int8(this.regs[base + V.VOLR]!) / 128;
      const out = tmp[0]! * envGain;
      previousRawSample = Math.max(-0x8000, Math.min(0x7fff, Math.round(out * 0x8000)));
      const outL = out * volL;
      const outR = out * volR;
      dryL += outL;
      dryR += outR;
      if (eon & bit) {
        echoSendL += outL;
        echoSendR += outR;
      }

      this.regs[base + V.ENVX] = Math.max(0, Math.min(0x7f, Math.round(envGain * 0x7f)));
      this.regs[base + V.OUTX] = Math.max(-128, Math.min(127, Math.round(out * 127))) & 0xff;
    }

    this.regs[REG.ENDX] = endxAccum;

    const edl = this.regs[REG.EDL]! & 0xf;
    const delaySamples = Math.max(1, edl * 512);
    if (this.echo.bufferL.length !== delaySamples) resizeEcho(this.echo, delaySamples);
    const efb = int8(this.regs[REG.EFB]!);
    const fir: number[] = [];
    for (let t = 0; t < 8; t++) fir.push(int8(this.regs[REG.FIR0 + t * 0x10]!));
    const { echoOutL, echoOutR } = stepEcho(this.echo, echoSendL, echoSendR, fir, efb, evolLRaw, evolRRaw);

    let outL = dryL * mvolL + echoOutL;
    let outR = dryR * mvolR + echoOutR;
    if (mute) {
      outL = 0;
      outR = 0;
    }
    outL = Math.max(-1, Math.min(1, outL));
    outR = Math.max(-1, Math.min(1, outR));
    return [outL, outR];
  }
}

const sampleScratch = new Float32Array(1);

/** Resize an `EchoState`'s ring buffer in place (real hardware: `EDL` can change mid-song; this project's echo module was built assuming a fixed length, so we reallocate rather than modify that shared module's interface). */
function resizeEcho(state: EchoState, newLength: number): void {
  const bufferL = new Float32Array(newLength);
  const bufferR = new Float32Array(newLength);
  const copyLen = Math.min(newLength, state.bufferL.length);
  bufferL.set(state.bufferL.subarray(0, copyLen));
  bufferR.set(state.bufferR.subarray(0, copyLen));
  state.bufferL = bufferL;
  state.bufferR = bufferR;
  state.pos = state.pos % newLength;
}
