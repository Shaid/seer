import { describe, it, expect } from 'vitest';
import { parseInstr } from '../sampled-sound.js';
import type { InstrEmbedded } from '../sampled-sound.js';
import { SmusEngine, instrumentFromSynth } from '../smus-engine.js';
import type { SmusScore, Instrument } from '../smus-engine.js';

/**
 * Golden PCM regression fixtures, captured against the pre-refactor
 * `SmusEngine` (batch `renderBlock`/`renderAll`, inline pan-mix and
 * fractional-position resampling) before any of that machinery moves into
 * `@seer-project/audio-dsp`. Every later refactor step must leave every
 * checksum and length in this file byte-for-byte unchanged — that is the
 * whole point of capturing it first. Every expected value below was
 * captured by actually running the pre-refactor engine (not guessed) — see
 * the git history for the one-off capture script this was pinned from. If a
 * refactor step changes any of these values, the step is wrong (or, for the
 * optional `_renderVoice` -> `resampleLooped` swap, gets reverted per the
 * plan) — this file itself is never edited to make a refactor "pass".
 */

/** Deterministic checksum over a Float32Array's raw IEEE754 bit patterns (not the float value, so NaN/±0 differences aren't silently equal). */
function checksum(buf: Float32Array): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) {
    const bits = view.getUint32(i * 4, true);
    h ^= bits;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildSong(tempo: number, events: Array<{ sid: number; data: number }>): SmusScore {
  return { tempo, volume: 127, name: 'golden', instruments: new Map(), tracks: [events] };
}

const Q_NOTE = { sid: 60, data: 0x02 };

/** Same fixture shape as consolidation-fixes.test.ts's makeSampleInstrument, reused verbatim so this golden exercises the exact loop-wraparound path that test regression-guards. */
function makeSampleInstrument(sampleRate: number): Instrument {
  const ssData = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  return {
    name: 'loop-test',
    kind: 'sample',
    wave: ssData,
    loopStart: 0,
    loopEnd: 0,
    baseMidi: 60,
    baseRate: sampleRate * 1.5,
    volume: 1.0,
    filterBanks: null,
    modTable: null,
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

/** Build a 502-byte embedded (synth) .instr, same layout as consolidation-fixes.test.ts's buildEmbeddedInstrBytes, but with a non-trivial waveshaper ramp so `sonixOneFilter`'s real filter-bank math runs on non-zero input, not on Sonix's own zeroed-waveshaper edge case. */
function buildEmbeddedInstrBytes(): Uint8Array {
  const data = new Uint8Array(502);
  const block = 0x44;
  for (let i = 0; i < 128; i++) data[block + i] = (i * 2) & 0xff;
  return data;
}

describe('SmusEngine render golden (pre-refactor baseline)', () => {
  it('default-instrument note song: checksum + length + silent leading/trailing edges', () => {
    const song = buildSong(14716, Array(8).fill(Q_NOTE));
    const engine = new SmusEngine(song, new Map(), 44100, 0.28);
    const [left, right] = engine.renderAll();

    expect(left.length).toBe(right.length);
    expect(left.length).toBe(161792);
    expect(checksum(left)).toBe(1254739685);
    expect(checksum(right)).toBe(1832189381);
    expect(Array.from(left.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(left.subarray(left.length - 4))).toEqual([0, 0, 0, 0]);
  });

  it('real sample instrument (loop wraparound path): checksum + length + a known-exact sample', () => {
    const sr = 44100;
    const score: SmusScore = {
      tempo: 60 * 128,
      volume: 127,
      name: 'golden-sample',
      instruments: new Map(),
      tracks: [[{ sid: 60, data: 0x00 }]],
    };
    const instruments = new Map<number, Instrument>([[0, makeSampleInstrument(sr)]]);
    const engine = new SmusEngine(score, instruments, sr, 1.0);
    const [left, right] = engine.renderAll(1);

    expect(left.length).toBe(right.length);
    expect(left.length).toBe(45056);
    expect(checksum(left)).toBe(751259731);
    expect(checksum(right)).toBe(1093688773);
    // Independently derived in consolidation-fixes.test.ts's loop-wraparound test: 0.5*(wave[7]+wave[4])/255.
    expect(left[13]).toBeCloseTo(0.0025490198750048876, 12);
  });

  it('real embedded-synth instrument (exercises sonixOneFilter wave synthesis): checksum + length', () => {
    const raw = buildEmbeddedInstrBytes();
    const parsed = parseInstr(raw) as InstrEmbedded;
    expect(parsed.variant).toBe('embedded');
    const inst = instrumentFromSynth(parsed, 'golden-synth');

    const score: SmusScore = {
      tempo: 14716,
      volume: 127,
      name: 'golden-synth-song',
      instruments: new Map(),
      tracks: [Array(4).fill(Q_NOTE)],
    };
    const instruments = new Map<number, Instrument>([[0, inst]]);
    const engine = new SmusEngine(score, instruments, 44100, 0.28);
    const [left, right] = engine.renderAll();

    expect(left.length).toBe(right.length);
    expect(left.length).toBe(69632);
    expect(checksum(left)).toBe(3387164277);
    expect(checksum(right)).toBe(1411636677);
  });
});
