import { describe, it, expect } from 'vitest';
import { parseInstr, parseSs } from '../sampled-sound.ts';
import type { InstrEmbedded, InstrExternal } from '../sampled-sound.ts';
import {
  instrumentFromSynth,
  instrumentFromSampled,
  instrumentFrom8svx,
  SmusEngine,
} from '../smus-engine.ts';
import type { SmusScore, Instrument } from '../smus-engine.ts';

/**
 * Regression tests for behavioral bugs found while consolidating
 * middilgard's tools/shared/smus-player.ts onto this package. Each test
 * hand-builds real-format bytes (no mocking) and independently computes the
 * expected value from the documented algorithm, rather than asserting
 * whatever the current code happens to produce.
 */

// ─── Byte-building helpers for real IFF/Instr/SS formats ─────────────────

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16be(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}
function fourcc(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}
function ascii(s: string, len: number): number[] {
  const bytes = fourcc(s);
  while (bytes.length < len) bytes.push(0);
  return bytes.slice(0, len);
}

function build8svxBytes(samplesPerSec: number, sampleBytes: number[]): Uint8Array {
  const vhdrBody = [
    ...u32be(0), // oneShotHiSamples
    ...u32be(0), // repeatHiSamples
    ...u32be(0), // samplesPerHiCycle
    ...u16be(samplesPerSec),
    0, // ctOctave
    0, // sCompression
  ];
  const vhdrChunk = [...fourcc('VHDR'), ...u32be(vhdrBody.length), ...vhdrBody];
  const bodyChunk = [...fourcc('BODY'), ...u32be(sampleBytes.length), ...sampleBytes];
  const formBody = [...fourcc('8SVX'), ...vhdrChunk, ...bodyChunk];
  const form = [...fourcc('FORM'), ...u32be(formBody.length), ...formBody];
  return new Uint8Array(form);
}

/** Build a 502-byte embedded (synth) .instr with a given raw shapingCurve/transferTable byte. */
function buildEmbeddedInstrBytes(rawByte: number): Uint8Array {
  const data = new Uint8Array(502);
  // Common header @0x20: typeId(u16), sampleParam(u16), name(<=28 bytes)
  // (left zeroed — not relevant to this test)
  // block @0x44, 434 bytes: waveshaper[128] + shapingCurve[128] + transferTable[128] + params[25 u16 BE]
  const block = 0x44;
  // waveshaper: leave zeroed
  data[block + 128] = rawByte; // shapingCurve[0] — raw unsigned byte
  data[block + 256] = rawByte; // transferTable[0] — raw unsigned byte (same value, unsigned path)
  // params: all zero is fine for this test (volRaw=0 -> clamped to 1 internally)
  return data;
}

/** Build a 128-byte external (SampledSound) .instr with a given overrides[0] (volume) value. */
function buildExternalInstrBytes(volumeOverride: number): Uint8Array {
  const data = new Uint8Array(128);
  data.set(ascii('SampledSound', 12), 0);
  // common header @0x20
  data.set(u16be(0), 0x20); // typeId
  data.set(u16be(0), 0x22); // sampleParam
  data.set(ascii('TestSynth', 12), 0x24); // name
  // ssStem @0x44..0x60
  data.set(ascii('TestSS', 8), 0x44);
  // @0x60: reserved, reserved, playType, envelopeId
  data.set(u16be(0), 0x60);
  data.set(u16be(0), 0x62);
  data.set(u16be(0), 0x64);
  data.set(u16be(0), 0x66);
  // overrides @0x68 (104): volume, levels[4], rates[4], vibDepth, vibRate, vibDelay
  data.set(u16be(volumeOverride), 0x68);
  data.set(u16be(255), 0x6a); // envLevels[0]
  data.set(u16be(255), 0x6c); // envLevels[1]
  data.set(u16be(200), 0x6e); // envLevels[2]
  data.set(u16be(0), 0x70); // envLevels[3]
  data.set(u16be(128), 0x72); // envRates[0]
  data.set(u16be(128), 0x74); // envRates[1]
  data.set(u16be(128), 0x76); // envRates[2]
  data.set(u16be(64), 0x78); // envRates[3]
  data.set(u16be(0), 0x7a); // vibDepth
  data.set(u16be(0), 0x7c); // vibRate
  data.set(u16be(0), 0x7e); // vibDelay
  return data;
}

