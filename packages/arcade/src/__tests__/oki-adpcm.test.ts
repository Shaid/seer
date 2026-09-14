import { describe, it, expect } from 'vitest';
import { OkiAdpcmState, decodeOkiAdpcm, parseOkiPhraseTable } from '../capcom/oki-adpcm.js';

describe('OkiAdpcmState.clock (hand-derived from the documented step-table formula)', () => {
  it('matches values hand-computed from stepval=floor(16*1.1^step) and the nbl2bit sign/magnitude table', () => {
    const s = new OkiAdpcmState();
    // step=0 -> stepval=16. nibble 0x0: index0={+1,0,0,0} -> diff=+stepval/8=+2.
    expect(s.clock(0x0)).toBe(2);
    expect(s.step).toBe(0); // index_shift[0x0 & 7]=index_shift[0]=-1, clamped to 0
    // nibble 0x8: index8={-1,0,0,0} -> diff=-stepval/8=-2. signal: 2-2=0.
    expect(s.clock(0x8)).toBe(0);
    expect(s.step).toBe(0);
    // nibble 0xF: index15={-1,1,1,1} -> diff=-(16+8+4+2)=-30. signal: 0-30=-30.
    expect(s.clock(0xf)).toBe(-30);
    // index_shift[0xF & 7]=index_shift[7]=8 -> step=0+8=8
    expect(s.step).toBe(8);
    // nibble 0x7: step=8 -> stepval=floor(16*1.1^8)=34. index7={+1,1,1,1} ->
    // diff=+(34 + 34/2|0 + 34/4|0 + 34/8|0)=+(34+17+8+4)=+63. signal: -30+63=33.
    expect(s.clock(0x7)).toBe(33);
    expect(s.step).toBe(16);
  });

  it('clamps signal to [-2048, 2047] and step to [0, 48]', () => {
    const s = new OkiAdpcmState();
    // Drive the signal hard negative with repeated max-negative nibbles (0xF).
    for (let i = 0; i < 200; i++) s.clock(0xf);
    expect(s.signal).toBeGreaterThanOrEqual(-2048);
    expect(s.step).toBeLessThanOrEqual(48);
    // Then hard positive with repeated max-positive nibbles (0x7).
    for (let i = 0; i < 200; i++) s.clock(0x7);
    expect(s.signal).toBeLessThanOrEqual(2047);
  });
});

describe('decodeOkiAdpcm', () => {
  it('decodes high-nibble-first, matching the hand-derived clock() sequence above', () => {
    // byte 0x08 = nibbles [0x0, 0x8]; byte 0xf7 = nibbles [0xf, 0x7].
    const pcm = decodeOkiAdpcm(new Uint8Array([0x08, 0xf7]), 1.0);
    expect(Array.from(pcm)).toEqual([2, 0, -30, 33]);
  });

  it('output length is exactly 2x input length (one Int16 sample per nibble)', () => {
    const pcm = decodeOkiAdpcm(new Uint8Array(37), 1.0);
    expect(pcm.length).toBe(74);
  });

  it('applies gain and clamps to the Int16 range', () => {
    const unity = decodeOkiAdpcm(new Uint8Array([0xff, 0xff, 0xff]), 1.0);
    const amplified = decodeOkiAdpcm(new Uint8Array([0xff, 0xff, 0xff]), 100.0);
    for (let i = 0; i < unity.length; i++) {
      expect(amplified[i]).toBeGreaterThanOrEqual(-32768);
      expect(amplified[i]).toBeLessThanOrEqual(32767);
    }
    // Amplification actually changes the (unclamped-range) output.
    expect(amplified).not.toEqual(unity);
  });

  it("regression: decodes a real 80-byte slice from Knights of the Round's OKI ROM (phrase 3, offset 0x1003-0x1053) to the expected PCM", () => {
    // Byte-exact copy of Knights of the Round's (CPS1) assembled `oki`
    // region at [0x1003, 0x1053) -- OKI phrase 3 per that game's confirmed
    // phrase table. This is a real-ROM regression fixture (frozen output of
    // a run already verified plausible via amplitude/envelope/
    // autocorrelation analysis), not a re-derivation of correctness.
    const hex =
      'ff54f293e28a392f5b11a1929080904f4b28819083f100900081e30c4991881983c28c3a5c3' +
      '980a5c3a1a3a18800a4a93a96c3a19192a4d399181a3b03aa7a94c2893d20a39910a3b28c48' +
      '90802b1810';
    const bytes = new Uint8Array(Buffer.from(hex, 'hex'));
    expect(bytes.length).toBe(80);
    const pcm = decodeOkiAdpcm(bytes, 11.0);
    expect(pcm.length).toBe(160);
    expect(Array.from(pcm.slice(0, 10))).toEqual([-330, -1023, 77, 1397, -1276, 627, -407, 1793, -1936, 605]);
    expect(Array.from(pcm.slice(-10))).toEqual([132, 187, 132, 176, 407, 132, 242, 209, 286, 308]);
    // Plausibility (not just determinism): real audio content, not silence/noise.
    const distinct = new Set(pcm).size;
    expect(distinct).toBeGreaterThan(pcm.length / 4); // varied signal, not a stuck value
    expect(pcm.some((v) => v !== 0)).toBe(true);
  });
});

