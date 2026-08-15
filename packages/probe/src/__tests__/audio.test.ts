import { describe, it, expect } from 'vitest';
import { buildHunkExe } from '@seer-project/amiga';
import { decodePcm, fft, modSizeClosure, scanContainers, spectrogram, sweepAudio } from '../audio.js';
import { normalizedRoughness } from '../score.js';
import { encodeRowInterleaved, randomBytes, structuredImage } from './helpers.js';

/** A slow sine (period 64 samples) as signed 16-bit big-endian mono PCM. */
function sineS16BE(samples = 8192, amplitude = 0.8): Uint8Array {
  const out = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * i) / 64) * amplitude * 32767);
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

describe('sweepAudio — the byte-order discriminator', () => {
  const pcm = sineS16BE();
  const range = { start: 0, end: pcm.length, label: 'test' };
  const result = sweepAudio(pcm, range);

  it('ranks signed 16-bit BE first and calls it plausible', () => {
    const best = result.candidates[0];
    expect(best.encoding.bits).toBe(16);
    expect(best.encoding.signed).toBe(true);
    expect(best.encoding.endian).toBe('be');
    expect(best.verdict).toBe('plausible');
  });

  it('separates correct from swapped byte order by the documented margin, restated full-scale', () => {
    const be = result.candidates.find(
      (c) => c.encoding.bits === 16 && c.encoding.signed && c.encoding.endian === 'be' && c.encoding.channels === 1,
    )!;
    const le = result.candidates.find(
      (c) => c.encoding.bits === 16 && c.encoding.signed && c.encoding.endian === 'le' && c.encoding.channels === 1,
    )!;
    // The lesson's absolute figures (700–4,300 vs ~21,800 on 16-bit) are
    // ≈ 0.01–0.07 vs ≈ 0.33 of full scale. Assert the same shape.
    expect(be.roughness).toBeLessThan(0.07);
    expect(le.roughness).toBeGreaterThan(0.15);
    expect(le.roughness / Math.max(be.roughness, 1e-6)).toBeGreaterThan(4);
    expect(le.verdict).toBe('unlikely');
  });

  it('a bitmap scores as not-audio (negative control)', () => {
    const bitmap = encodeRowInterleaved(structuredImage(64, 64), 64, 64, 3);
    const swept = sweepAudio(bitmap, { start: 0, end: bitmap.length, label: 'test' });
    for (const c of swept.candidates) expect(c.verdict).toBe('unlikely');
  });

  it('random bytes score as not-audio (negative control)', () => {
    const noise = randomBytes(16384, 11);
    const swept = sweepAudio(noise, { start: 0, end: noise.length, label: 'test' });
    for (const c of swept.candidates) expect(c.verdict).toBe('unlikely');
  });

  it('never reports a sample rate for raw PCM', () => {
    expect(result.sampleRate).toBeNull();
  });
});

