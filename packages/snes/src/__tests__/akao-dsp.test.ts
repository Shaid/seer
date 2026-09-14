import { describe, it, expect } from 'vitest';
import { noteToResampleStep, PITCH_TABLE, decodeBrrBlob } from '../akao-dsp.js';

describe('PITCH_TABLE', () => {
  it('has 12 entries forming an equal-tempered progression (ratio ~2^(1/12)), ending at the DSP unity constant 0x1000', () => {
    expect(PITCH_TABLE.length).toBe(12);
    expect(PITCH_TABLE[11]).toBe(0x1000);
    const expectedRatio = Math.pow(2, 1 / 12);
    for (let i = 1; i < 12; i++) {
      expect(PITCH_TABLE[i]! / PITCH_TABLE[i - 1]!).toBeCloseTo(expectedRatio, 2);
    }
  });
});

describe('noteToResampleStep', () => {
  // Expected values independently computed (a separate Node one-liner transcribing the same
  // real-driver formula, not by running this file's own implementation) -- see akao-dsp.ts's
  // doc comment for the traced algorithm (docs/ffvi/snes/data-structure.md §18.9).
  it('is unity at the reference note (69) with tuning1=0', () => {
    expect(noteToResampleStep(69, 0)).toBeCloseTo(1.0, 10);
  });

  it('doubles at +12 semitones (one octave up) with tuning1=0', () => {
    expect(noteToResampleStep(81, 0)).toBeCloseTo(2.0, 10);
  });

  it('halves at -12 semitones (one octave down) with tuning1=0', () => {
    expect(noteToResampleStep(57, 0)).toBeCloseTo(0.5, 10);
  });

  it('tuning1=0x80 at the reference note halves the pitch by itself (no note change)', () => {
    expect(noteToResampleStep(69, 0x80)).toBeCloseTo(0.5, 10);
  });

  it('tuning1=0xFF at the reference note is a slight detune below unity', () => {
    expect(noteToResampleStep(69, 0xff)).toBeCloseTo(0.99609375, 10);
  });

  it('a non-reference-octave, non-unity-semitone note (70, tuning1=0) matches the traced fixed-point formula exactly', () => {
    expect(noteToResampleStep(70, 0)).toBeCloseTo(1.05908203125, 10);
  });

  it('handles a negative absNote (very low real note) via correct floor-division, not a naive negative modulo', () => {
    expect(noteToResampleStep(5, 0)).toBeCloseTo(0.0247955322265625, 10);
  });

  it('tuningOffset (from the TUNING VCMD) combines with tuning1 via 8-bit wraparound addition', () => {
    expect(noteToResampleStep(69, 0, 0x80)).toBeCloseTo(0.5, 10);
  });

  it('applies the FreqMult high-byte correction after the first fixed-point product', () => {
    // At note 69, PITCH_TABLE[11] = 0x1000. With tuning1=0xa9:
    // scaled = 0x10 * 0xa9 = 2704 (0x0a90), then
    // floor(0x40 * hi(0x0a90) / 256) = floor(640 / 256) = 2.
    // The sign-gated pitchBase add is skipped because tuning1 has bit 7 set.
    expect(noteToResampleStep(69, 0xa9, 0, 0x40)).toBe(2706 / 4096);
    expect(noteToResampleStep(69, 0xa9, 0, 0x00)).toBe(2704 / 4096);
  });
});

describe('decodeBrrBlob', () => {
  it('decodes a 2-block blob (2-byte LE length prefix + 2x9 bytes) into 32 flat PCM samples, prediction carrying across the block boundary', () => {
    const block0 = [(12 << 4) | (0 << 2), 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0];
    const block1 = [(12 << 4) | (1 << 2) | 0x01, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]; // end bit set
    const length = 18; // 2 blocks * 9 bytes
    const rom = Uint8Array.from([length & 0xff, (length >> 8) & 0xff, ...block0, ...block1]);
    const { pcm, blockCount } = decodeBrrBlob(rom, 0);
    expect(blockCount).toBe(2);
    expect(pcm.length).toBe(32);
    // First 16 samples match the standalone filter-0 block test in @seer-project/snes.
    expect(Array.from(pcm.subarray(0, 16))).toEqual([
      4096, 8192, 12288, 16384, 20480, 24576, 28672, -32768, -28672, -24576, -20480, -16384, -12288, -8192, -4096, 0,
    ]);
    // Second 16 samples match the standalone filter-1-continuing-from-(0,-2048) test in @seer-project/snes.
    expect(Array.from(pcm.subarray(16, 32))).toEqual([
      4096, 12032, 23568, -27058, -4888, 19992, -18122, 15778, -13882, 27944, 5716, -11026, -22626, -29404, -31664,
      -29686,
    ]);
  });

  it('rejects a blob whose declared length is not a multiple of the block size', () => {
    const rom = Uint8Array.from([10, 0, ...new Array(10).fill(0)]); // length=10, not a multiple of 9
    expect(() => decodeBrrBlob(rom, 0)).toThrow(/multiple of 9/);
  });
});
