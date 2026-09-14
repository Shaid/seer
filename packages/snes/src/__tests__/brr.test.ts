import { describe, it, expect } from 'vitest';
import { decodeBrrBlock, decodeBrrHeader } from '../brr.js';

/**
 * Every expected array below was computed by an independent Python
 * transcription of the same Mesen2 `DspVoice::DecodeBrrSample` formulas,
 * including the doubled-output/16-bit-wraparound step (see `brr.ts`'s
 * module doc comment for the source and the cross-validation against
 * `everything8215/ff6`'s own independent decoder), run separately from
 * this implementation — not derived by running this code and copying its
 * output.
 */

describe('decodeBrrHeader', () => {
  it('decodes shift/filter/loop/end from the header byte layout', () => {
    // 0b1010_11_1_0 = shift 10 (0xA), filter 3, loop=1, end=0
    const h = decodeBrrHeader(0b1010_11_1_0);
    expect(h.shift).toBe(10);
    expect(h.filter).toBe(3);
    expect(h.loop).toBe(true);
    expect(h.end).toBe(false);
  });

  it('decodes end and loop bits independently', () => {
    expect(decodeBrrHeader(0b0000_00_0_1)).toMatchObject({ loop: false, end: true });
    expect(decodeBrrHeader(0b0000_00_1_1)).toMatchObject({ loop: true, end: true });
    expect(decodeBrrHeader(0b0000_00_0_0)).toMatchObject({ loop: false, end: false });
  });
});

describe('decodeBrrBlock', () => {
  it('filter 0 (direct), shift 12, from silence: matches the independent reference decode', () => {
    const block = Uint8Array.from([(12 << 4) | (0 << 2), 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    const { samples, prev1, prev2 } = decodeBrrBlock(block, 0, 0);
    expect(Array.from(samples)).toEqual([
      4096, 8192, 12288, 16384, 20480, 24576, 28672, -32768, -28672, -24576, -20480, -16384, -12288, -8192, -4096, 0,
    ]);
    expect(prev1).toBe(0);
    expect(prev2).toBe(-2048);
  });

  it('filter 1 (15/16 predictor), shift 12, continuing prediction from a prior block: exercises the real doubled-output 16-bit wraparound (not just a x2 gain), matches the independent reference decode', () => {
    const block = Uint8Array.from([(12 << 4) | (1 << 2), 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    const { samples, prev1, prev2 } = decodeBrrBlock(block, 0, -2048);
    expect(Array.from(samples)).toEqual([
      4096, 12032, 23568, -27058, -4888, 19992, -18122, 15778, -13882, 27944, 5716, -11026, -22626, -29404, -31664,
      -29686,
    ]);
    expect(prev1).toBe(-14843);
    expect(prev2).toBe(-15832);
  });

  it('filter 2, shift 4, from nonzero prev1/prev2: matches the independent reference decode', () => {
    const block = Uint8Array.from([(4 << 4) | (2 << 2), 0x01, 0x23, 0x45, 0x67, 0x76, 0x54, 0x32, 0x10]);
    const { samples, prev1, prev2 } = decodeBrrBlock(block, 100, 50);
    expect(Array.from(samples)).toEqual([
      286, 372, 470, 592, 750, 952, 1206, 1516, 1868, 2234, 2586, 2896, 3142, 3304, 3368, 3322,
    ]);
    expect(prev1).toBe(1661);
    expect(prev2).toBe(1684);
  });

  it('filter 3, shift 4, from nonzero prev1/prev2: matches the independent reference decode', () => {
    const block = Uint8Array.from([(4 << 4) | (3 << 2), 0x01, 0x23, 0x45, 0x67, 0x76, 0x54, 0x32, 0x10]);
    const { samples, prev1, prev2 } = decodeBrrBlock(block, 100, 50);
    expect(Array.from(samples)).toEqual([
      276, 346, 426, 530, 668, 848, 1074, 1350, 1662, 1984, 2292, 2570, 2800, 2972, 3080, 3118,
    ]);
    expect(prev1).toBe(1559);
    expect(prev2).toBe(1540);
  });

  it('shift 13-15 forces a fixed value regardless of nibble magnitude (the documented clamp behaviour)', () => {
    const block = Uint8Array.from([(13 << 4) | (0 << 2), 0x81, 0x23, 0x45, 0x67, 0x76, 0x54, 0x32, 0x10]);
    const { samples } = decodeBrrBlock(block, 0, 0);
    // nibble 8 (signed -8, negative) -> -0x800 pre-double; nibble 1 (signed 1, positive) -> 0
    expect(samples[0]).toBe(-4096);
    expect(samples[1]).toBe(0);
  });
});
