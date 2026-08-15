import { describe, it, expect } from 'vitest';
import { classifyRegions, classifyWindow, m68kOpcodeFraction } from '../classify.js';
import { randomBytes } from './helpers.js';

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const N = 4096;
const zeros = new Uint8Array(N);
const patterned = new Uint8Array(N).map((_, i) => [0xde, 0xad, 0xbe, 0xef][i % 4]);
const asciiText = new Uint8Array(N).map(
  (_, i) => 'The quick brown fox jumps over the lazy dog. '.charCodeAt(i % 45),
);
const random = randomBytes(N);

describe('classifyRegions', () => {
  it('segments a synthetic zero/patterned/ascii/random file with correct boundaries', () => {
    const data = concat(zeros, patterned, asciiText, random);
    const regions = classifyRegions(data, 256);

    expect(regions.map((r) => r.class)).toEqual([
      'zero-fill',
      'patterned-fill',
      'ascii-text',
      'compressed-or-encrypted',
    ]);
    expect(regions.map((r) => [r.start, r.end])).toEqual([
      [0, N],
      [N, 2 * N],
      [2 * N, 3 * N],
      [3 * N, 4 * N],
    ]);
    for (const r of regions) expect(r.len).toBe(r.end - r.start);
  });

  it('patterned fill is NOT reported as zero-fill', () => {
    const regions = classifyRegions(patterned, 256);
    expect(regions).toHaveLength(1);
    expect(regions[0].class).toBe('patterned-fill');
  });

  it('high entropy carries the trivially-ciphered caveat in its note', () => {
    const [r] = classifyRegions(random, 256);
    expect(r.class).toBe('compressed-or-encrypted');
    expect(r.note).toMatch(/trivially ciphered/);
  });

  it('absorbs a lone dissenting window between agreeing neighbours', () => {
    const data = concat(zeros, patterned.subarray(0, 256), zeros);
    const regions = classifyRegions(data, 256);
    expect(regions).toHaveLength(1);
    expect(regions[0].class).toBe('zero-fill');
  });
});

describe('classifyWindow guardrails', () => {
  it('weak hints keep their ? suffix in the class name itself', () => {
    // A NOP sled is unambiguous 68k... but even so the class stays a hint.
    const nops = new Uint8Array(512);
    for (let i = 0; i < nops.length; i += 4) {
      nops.set([0x4e, 0x71, 0x2f, 0x08], i); // NOP; MOVE.L A0,-(A7)
    }
    const w = classifyWindow(nops, 0, 512);
    if (w.class.startsWith('m68k')) expect(w.class).toBe('m68k-code?');
  });

  it('entropy gates every class: constant-ish bytes never classify as code or audio', () => {
    const w = classifyWindow(patterned, 0, 512);
    expect(['patterned-fill', 'zero-fill', 'mixed']).toContain(w.class);
  });
});

describe('m68kOpcodeFraction', () => {
  it('scores instruction-like words far above random words', () => {
    const code = new Uint8Array(512);
    for (let i = 0; i < code.length; i += 8) {
      code.set([0x48, 0xe7, 0x80, 0x80, 0x4e, 0xb9, 0x4e, 0x75], i); // MOVEM push; JSR; RTS
    }
    expect(m68kOpcodeFraction(code)).toBeGreaterThan(0.5);
    expect(m68kOpcodeFraction(randomBytes(512, 7))).toBeLessThan(0.5);
  });
});