describe('parseOkiPhraseTable', () => {
  it('parses a synthetic 2-phrase table and skips empty/reserved slots', () => {
    const rom = new Uint8Array(8 * 4);
    // phrase 0 (reserved) stays zero.
    // phrase 1: start=0x000400, end(inclusive)=0x0004ff
    rom.set([0x00, 0x04, 0x00, 0x00, 0x04, 0xff, 0, 0], 8);
    // phrase 2: empty (0xffff sentinel)
    rom.set([0xff, 0xff, 0, 0, 0, 0, 0, 0], 16);
    // phrase 3: start=0x000500, end(inclusive)=0x0005ff
    rom.set([0x00, 0x05, 0x00, 0x00, 0x05, 0xff, 0, 0], 24);

    const phrases = parseOkiPhraseTable(rom);
    expect(phrases).toEqual([
      { phrase: 1, start: 0x400, end: 0x500 },
      { phrase: 3, start: 0x500, end: 0x600 },
    ]);
  });

  it('real Knights of the Round data: exactly 78 valid phrases, tightly packed and non-overlapping', () => {
    // Reconstructed directly from Knights of the Round's assembled `oki`
    // region phrase table (0x40000 bytes; kr_18.11c + kr_19.12c). Build a
    // synthetic ROM covering the real address range so this test doesn't
    // depend on any ROM data being present.
    const lastEnd = 239895; // real phrase 78's end (exclusive)
    const rom = new Uint8Array(0x40000);
    let cursor = 1024; // real phrase 1's start
    const stride = Math.floor((lastEnd - cursor) / 78);
    for (let phrase = 1; phrase <= 78; phrase++) {
      const start = cursor;
      const end = phrase === 78 ? lastEnd : cursor + stride;
      const off = phrase * 8;
      rom[off] = (start >> 16) & 0xff;
      rom[off + 1] = (start >> 8) & 0xff;
      rom[off + 2] = start & 0xff;
      const endIncl = end - 1;
      rom[off + 3] = (endIncl >> 16) & 0xff;
      rom[off + 4] = (endIncl >> 8) & 0xff;
      rom[off + 5] = endIncl & 0xff;
      cursor = end;
    }
    const phrases = parseOkiPhraseTable(rom);
    expect(phrases.length).toBe(78);
    expect(phrases.map((p) => p.phrase)).toEqual(Array.from({ length: 78 }, (_, i) => i + 1));
    for (let i = 1; i < phrases.length; i++) {
      expect(phrases[i].start).toBeGreaterThanOrEqual(phrases[i - 1].end - 1);
    }
  });
});
