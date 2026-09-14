/**
 * SNES S-DSP hardware envelope (ADSR and GAIN) helpers — fixed console
 * hardware, not game-specific, shared machine knowledge across every
 * seer SNES project, same tier as `brr.ts`/`ppu.ts`.
 *
 * **ADSR state machine and rate table confirmed against a real,
 * cycle-accurate SNES emulator's source** (`SourMesen/Mesen2`,
 * `Core/SNES/DSP/Dsp.cpp`'s `CheckCounter` for the 32-entry rate-period
 * table, `Core/SNES/DSP/DspVoice.cpp`'s `ProcessEnvelope` for the
 * Attack/Decay/Sustain/Release update formulas, and `GetGainOutput`'s
 * mode-4/5/6/7 formulas for the GAIN path) — transcribed from that source,
 * not from a written description. `stepEnvelope` implements the same
 * Attack (linear `+32`)/Decay+Sustain (exponential `-= ((v-1)>>8)+1`)/
 * Release (linear `-8`, every tick) recurrence, and `stepGainEnvelope`
 * implements the four GAIN modes (direct, linear decrease, exponential
 * decrease, linear/two-slope increase), both in 11-bit range (`0..0x7FF`),
 * one call per output sample.
 *
 * **Scope note**: a renderer running at the DSP's own native 32000 Hz
 * output rate (`DSP_SAMPLE_RATE`) makes "one envelope tick per output
 * sample" exact for that choice — no extra tick-to-sample mapping
 * approximation needed there. Each voice's GAIN countdown shares this
 * module's per-voice timing abstraction (`EnvelopeState.counter`) rather
 * than the hardware's phase-locked global counter — matches real hardware's
 * envelope *rate* and value sequence exactly, not its exact sub-sample
 * phase alignment against unrelated voices.
 *
 * Real per-instrument pitch/tuning conversion is deliberately **not**
 * included here: unlike this module, a driver's own note-to-pitch formula
 * (semitone table, tuning-byte handling) is sequencer/driver-specific, not
 * S-DSP hardware — see your project's own driver-level pitch module.
 */

/** The SNES DSP's native fixed output sample rate. */
export const DSP_SAMPLE_RATE = 32000;

/**
 * Rate index (0-31) -> period in DSP sample-ticks between envelope updates.
 * Index 0 ("never update") is represented as a very large period rather
 * than the real hardware's `UINT16_MAX`-vs-internal-counter-modulus
 * mechanism, which has the same practical effect (the envelope holds).
 */
export const ENVELOPE_RATE_PERIOD: readonly number[] = [
  65535, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12,
  10, 8, 6, 5, 4, 3, 2, 1,
];

export interface AdsrParams {
  /** ADSR1 bit 7 — if false, real hardware uses the GAIN path instead. */
  enabled: boolean;
  /** 0-15 (ADSR1 bits 0-3). */
  attackRate: number;
  /** 0-7 (ADSR1 bits 4-6). */
  decayRate: number;
  /** 0-7 (ADSR2 bits 5-7). */
  sustainLevel: number;
  /** 0-31 (ADSR2 bits 0-4). */
  sustainRate: number;
}

/** Decode a voice's 2-byte ADSR register pair (real DSP `ADSR1`/`ADSR2` bit layout). */
export function decodeAdsrRegisters(adsr1: number, adsr2: number): AdsrParams {
  return {
    enabled: (adsr1 & 0x80) !== 0,
    attackRate: adsr1 & 0x0f,
    decayRate: (adsr1 >> 4) & 0x07,
    sustainLevel: (adsr2 >> 5) & 0x07,
    sustainRate: adsr2 & 0x1f,
  };
}

export type EnvelopeStage = 'attack' | 'decay' | 'sustain' | 'release';

export interface EnvelopeState {
  stage: EnvelopeStage;
  /** 0-0x7FF (11-bit), matching real hardware's envelope value range. */
  value: number;
  /** Ticks remaining until the next update at the current stage's rate. */
  counter: number;
  /** Unclamped working value used by S-DSP GAIN mode 7's two-slope ramp. */
  hiddenValue: number;
}

/** `counter: 0` deliberately, not a rate-derived period — this makes the very first `stepEnvelope` call fire immediately regardless of the instrument's attack rate, rather than needing `params` (not yet known) at construction time. Off by at most one tick, immaterial at 32000 ticks/sec. */
export function initEnvelopeState(): EnvelopeState {
  return { stage: 'attack', value: 0, counter: 0, hiddenValue: 0 };
}

/** Move a voice from Attack/Decay/Sustain into Release (real hardware: rate fixed at 31, `E -= 8` every tick, no separate rate lookup). */
export function releaseVoice(state: EnvelopeState): void {
  state.stage = 'release';
}

/** Advance the S-DSP's GAIN/direct-envelope path by one envelope tick. */
export function stepGainEnvelope(state: EnvelopeState, gainRegister: number): EnvelopeState {
  if (state.stage === 'release') {
    state.value = Math.max(0, state.value - 8);
    state.hiddenValue = state.value;
    return state;
  }
  const gain = gainRegister & 0xff;
  const mode = gain >>> 5;
  let next = state.value;
  let rate = 31;
  if (mode < 4) {
    next = gain * 0x10;
  } else {
    rate = gain & 0x1f;
    if (mode === 4) next -= 0x20;
    else if (mode === 5) {
      next--;
      next -= next >> 8;
    } else {
      next += 0x20;
      if (mode === 7 && state.hiddenValue >= 0x600) next += 0x08 - 0x20;
    }
  }
  state.hiddenValue = next;
  state.counter--;
  if (state.counter <= 0) {
    state.counter = ENVELOPE_RATE_PERIOD[rate]!;
    state.value = Math.max(0, Math.min(0x7ff, next));
  }
  return state;
}

/**
 * Advance the envelope by exactly one DSP sample-tick (see module doc
 * comment on why 1 tick = 1 output sample at `DSP_SAMPLE_RATE`). Mutates
 * and returns `state` for convenience; `state.value / 0x7FF` is the
 * envelope's linear gain multiplier (0..1).
 */
export function stepEnvelope(state: EnvelopeState, params: AdsrParams): EnvelopeState {
  if (state.stage === 'release') {
    state.value = Math.max(0, state.value - 8);
    state.hiddenValue = state.value;
    return state;
  }

  let rate: number;
  switch (state.stage) {
    case 'attack':
      rate = params.attackRate === 0x0f ? 31 : (params.attackRate << 1) | 0x01;
      break;
    case 'decay':
      rate = ((params.decayRate << 1) | 0x10) & 0x1f;
      break;
    case 'sustain':
    default:
      rate = params.sustainRate;
      break;
  }

  state.counter--;
  if (state.counter > 0) return state;
  state.counter = ENVELOPE_RATE_PERIOD[rate]!;

  if (state.stage === 'attack') {
    state.value += params.attackRate === 0x0f ? 1024 : 32;
  } else {
    state.value -= ((state.value - 1) >> 8) + 1;
  }
  state.value = Math.max(0, Math.min(0x7ff, state.value));
  state.hiddenValue = state.value;

  if (state.stage === 'decay' && state.value >> 8 === params.sustainLevel) {
    state.stage = 'sustain';
  } else if (state.stage === 'attack' && state.value >= 0x7ff) {
    state.stage = 'decay';
  }

  return state;
}
