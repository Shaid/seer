import { describe, it, expect } from 'vitest';
import { SpuReverb, SPU_REVERB_BASE, SPU_REVERB_PRESETS } from '../spu-reverb.js';

/** libspu's documented reverb work-area size per mode, in bytes. */
const LIBSPU_WORK_AREA_BYTES = [0x10, 0x26c0, 0x1f40, 0x4840, 0x6fe0, 0xade0, 0xf6c0, 0x18040, 0x18040, 0x3c00];

const F = { mLSAME: 10, dLSAME: 16, vLIN: 30, vRIN: 31 };

function impulse(mode: number, seconds: number): Float32Array {
  const rv = new SpuReverb(mode);
  const n = Math.round(44100 * seconds);
  const out = new Float32Array(n);
  const tmp: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    rv.step(i === 0 ? 1 : 0, 0, tmp);
    out[i] = tmp[0];
  }
  return out;
}

describe('libspu reverb tables', () => {
  it("the work-area base table reproduces libspu's documented per-mode area sizes exactly", () => {
    expect(SPU_REVERB_BASE.map((b) => 0x80000 - b * 8)).toEqual(LIBSPU_WORK_AREA_BYTES);
  });

  it("every preset's address fields fit its work area under the 8-byte unit reading", () => {
    for (let mode = 1; mode < SPU_REVERB_PRESETS.length; mode++) {
      const p = SPU_REVERB_PRESETS[mode]!;
      const maxAddr = Math.max(...p.slice(10, 30));
      const area = LIBSPU_WORK_AREA_BYTES[mode]!;
      expect(maxAddr * 8).toBeLessThanOrEqual(area);
      if (mode <= 6) expect(area - maxAddr * 8).toBeLessThanOrEqual(64);
    }
  });

  it('every preset ends with vLIN = vRIN = 0x8000', () => {
    for (let mode = 1; mode < SPU_REVERB_PRESETS.length; mode++) {
      expect(SPU_REVERB_PRESETS[mode]![F.vLIN]).toBe(0x8000);
      expect(SPU_REVERB_PRESETS[mode]![F.vRIN]).toBe(0x8000);
    }
  });
});

describe('SpuReverb', () => {
  it('mode 0 (SPU_REV_MODE_OFF) is disabled', () => {
    expect(new SpuReverb(0).enabled).toBe(false);
    expect(new SpuReverb(4).enabled).toBe(true);
  });

  it('mode 8 (DELAY) emits exactly one echo, at the delay its own preset predicts', () => {
    const p = SPU_REVERB_PRESETS[8]!;
    const predicted = ((p[F.mLSAME]! - p[F.dLSAME]!) * 4) / 22050;
    expect(predicted).toBeCloseTo(0.742, 3);

    const y = impulse(8, 2);
    let peak = 0;
    let peakAt = -1;
    let loud = 0;
    for (let i = 0; i < y.length; i++) {
      if (Math.abs(y[i]!) > 0.05) loud++;
      if (Math.abs(y[i]!) > peak) {
        peak = Math.abs(y[i]!);
        peakAt = i;
      }
    }
    expect(loud).toBeLessThan(16);
    expect(peakAt / 44100 - predicted).toBeGreaterThan(0.0005);
    expect(peakAt / 44100 - predicted).toBeLessThan(0.002);
  });

  it('mode 7 (ECHO) is the same delay but repeats, because vWALL is non-zero', () => {
    expect(SPU_REVERB_PRESETS[7]![7]).toBe(0x8100);
    expect(SPU_REVERB_PRESETS[8]![7]).toBe(0x0000);
    const loud = (mode: number): number => {
      let n = 0;
      for (const v of impulse(mode, 3)) if (Math.abs(v) > 0.05) n++;
      return n;
    };
    expect(loud(7)).toBeGreaterThan(loud(8) * 2);
  });

  it('mode 4 (STUDIO_C) decays smoothly and stays bounded', () => {
    const y = impulse(4, 4);
    const win = 11025;
    const rms: number[] = [];
    for (let s = 0; s + win <= y.length; s += win) {
      let e = 0;
      for (let i = s; i < s + win; i++) e += y[i]! * y[i]!;
      rms.push(10 * Math.log10(e / win + 1e-30));
    }
    for (let i = 1; i < rms.length; i++) expect(rms[i]!).toBeLessThan(rms[i - 1]!);
    let peak = 0;
    for (const v of y) if (Math.abs(v) > peak) peak = Math.abs(v);
    expect(peak).toBeLessThan(1);
    expect(rms[0]! - rms[4]!).toBeGreaterThan(15);
    expect(rms[0]! - rms[4]!).toBeLessThan(40);
  });

  it('an all-zero input produces an all-zero output', () => {
    const rv = new SpuReverb(4);
    const tmp: [number, number] = [0, 0];
    for (let i = 0; i < 44100; i++) {
      rv.step(0, 0, tmp);
      expect(tmp[0]).toBe(0);
      expect(tmp[1]).toBe(0);
    }
  });
});