describe('decodePcm', () => {
  it('normalizes every encoding to [-1, 1]', () => {
    const data = Uint8Array.from([0x00, 0x80, 0xff, 0x7f]);
    for (const enc of [
      { bits: 8 as const, signed: true, endian: null, channels: 1 as const },
      { bits: 8 as const, signed: false, endian: null, channels: 1 as const },
      { bits: 16 as const, signed: true, endian: 'be' as const, channels: 1 as const },
      { bits: 16 as const, signed: false, endian: 'le' as const, channels: 1 as const },
    ]) {
      for (const ch of decodePcm(data, 0, data.length, enc)) {
        for (const v of ch) {
          expect(v).toBeGreaterThanOrEqual(-1);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('roughness is bit-depth-independent after normalization', () => {
    // The same sine encoded 8-bit and 16-bit must score comparable roughness.
    const s16 = sineS16BE(4096);
    const s8 = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) {
      s8[i] = Math.round(Math.sin((2 * Math.PI * i) / 64) * 0.8 * 127) & 0xff;
    }
    const r16 = normalizedRoughness(
      decodePcm(s16, 0, s16.length, { bits: 16, signed: true, endian: 'be', channels: 1 })[0],
    );
    const r8 = normalizedRoughness(
      decodePcm(s8, 0, s8.length, { bits: 8, signed: true, endian: null, channels: 1 })[0],
    );
    expect(Math.abs(r16 - r8)).toBeLessThan(0.01);
  });
});

describe('container scan', () => {
  it('detects IFF 8SVX and reports the real VHDR sample rate', () => {
    const body = new Uint8Array(64).map((_, i) => Math.round(Math.sin(i / 4) * 100) & 0xff);
    const file = buildIff8svx(16726, body);
    const hits = scanContainers(file);
    const svx = hits.find((h) => h.kind === 'iff-8svx');
    expect(svx).toBeDefined();
    expect(svx!.sampleRate).toBe(16726);
    expect(svx!.offset).toBe(0);
    expect(svx!.length).toBe(file.length);
  });

  it('finds concatenated 8SVX forms at their offsets', () => {
    const body = new Uint8Array(64).map((_, i) => (i * 3) & 0x7f);
    const a = buildIff8svx(8000, body);
    const b = buildIff8svx(11025, body);
    const file = new Uint8Array(a.length + b.length);
    file.set(a, 0);
    file.set(b, a.length);
    const hits = scanContainers(file).filter((h) => h.kind === 'iff-8svx');
    expect(hits.map((h) => [h.offset, h.sampleRate])).toEqual([
      [0, 8000],
      [a.length, 11025],
    ]);
  });

  it('unwraps a HUNK executable and scans its payloads — CODE hunks wrap non-code data in the wild', () => {
    const body = new Uint8Array(64).map((_, i) => (i * 5) & 0x7f);
    const a = buildIff8svx(7046, body);
    const b = buildIff8svx(16726, body);
    const payload = new Uint8Array(a.length + b.length);
    payload.set(a, 0);
    payload.set(b, a.length);
    const exe = buildHunkExe([{ type: 'CODE', payload }]);
    const hits = scanContainers(exe);

    expect(hits.some((h) => h.kind === 'hunk-wrapped')).toBe(true);
    const voices = hits.filter((h) => h.kind === 'iff-8svx');
    expect(voices).toHaveLength(2);
    expect(voices.map((h) => h.sampleRate)).toEqual([7046, 16726]);
    // Offsets are absolute file offsets, inside the hunk payload.
    expect(voices[0].offset).toBeGreaterThan(0);
    expect(voices[1].offset).toBe(voices[0].offset + a.length);
    expect(voices[0].detail).toMatch(/inside CODE hunk 0/);
    // The reported spans must decode standalone.
    for (const v of voices) {
      expect(exe.subarray(v.offset, v.offset + 4)).toEqual(Uint8Array.from([0x46, 0x4f, 0x52, 0x4d]));
    }
  });

  it('a stray "FORM" string without a sane size field is not a hit', () => {
    const junk = new Uint8Array(256);
    junk.set([0x46, 0x4f, 0x52, 0x4d, 0xff, 0xff, 0xff, 0xff], 10); // size field is absurd
    expect(scanContainers(junk).filter((h) => h.kind.startsWith('iff-'))).toEqual([]);
  });

  it('detects a MOD by magic and verifies the size-closure invariant', () => {
    const mod = buildMinimalMod();
    const closure = modSizeClosure(mod);
    expect(closure).not.toBeNull();
    expect(closure!.patterns).toBe(1);
    expect(closure!.matches).toBe(true);
    expect(scanContainers(mod).some((h) => h.kind === 'mod')).toBe(true);

    // Truncating the file breaks closure — the structural check catches it.
    expect(modSizeClosure(mod.subarray(0, mod.length - 10))!.matches).toBe(false);
  });

  it('finds nothing in random bytes', () => {
    expect(scanContainers(randomBytes(4096, 3))).toEqual([]);
  });
});

describe('fft/spectrogram', () => {
  it('a pure tone concentrates energy in one bin', () => {
    const n = 256;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 8 * i) / n);
    fft(re, im);
    const mags = Array.from({ length: n / 2 }, (_, b) => Math.hypot(re[b], im[b]));
    const peak = mags.indexOf(Math.max(...mags));
    expect(peak).toBe(8);
  });

  it('spectrogram shape matches its inputs', () => {
    const samples = new Float32Array(4096).map((_, i) => Math.sin(i / 10));
    const spec = spectrogram(samples);
    expect(spec.bins).toBe(128);
    expect(spec.mags.length).toBe(spec.cols * spec.bins);
  });
});

// ── fixtures ───────────────────────────────────────────────────────────

function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function buildIff8svx(samplesPerSec: number, body: Uint8Array): Uint8Array {
  const vhdr = [
    ...be32(body.length), // oneShotHiSamples
    ...be32(0), // repeatHiSamples
    ...be32(0), // samplesPerHiCycle
    (samplesPerSec >> 8) & 0xff,
    samplesPerSec & 0xff,
    1, // ctOctave
    0, // sCompression
    ...be32(0x10000), // volume
  ];
  const chunks = [
    ...[0x38, 0x53, 0x56, 0x58], // '8SVX'
    ...[0x56, 0x48, 0x44, 0x52], // 'VHDR'
    ...be32(vhdr.length),
    ...vhdr,
    ...[0x42, 0x4f, 0x44, 0x59], // 'BODY'
    ...be32(body.length),
    ...body,
  ];
  const padded = chunks.length % 2 ? [...chunks, 0] : chunks;
  return Uint8Array.from([
    0x46, 0x4f, 0x52, 0x4d, // 'FORM'
    ...be32(padded.length),
    ...padded,
  ]);
}

function buildMinimalMod(): Uint8Array {
  const sampleWords = 100;
  const out = new Uint8Array(1084 + 1024 + sampleWords * 2);
  const title = 'PROBE TEST MOD';
  for (let i = 0; i < title.length; i++) out[i] = title.charCodeAt(i);
  // Sample 0 header: name(22) + length-in-words at +22.
  out[20 + 22] = (sampleWords >> 8) & 0xff;
  out[20 + 23] = sampleWords & 0xff;
  out[950] = 1; // song length
  // Pattern table all zeros → 1 pattern.
  out.set([0x4d, 0x2e, 0x4b, 0x2e], 1080); // 'M.K.'
  return out;
}