function buildSsBytes(
  oneShotLen: number,
  repeatLen: number,
  loOctave: number,
  hiOctave: number,
  volume: number,
  sampleBytes: number[],
): Uint8Array {
  const header = new Uint8Array(0x3e);
  header.set(u16be(oneShotLen), 0);
  header.set(u16be(repeatLen), 2);
  header[4] = loOctave;
  header[5] = hiOctave;
  header.set(u16be(volume), 6);
  // attack/decay/sustain/release @8,10,12,14 — leave 0
  // percmode @30 — leave 0
  const out = new Uint8Array(header.length + sampleBytes.length);
  out.set(header, 0);
  out.set(Uint8Array.from(sampleBytes), header.length);
  return out;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('instrumentFromSynth modTable (fixed double-conversion bug)', () => {
  it('does not double-convert already-signed shapingCurve bytes', () => {
    // Raw byte 200 (unsigned) == -56 signed. Before the fix, the shapingCurve
    // half of modTable read this as an Int8Array element (-56) and then
    // re-applied the unsigned->signed transform, producing (-56-256)/128,
    // wildly outside the valid [-1,1] range. transferTable (a genuine
    // Uint8Array) has always decoded the same raw byte correctly, so the two
    // halves of the table must now agree for the same byte value.
    const raw = buildEmbeddedInstrBytes(200);
    const parsed = parseInstr(raw) as InstrEmbedded;
    expect(parsed.variant).toBe('embedded');

    const inst = instrumentFromSynth(parsed, 'test');
    expect(inst.modTable).not.toBeNull();
    const expected = (200 - 256) / 128.0; // -0.4375
    expect(inst.modTable![0]).toBeCloseTo(expected, 6); // shapingCurve half
    expect(inst.modTable![128]).toBeCloseTo(expected, 6); // transferTable half
    expect(inst.modTable![0]).toBeCloseTo(inst.modTable![128], 6);
  });

  it('leaves positive-byte values unaffected (no regression for the common case)', () => {
    const raw = buildEmbeddedInstrBytes(50); // < 128, positive either way
    const parsed = parseInstr(raw) as InstrEmbedded;
    const inst = instrumentFromSynth(parsed, 'test');
    expect(inst.modTable![0]).toBeCloseTo(50 / 128.0, 6);
    expect(inst.modTable![128]).toBeCloseTo(50 / 128.0, 6);
  });
});

describe('instrumentFrom8svx baseRate (fixed missing zero-rate fallback)', () => {
  it('falls back to 8363Hz when the VHDR samplesPerSec field is 0', () => {
    const raw = build8svxBytes(0, [10, 200, 5, 250]);
    const parsed = parseInstr(raw);
    expect(parsed.variant).toBe('8svx');
    if (parsed.variant !== '8svx') throw new Error('unreachable');

    const inst = instrumentFrom8svx(parsed, 'test');
    expect(inst.baseRate).toBe(8363);
  });

  it('preserves a genuine non-zero rate', () => {
    const raw = build8svxBytes(11025, [10, 200, 5, 250]);
    const parsed = parseInstr(raw);
    if (parsed.variant !== '8svx') throw new Error('unreachable');
    const inst = instrumentFrom8svx(parsed, 'test');
    expect(inst.baseRate).toBe(11025);
  });
});

describe('instrumentFromSampled volume (fixed ss.volume fallback)', () => {
  it("uses the .instr's own volume override (clamped to >=1), never the .ss file's volume", () => {
    const instrBytes = buildExternalInstrBytes(0); // .instr volume override = 0
    const parsedInstr = parseInstr(instrBytes) as InstrExternal;
    expect(parsedInstr.variant).toBe('external');
    expect(parsedInstr.externalParams.volume).toBe(0);

    const ssBytes = buildSsBytes(4, 0, 0, 0, 200, [10, 20, 30, 40]); // .ss volume = 200
    const ss = parseSs(ssBytes);
    expect(ss.volume).toBe(200);

    const inst = instrumentFromSampled(parsedInstr, ss, 'test');
    // Before the fix this would have been 200/255 (falling back to ss.volume).
    expect(inst.volume).toBeCloseTo(1 / 255, 6);
  });

  it('uses a genuine non-zero .instr volume override directly', () => {
    const instrBytes = buildExternalInstrBytes(180);
    const parsedInstr = parseInstr(instrBytes) as InstrExternal;
    const ssBytes = buildSsBytes(4, 0, 0, 0, 200, [10, 20, 30, 40]);
    const ss = parseSs(ssBytes);
    const inst = instrumentFromSampled(parsedInstr, ss, 'test');
    expect(inst.volume).toBeCloseTo(180 / 255, 6);
  });
});

describe('SmusEngine sample-loop wraparound (fixed missing i1=ls fixup)', () => {
  function makeSampleInstrument(sampleRate: number): Instrument {
    const ssData = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    return {
      name: 'loop-test',
      kind: 'sample',
      wave: ssData,
      loopStart: 0,
      loopEnd: 0,
      baseMidi: 60,
      baseRate: sampleRate * 1.5, // step = 1.5 exactly at midi 60
      volume: 1.0,
      filterBanks: null,
      modTable: null,
      // envLevels all equal to 1 (on the 0-255 scale): env saturates at exactly
      // 1/255 within a sample or two and then holds there exactly, giving a
      // known-constant envelope multiplier for the whole test window.
      envLevels: [1, 1, 1, 1],
      envRates: [224, 224, 224, 224],
      fBase: 0,
      fEnv: 0,
      fMod: 0,
      lfoRate: 0,
      lfoInc: 0,
      lfoEnable: false,
      lfoOneshot: true,
      volRaw: 255,
      volEnv: true,
      volMod: 0,
      pitchMod: 0,
      ssOneshot: 8,
      ssRepeat: 4,
      ssLo: 0,
      ssHi: 0,
      ssData,
      vibDepth: 0,
      vibRate: 0,
      vibDelay: 0,
      attack: 0.01,
      decay: 0.1,
      sustain: 0.7,
      release: 0.15,
      filterStart: 0,
      filterEnd: 0,
    };
  }

  it('blends the last loop sample toward the loop start, not toward itself', () => {
    const sr = 44100;
    const score: SmusScore = {
      tempo: 60 * 128, // bpm=60 -> beatSamples = sr at 44100
      volume: 127,
      name: 'test',
      instruments: new Map(),
      tracks: [[{ sid: 60, data: 0x00 }]], // whole note, midi 60, no chord/dot/tuplet
    };
    const instruments = new Map<number, Instrument>([[0, makeSampleInstrument(sr)]]);
    const engine = new SmusEngine(score, instruments, sr, 1.0);
    const [left] = engine.renderAll(1);

    // wave = [0.1..0.8], ssOneshot=8, ssRepeat=4 -> loop region [ls=4, le=8).
    // With step=1.5 and v.pos starting at 0, output sample index 13 lands at
    // p=19.5 -> idx = ls + ((p-ls)%ll) = 4 + (15.5%4) = 7.5, i.e. i0=7 (=le-1),
    // frac=0.5, i1=8 (=le) which must wrap to ls=4.
    // envOut is pinned at exactly 1/255 for the whole window (see envLevels),
    // and v.vol=1, so out[13] = 0.5*(wave[7] + wave[C1]) / 255.
    const wave7 = 0.8;
    const waveLs = 0.5; // wave[4]
    const fixedExpected = (0.5 * (wave7 + waveLs)) / 255;
    const buggyExpected = (0.5 * (wave7 + wave7)) / 255; // what it was before the fix

    expect(left[13]).toBeCloseTo(fixedExpected, 8);
    expect(left[13]).not.toBeCloseTo(buggyExpected, 8);
  });
});
