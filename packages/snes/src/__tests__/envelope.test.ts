import { describe, it, expect } from 'vitest';
import { decodeAdsrRegisters, initEnvelopeState, stepEnvelope, stepGainEnvelope, releaseVoice, ENVELOPE_RATE_PERIOD } from '../envelope.js';

describe('decodeAdsrRegisters', () => {
  it('extracts enable/attackRate/decayRate/sustainLevel/sustainRate from the real bit layout', () => {
    // ADSR1 = 1_101_1010 -> enabled=1, decayRate=0b101=5, attackRate=0b1010=10
    const adsr1 = 0b1_101_1010;
    // ADSR2 = 011_10101 -> sustainLevel=0b011=3, sustainRate=0b10101=21
    const adsr2 = 0b011_10101;
    const p = decodeAdsrRegisters(adsr1, adsr2);
    expect(p.enabled).toBe(true);
    expect(p.decayRate).toBe(5);
    expect(p.attackRate).toBe(10);
    expect(p.sustainLevel).toBe(3);
    expect(p.sustainRate).toBe(21);
  });

  it('enabled is false when ADSR1 bit 7 is clear', () => {
    expect(decodeAdsrRegisters(0x00, 0x00).enabled).toBe(false);
  });
});

describe('ENVELOPE_RATE_PERIOD', () => {
  it('has 32 entries, monotonically non-increasing (higher rate index = faster/shorter period)', () => {
    expect(ENVELOPE_RATE_PERIOD.length).toBe(32);
    for (let i = 1; i < 32; i++) {
      expect(ENVELOPE_RATE_PERIOD[i]!).toBeLessThanOrEqual(ENVELOPE_RATE_PERIOD[i - 1]!);
    }
    expect(ENVELOPE_RATE_PERIOD[31]).toBe(1); // fastest: every tick
  });
});

describe('stepEnvelope', () => {
  it('attackRate=0x0F (instant): reaches full scale (0x7FF) and transitions to decay within 2 ticks', () => {
    const params = decodeAdsrRegisters(0x8f, 0x00); // enabled, attackRate=0xF, decayRate=0, sustainLevel=0, sustainRate=0
    const state = initEnvelopeState();
    stepEnvelope(state, params);
    expect(state.value).toBe(1024);
    expect(state.stage).toBe('attack');
    stepEnvelope(state, params);
    expect(state.value).toBe(0x7ff);
    expect(state.stage).toBe('decay');
  });

  it('attackRate=0 (slowest): increments by 32 roughly every ENVELOPE_RATE_PERIOD[1] ticks, not every tick', () => {
    const params = decodeAdsrRegisters(0x80, 0x00); // enabled, attackRate=0, rate=(0<<1)|1=1
    const state = initEnvelopeState();
    stepEnvelope(state, params); // first call fires immediately regardless of rate (counter starts at 0)
    expect(state.value).toBe(32);
    const period = ENVELOPE_RATE_PERIOD[1]!; // 2048
    // advance period-1 more ticks: should NOT have incremented again yet
    for (let i = 0; i < period - 1; i++) stepEnvelope(state, params);
    expect(state.value).toBe(32);
    // one more tick crosses the period boundary
    stepEnvelope(state, params);
    expect(state.value).toBe(64);
  });

  it('decay transitions to sustain once the envelope value matches the sustain level (top 3 bits)', () => {
    // sustainLevel=7 (max) so decay barely has to fall before matching -- use decayRate that moves fast (7) and start already near full scale via instant attack.
    const params = decodeAdsrRegisters(0x8f | (7 << 4), 7 << 5); // attackRate=0xF, decayRate=7, sustainLevel=7
    const state = initEnvelopeState();
    stepEnvelope(state, params); // value=1024
    stepEnvelope(state, params); // value=0x7ff, stage->decay
    expect(state.stage).toBe('decay');
    // 0x7ff >> 8 = 7, which already equals sustainLevel=7, so the very next decay tick that actually
    // fires (rate=(7<<1)|0x10=0x1E -> period 3) transitions to sustain rather than waiting for a big decay.
    let transitioned = false;
    for (let i = 0; i < 10 && !transitioned; i++) {
      stepEnvelope(state, params);
      if (state.stage === 'sustain') transitioned = true;
    }
    expect(transitioned).toBe(true);
  });

  it('release decreases by exactly 8 every single tick, unconditionally of rate', () => {
    const params = decodeAdsrRegisters(0x80, 0x00);
    const state = initEnvelopeState();
    state.value = 100;
    releaseVoice(state);
    expect(state.stage).toBe('release');
    stepEnvelope(state, params);
    expect(state.value).toBe(92);
    stepEnvelope(state, params);
    expect(state.value).toBe(84);
  });

  it('release clamps at 0, never goes negative', () => {
    const params = decodeAdsrRegisters(0x80, 0x00);
    const state = initEnvelopeState();
    state.value = 5;
    releaseVoice(state);
    stepEnvelope(state, params);
    expect(state.value).toBe(0);
    stepEnvelope(state, params);
    expect(state.value).toBe(0);
  });
});

describe('stepGainEnvelope', () => {
  it('implements direct gain and the two-slope linear increase modes', () => {
    const direct = initEnvelopeState();
    stepGainEnvelope(direct, 0x40);
    expect(direct.value).toBe(0x400);

    const rising = initEnvelopeState();
    for (let i = 0; i < ENVELOPE_RATE_PERIOD[1]! + 1; i++) stepGainEnvelope(rising, 0xe1);
    expect(rising.value).toBeGreaterThan(0);
    expect(rising.value).toBeLessThanOrEqual(0x7ff);
    expect(rising.hiddenValue).toBeGreaterThan(0);
  });

  it('applies linear and exponential decrease with the source clamp', () => {
    const linear = initEnvelopeState();
    linear.value = linear.hiddenValue = 0x100;
    stepGainEnvelope(linear, 0x80 | 0x01); // mode 4, rate 1
    expect(linear.value).toBe(0xe0);
    const exponential = initEnvelopeState();
    exponential.value = exponential.hiddenValue = 0x100;
    stepGainEnvelope(exponential, 0xa1); // mode 5, rate 1
    expect(exponential.value).toBe(0xff);
  });
});
