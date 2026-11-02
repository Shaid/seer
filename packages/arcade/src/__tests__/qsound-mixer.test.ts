import { describe, it, expect } from 'vitest';
import {
  QsoundMixer,
  QSOUND_PAN_BASE,
  QSOUND_PAN_TABLE,
  QSOUND_SAMPLE_RATE,
  qsoundPanGains,
} from '../capcom/qsound-mixer.js';

/** A 2-bank ROM: bank 0 = a ramp 0..255 (as signed bytes), bank 1 = constant 0x40. */
function rom(): Uint8Array {
  const r = new Uint8Array(0x20000);
  for (let i = 0; i < 0x10000; i++) r[i] = i & 0xff;
  r.fill(0x40, 0x10000);
  return r;
}

const s8 = (b: number): number => (b < 0x80 ? b : b - 0x100);

/** Key a voice on as the CPS2 driver does (sample select, then key-on). */
function keyOn(m: QsoundMixer, ch: number, o: { bank: number; start: number; end: number; loop: number; rate: number; volume: number; pan?: number }): void {
  const b = ch << 3;
  m.write(b + 2, 0);
  m.write(b + 1, o.start);
  m.write(b + 5, o.end);
  m.write(b + 4, o.end - o.loop);
  m.write(((ch - 1) << 3) & 0x78, 0x8000 | o.bank);
  m.write(0x80 + ch, QSOUND_PAN_BASE + (o.pan ?? 16));
  m.write(b + 3, 0);
  m.write(b + 6, o.volume);
  m.write(b + 2, o.rate);
}

function run(m: QsoundMixer, n: number): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  m.render(l, r, 0, n);
  return { l, r };
}

describe('qsoundPanGains / QSOUND_PAN_TABLE', () => {
  it('is an equal-power law: hard left, centre, hard right', () => {
    expect(qsoundPanGains(0)).toEqual([1, 0]);
    expect(qsoundPanGains(32)).toEqual([0, 1]);
    const [l, r] = qsoundPanGains(16);
    expect(l).toBeCloseTo(Math.SQRT1_2, 12);
    expect(r).toBeCloseTo(Math.SQRT1_2, 12);
    for (let p = 0; p <= 32; p++) {
      const [a, b] = qsoundPanGains(p);
      expect(a * a + b * b).toBeCloseTo(1, 12);
    }
  });

  it('clamps positions outside 0..32 (the DSP 3D positions)', () => {
    expect(qsoundPanGains(97)).toEqual([0, 1]);
    expect(qsoundPanGains(-5)).toEqual([1, 0]);
    expect(QSOUND_PAN_TABLE.length).toBe(33);
  });
});

describe('QsoundMixer register model', () => {
  it('the bank register of voice ch lives at ((ch - 1) << 3) & 0x78 (applies to the next channel)', () => {
    const m = new QsoundMixer({ rom: rom() });
    m.write(0x00, 0x8001); // voice 1's bank
    m.write(0x78, 0x8001); // voice 0's bank
    expect(m.voice(1).bank).toBe(1);
    expect(m.voice(0).bank).toBe(1);
    expect(m.voice(2).bank).toBe(0);
  });

  it('decodes rate / address / phase / loop / end / volume / pan / echo send', () => {
    const m = new QsoundMixer({ rom: rom() });
    m.write(0x18 + 1, 0x1234);
    m.write(0x18 + 3, 0x8000);
    m.write(0x18 + 2, 0x2000);
    m.write(0x18 + 4, 0x10);
    m.write(0x18 + 5, 0x2000);
    m.write(0x18 + 6, 0x1ffd);
    m.write(0x83, QSOUND_PAN_BASE + 4);
    m.write(0xbd, 0x400);
    expect(m.voice(3)).toEqual({ bank: 0, position: 0x1234 + 0.5, rate: 0x2000, loopLength: 0x10, end: 0x2000, volume: 0x1ffd, pan: 4, echoSend: 0x400 });
    expect(m.read(0x83)).toBe(QSOUND_PAN_BASE + 4);
  });
});

