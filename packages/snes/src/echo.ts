/**
 * SNES S-DSP echo unit -- fixed console hardware, not game-specific, same
 * tier as `brr.ts`/`envelope.ts`. A real, well-documented feature of every
 * SNES game's audio pipeline: a shared stereo delay line, an 8-tap FIR
 * filter on the delayed signal, and a feedback path that recirculates the
 * filtered signal back into the delay buffer (a classic feedback
 * delay/reverb-tail structure).
 *
 * **Algorithm confirmed against a real, cycle-accurate SNES emulator's
 * source** (`SourMesen/Mesen2`, `Core/SNES/DSP/Dsp.cpp`'s `EchoStep22`
 * through `EchoStep30` and `CalculateFir`, `Core/SNES/DSP/DspVoice.cpp`'s
 * `EchoOn`/`OutSamples` accumulation) -- transcribed from that source, not
 * from a written description. Real hardware processes this across several
 * 32-step DSP cycle phases per sample (for cycle-accurate emulation
 * timing); this module collapses that into one `stepEcho` call per output
 * sample, which is all that matters once cycle timing isn't being
 * emulated -- the actual signal-processing formula is unchanged.
 *
 * Real per-sample data flow, transcribed directly (register names are the
 * real DSP register names):
 * ```
 * delayed = ringBuffer[pos]                    -- read BEFORE write, same slot
 * push delayed into an 8-entry FIR history ring
 * firOut = sum(history[i] * (FFCi / 128))       -- FFC0..FFC7, oldest to newest tap
 * echoContribution = firOut * (EVOL / 128)      -- added to the dry mix for output
 * ringBuffer[pos] = dryEchoSend + firOut * (EFB / 128)  -- write, closes the feedback loop
 * pos = (pos + 1) % delayLengthSamples
 * ```
 * `dryEchoSend` is the sum of every voice's *scaled* dry output for voices
 * with their `EON` bit set -- the same per-voice scaled sample that also
 * feeds the ordinary dry mix, not a separate signal.
 *
 * `EDL` (delay length), the 8 `FFC` FIR coefficients, `EFB` (feedback), and
 * `EVOL(L)`/`EVOL(R)` are real hardware registers this module takes as
 * plain parameters -- how a caller derives them (fixed per-song values, a
 * driver's own VCMD-controlled fade, etc.) is entirely up to the caller,
 * not modelled here.
 */

/** Real hardware: 8 taps, `FFC0`-`FFC7` (oldest to newest). */
export const FIR_TAP_COUNT = 8;

export interface EchoState {
  bufferL: Float32Array;
  bufferR: Float32Array;
  pos: number;
  historyL: Float32Array;
  historyR: Float32Array;
  historyPos: number;
}

/** `delaySamples` -- real hardware: `(EDL & 0xF) * 512` samples (`EDL` 0-15, i.e. 0 to 7680 samples / ~240ms at the DSP's native 32000 Hz). */
export function createEchoState(delaySamples: number): EchoState {
  const len = Math.max(1, delaySamples);
  return {
    bufferL: new Float32Array(len),
    bufferR: new Float32Array(len),
    pos: 0,
    historyL: new Float32Array(FIR_TAP_COUNT),
    historyR: new Float32Array(FIR_TAP_COUNT),
    historyPos: 0,
  };
}

export interface EchoStepResult {
  /** Add directly to this sample's dry-mixed output (already scaled by `evolL`/`evolR`). */
  echoOutL: number;
  echoOutR: number;
}

/**
 * Advance the echo unit by one output sample. `firCoeffs` are 8 raw signed
 * byte-range values (-128..127, matching real `FFC0`-`FFC7` registers,
 * oldest tap first) -- this function does the `/128` scaling internally,
 * same convention as `feedback`/`evolL`/`evolR` (all real signed-8-bit
 * `/128` register fractions, matching `VOL`/`EFB`/`EVOL`'s real `>>7`
 * hardware scaling).
 */
export function stepEcho(
  state: EchoState,
  dryEchoSendL: number,
  dryEchoSendR: number,
  firCoeffs: readonly number[],
  feedback: number,
  evolL: number,
  evolR: number,
): EchoStepResult {
  const delayed_l = state.bufferL[state.pos]!;
  const delayed_r = state.bufferR[state.pos]!;

  state.historyPos = (state.historyPos + 1) % FIR_TAP_COUNT;
  state.historyL[state.historyPos] = delayed_l;
  state.historyR[state.historyPos] = delayed_r;

  let firL = 0;
  let firR = 0;
  for (let i = 0; i < FIR_TAP_COUNT; i++) {
    // i=0 is the oldest tap (this sample's just-pushed entry is the newest, i=7).
    const histIdx = (state.historyPos + i + 1) % FIR_TAP_COUNT;
    const coeff = firCoeffs[i]! / 128;
    firL += state.historyL[histIdx]! * coeff;
    firR += state.historyR[histIdx]! * coeff;
  }

  state.bufferL[state.pos] = dryEchoSendL + firL * (feedback / 128);
  state.bufferR[state.pos] = dryEchoSendR + firR * (feedback / 128);
  state.pos = (state.pos + 1) % state.bufferL.length;

  return {
    echoOutL: firL * (evolL / 128),
    echoOutR: firR * (evolR / 128),
  };
}
