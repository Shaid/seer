import { describe, it, expect } from 'vitest';
import { createEchoState, stepEcho, FIR_TAP_COUNT } from '../echo.js';

/**
 * Expected values below are hand-derived by tracing the real formula
 * (this module's own doc comment) step by step on paper for a small,
 * tractable delay length — not computed by running this file's own
 * implementation and copying the output.
 */

// "Flat passthrough" FIR: only the single newest tap at ~unity weight, all others zero.
// A commonly-cited real default preset for a plain (unfiltered) echo repeat.
const FLAT_FIR = [0, 0, 0, 0, 0, 0, 0, 128];

describe('stepEcho', () => {
  it('with zero feedback, an impulse reappears exactly once, delaySamples later, then goes silent', () => {
    const state = createEchoState(4);
    const outputs: number[] = [];
    // Sample 0: feed an impulse (dryEchoSendL=1). Samples 1-9: silence in.
    for (let i = 0; i < 10; i++) {
      const dry = i === 0 ? 1 : 0;
      const { echoOutL } = stepEcho(state, dry, dry, FLAT_FIR, 0, 128, 128);
      outputs.push(echoOutL);
    }
    // Buffer starts empty (all zero reads) for samples 0-3; the impulse written at sample 0
    // is read back exactly at sample 4 (delaySamples=4), producing a single unity-scaled echo.
    // Zero feedback means nothing gets written back into that slot beyond the (now-silent) dry
    // input, so no further repeats appear.
    expect(outputs).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  });

  it('with 0.5 feedback, the same impulse produces a geometrically decaying series of echoes', () => {
    const state = createEchoState(4);
    const outputs: number[] = [];
    for (let i = 0; i < 13; i++) {
      const dry = i === 0 ? 1 : 0;
      const { echoOutL } = stepEcho(state, dry, dry, FLAT_FIR, 64, 128, 128); // feedback = 64/128 = 0.5
      outputs.push(echoOutL);
    }
    // Echoes at samples 4, 8, 12 with amplitude 1, 0.5, 0.25 (each repeat re-writes
    // feedback*previous into the same delay-line slot, read back one more delaySamples later).
    expect(outputs[4]).toBeCloseTo(1.0, 10);
    expect(outputs[8]).toBeCloseTo(0.5, 10);
    expect(outputs[12]).toBeCloseTo(0.25, 10);
    for (const i of [0, 1, 2, 3, 5, 6, 7, 9, 10, 11]) expect(outputs[i]).toBeCloseTo(0, 10);
  });

  it('evolL/evolR independently scale the two channels', () => {
    const state = createEchoState(2);
    stepEcho(state, 1, 1, FLAT_FIR, 0, 128, 128);
    stepEcho(state, 0, 0, FLAT_FIR, 0, 128, 128);
    const { echoOutL, echoOutR } = stepEcho(state, 0, 0, FLAT_FIR, 0, 64, 32); // evolL=0.5, evolR=0.25
    expect(echoOutL).toBeCloseTo(0.5, 10);
    expect(echoOutR).toBeCloseTo(0.25, 10);
  });

  it('createEchoState clamps a non-positive delay to a 1-sample minimum rather than producing an empty buffer', () => {
    const state = createEchoState(0);
    expect(state.bufferL.length).toBe(1);
    expect(state.bufferR.length).toBe(1);
  });

  it('FIR_TAP_COUNT is 8, matching real hardware\'s FFC0-FFC7', () => {
    expect(FIR_TAP_COUNT).toBe(8);
  });
});