describe('QsoundMixer playback', () => {
  it('plays ROM bytes as signed 8-bit << 8, scaled by volume / 0x4000 (no interpolation by default)', () => {
    const m = new QsoundMixer({ rom: rom(), echo: false });
    keyOn(m, 0, { bank: 0, start: 0x10, end: 0x100, loop: 0x10, rate: 0x1000, volume: 0x4000, pan: 0 });
    const { l, r } = run(m, 8);
    for (let i = 0; i < 8; i++) {
      expect(l[i]).toBeCloseTo((s8(0x10 + i) * 256) / 32768, 6);
      expect(r[i]).toBe(0);
    }
  });

  it('rate 0x2000 skips every other sample; rate 0x800 holds each sample twice', () => {
    const m = new QsoundMixer({ rom: rom(), echo: false });
    keyOn(m, 0, { bank: 0, start: 0, end: 0x100, loop: 0, rate: 0x2000, volume: 0x4000, pan: 0 });
    keyOn(m, 1, { bank: 0, start: 0, end: 0x100, loop: 0, rate: 0x800, volume: 0x4000, pan: 32 });
    const { l, r } = run(m, 6);
    expect(Array.from(l, (x) => Math.round((x * 32768) / 256))).toEqual([0, 2, 4, 6, 8, 10]);
    expect(Array.from(r, (x) => Math.round((x * 32768) / 256))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('loops: reaching end subtracts the loop length; the bank selects the 64 KB page', () => {
    const m = new QsoundMixer({ rom: rom(), echo: false });
    keyOn(m, 5, { bank: 0, start: 0x20, end: 0x24, loop: 0x22, rate: 0x1000, volume: 0x4000, pan: 0 });
    const { l } = run(m, 8);
    expect(Array.from(l, (x) => Math.round((x * 32768) / 256))).toEqual([0x20, 0x21, 0x22, 0x23, 0x22, 0x23, 0x22, 0x23]);
    const m2 = new QsoundMixer({ rom: rom(), echo: false });
    keyOn(m2, 7, { bank: 1, start: 0, end: 0x100, loop: 0, rate: 0x1000, volume: 0x2000, pan: 0 });
    expect(Math.round((run(m2, 1).l[0] * 32768) / 128)).toBe(0x40);
  });

  it('pans with the table, sums voices, and mixes at another output rate by scaling the step', () => {
    const m = new QsoundMixer({ rom: rom(), echo: false });
    keyOn(m, 0, { bank: 1, start: 0, end: 0x100, loop: 0x80, rate: 0x1000, volume: 0x4000, pan: 16 });
    keyOn(m, 9, { bank: 1, start: 0, end: 0x100, loop: 0x80, rate: 0x1000, volume: 0x4000, pan: 32 });
    const { l, r } = run(m, 1);
    const one = (0x40 * 256) / 32768;
    expect(l[0]).toBeCloseTo(one * Math.SQRT1_2, 6);
    expect(r[0]).toBeCloseTo(one * (1 + Math.SQRT1_2), 6);

    const fast = new QsoundMixer({ rom: rom(), echo: false, outputRate: QSOUND_SAMPLE_RATE / 2 });
    keyOn(fast, 0, { bank: 0, start: 0, end: 0x100, loop: 0, rate: 0x1000, volume: 0x4000, pan: 0 });
    expect(Array.from(run(fast, 4).l, (x) => Math.round((x * 32768) / 256))).toEqual([0, 2, 4, 6]);
  });

  it('linear interpolation blends neighbouring samples', () => {
    const m = new QsoundMixer({ rom: rom(), echo: false, interpolation: 'linear' });
    keyOn(m, 0, { bank: 0, start: 0x10, end: 0x100, loop: 0, rate: 0x800, volume: 0x4000, pan: 0 });
    const { l } = run(m, 4);
    expect(Array.from(l, (x) => (x * 32768) / 256)).toEqual([16, 16.5, 17, 17.5]);
  });

  it('echo: a voice with a send produces a decaying delayed copy; without sends the echo stays silent', () => {
    const r = rom();
    const m = new QsoundMixer({ rom: r });
    m.write(0x93, 0x27ff);
    m.write(0xd9, 0x554 + 100); // 100-sample delay at the DSP rate
    keyOn(m, 0, { bank: 1, start: 0, end: 0x100, loop: 0x80, rate: 0x1000, volume: 0x4000, pan: 0 });
    m.write(0xba, 0x4000);
    run(m, 50);
    m.write(6, 0); // voice off: only the echo remains
    const { l, r: right } = run(m, 400);
    // left = right = echo once the voice is off
    for (let i = 0; i < 400; i++) expect(l[i]).toBeCloseTo(right[i], 9);
    const peak = (a: Float32Array, from: number, to: number) => Math.max(...Array.from(a.subarray(from, to), Math.abs));
    expect(peak(l, 0, 100)).toBeGreaterThan(0.1);
    // decays with feedback 0x27ff / 0x4000 = 0.62 per pass
    expect(peak(l, 300, 400)).toBeLessThan(peak(l, 0, 100));
    for (const x of l) expect(Number.isFinite(x)).toBe(true);

    const quiet = new QsoundMixer({ rom: r });
    quiet.write(0x93, 0x27ff);
    quiet.write(0xd9, 0x7ff);
    keyOn(quiet, 0, { bank: 1, start: 0, end: 0x100, loop: 0x80, rate: 0x1000, volume: 0x4000, pan: 0 });
    const a = run(quiet, 2000);
    expect(Math.max(...Array.from(a.r, Math.abs))).toBe(0);
  });

  it('reset silences every voice', () => {
    const m = new QsoundMixer({ rom: rom() });
    keyOn(m, 0, { bank: 1, start: 0, end: 0x100, loop: 0x80, rate: 0x1000, volume: 0x4000 });
    m.reset();
    const { l, r } = run(m, 64);
    expect(Math.max(...Array.from(l, Math.abs), ...Array.from(r, Math.abs))).toBe(0);
    expect(m.voice(0).pan).toBe(16);
  });
});
