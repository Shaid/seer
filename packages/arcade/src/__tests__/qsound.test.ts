import { describe, it, expect } from 'vitest';
import { decodeQsoundSample, decodeQsoundPcm, QSOUND_REG, QSOUND_PORT } from '../capcom/qsound.js';

describe('decodeQsoundSample', () => {
  it('maps byte 0x00 to sample 0', () => {
    expect(decodeQsoundSample(0x00)).toBe(0);
  });

  it('maps the maximum positive signed byte (0x7f) to +32512 (not full-scale 32767)', () => {
    // dsp_sample_r() smears the byte into the *upper* 8 bits only, low 8
    // bits are tied to ground -- so full-scale 8-bit range maps to
    // 127*256 and -128*256, not +/-32767/-32768.
    expect(decodeQsoundSample(0x7f)).toBe(127 * 256);
    expect(decodeQsoundSample(0x7f)).toBe(32512);
  });

  it('maps the most-negative signed byte (0x80) to -32768', () => {
    expect(decodeQsoundSample(0x80)).toBe(-32768);
  });

  it('maps 0xff (signed -1) to -256, close to zero (not near full negative scale)', () => {
    expect(decodeQsoundSample(0xff)).toBe(-256);
  });

  it('is monotonic in the two\'s-complement sense across the wrap at 0x7f/0x80', () => {
    expect(decodeQsoundSample(0x7f)).toBeGreaterThan(decodeQsoundSample(0x00));
    expect(decodeQsoundSample(0x80)).toBeLessThan(decodeQsoundSample(0xff));
    // the wrap itself: 0x7f is the most positive, 0x80 the most negative
    expect(decodeQsoundSample(0x7f)).toBeGreaterThan(decodeQsoundSample(0x80));
  });
});

describe('decodeQsoundPcm', () => {
  it('decodes each byte independently, preserving length', () => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
    const pcm = decodeQsoundPcm(bytes);
    expect(Array.from(pcm)).toEqual([0, 32512, -32768, -256]);
  });

  it('handles an empty buffer', () => {
    expect(decodeQsoundPcm(new Uint8Array(0)).length).toBe(0);
  });
});

describe('QSOUND_REG (per-channel register address formulas)', () => {
  it('matches qsound.cpp\'s documented formulas for a sample channel (ch=1)', () => {
    expect(QSOUND_REG.sampleBank(1)).toBe(0x00); // ((1-1)<<3)&0x78
    expect(QSOUND_REG.sampleOffset(1)).toBe(0x09); // (1<<3)|1
    expect(QSOUND_REG.playbackRate(1)).toBe(0x0a); // (1<<3)|2
    expect(QSOUND_REG.volume(1)).toBe(0x0e); // (1<<3)|6
    expect(QSOUND_REG.panPosition(1)).toBe(0x81); // 1|0x80
  });

  it('matches a real CPS2 game\'s disassembled boot-reset loop for channel 0 (0-indexed reverb formula)', () => {
    // Dungeons & Dragons: Shadow over Mystara's silence-all-channels
    // routine computes reverb contribution as plain `channel + 0xba` for
    // channel = 0..15 (not ch<<3-based).
    expect(QSOUND_REG.reverbContribution(0)).toBe(0xba);
    expect(QSOUND_REG.reverbContribution(15)).toBe(0xc9);
  });

  it('wraps sampleBank and volume registers into the low byte range confirmed reachable by RLC-based address math', () => {
    for (let ch = 1; ch <= 16; ch++) {
      expect(QSOUND_REG.volume(ch)).toBeLessThanOrEqual(0xff);
      expect(QSOUND_REG.playbackRate(ch)).toBeLessThanOrEqual(0xff);
    }
  });
});

describe('QSOUND_PORT', () => {
  it('matches qsound_sub_map (src/mame/capcom/cps1.cpp, shared by cps2.cpp)', () => {
    expect(QSOUND_PORT.dataHigh).toBe(0xd000);
    expect(QSOUND_PORT.dataLow).toBe(0xd001);
    expect(QSOUND_PORT.address).toBe(0xd002);
    expect(QSOUND_PORT.bankSwitch).toBe(0xd003);
    expect(QSOUND_PORT.ready).toBe(0xd007);
  });
});
