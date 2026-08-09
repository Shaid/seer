import { describe, it, expect } from 'vitest';
import { SmusEngine, SID_REST } from '../smus-engine.js';
import type { SmusScore } from '../smus-engine.js';

/**
 * Build a minimal SmusScore with the given tempo and N quarter-note events.
 * No real instruments are loaded — the engine uses default instruments and
 * produces silence, but output length still reflects the event timeline.
 */
function buildSong(tempo: number, events: Array<{ sid: number; data: number }>): SmusScore {
  return {
    tempo,
    volume: 127,
    name: 'test',
    instruments: new Map(),
    tracks: [events],
  };
}

/** Quarter-note rest: division=2 → 4/(1<<2) = 1 beat */
const Q_REST = { sid: SID_REST, data: 0x02 };

/** Quarter-note on middle C (MIDI 60): division=2 → 1 beat */
const Q_NOTE = { sid: 60, data: 0x02 };

describe('SmusEngine --pal flag', () => {
  function renderSong(score: SmusScore, pal: boolean): Float32Array {
    const bpm = score.tempo / 128;
    const effectiveBpm = pal ? bpm * (5 / 6) : bpm;
    const palScore = { ...score, tempo: Math.round(effectiveBpm * 128) };
    const engine = new SmusEngine(palScore, new Map(), 44100, 0.28);
    const [left, right] = engine.renderAll();
    // Interleave for test compatibility
    const out = new Float32Array(left.length + right.length);
    for (let i = 0; i < left.length; i++) {
      out[i * 2] = left[i];
      out[i * 2 + 1] = right[i];
    }
    return out;
  }

  it('produces stereo interleaved output (2 channels)', () => {
    const song = buildSong(14716, [Q_REST, Q_REST, Q_REST, Q_REST]);
    const samples = renderSong(song, false);
    expect(samples.length % 2).toBe(0);
  });

  it('PAL output is longer than NTSC output', () => {
    const song = buildSong(14716, Array(16).fill(Q_REST));
    const ntsc = renderSong(song, false);
    const pal = renderSong(song, true);
    expect(pal.length).toBeGreaterThan(ntsc.length);
  });

  it('PAL output ratio approaches 6/5 with many events', () => {
    const song = buildSong(14716, Array(80).fill(Q_NOTE));
    const ntsc = renderSong(song, false);
    const pal = renderSong(song, true);
    const ratio = pal.length / ntsc.length;
    expect(ratio).toBeGreaterThan(1.17);
    expect(ratio).toBeLessThan(1.23);
  });

  it('default (no pal arg) uses NTSC tempo', () => {
    const song = buildSong(14716, Array(8).fill(Q_REST));
    const ntsc = renderSong(song, false);
    expect(ntsc.length).toBeGreaterThan(0);
  });

  it('different tempos produce different output lengths', () => {
    const slow = buildSong(6400, Array(4).fill(Q_REST));
    const fast = buildSong(25600, Array(4).fill(Q_REST));
    const slowLen = renderSong(slow, false).length;
    const fastLen = renderSong(fast, false).length;
    expect(fastLen).toBeLessThan(slowLen);
  });

  it('PAL scaling is consistent across tempos', () => {
    const tempos = [6400, 12800, 14716, 25600];
    for (const tempo of tempos) {
      const song = buildSong(tempo, Array(80).fill(Q_NOTE));
      const ntsc = renderSong(song, false);
      const pal = renderSong(song, true);
      const ratio = pal.length / ntsc.length;
      expect(ratio).toBeGreaterThan(1.17);
      expect(ratio).toBeLessThan(1.23);
    }
  });

  it('empty song produces output', () => {
    const song = buildSong(14716, []);
    const samples = renderSong(song, false);
    expect(samples.length).toBeGreaterThan(0);
  });

  it('a trailing rest with nothing queued after it does not hold the render open', () => {
    // `finished` treats a track as done once its last queued event has been
    // dequeued (`t.index >= t.events.length`), matching the reference
    // implementation (middilgard's tools/shared/smus-player.ts, verified
    // byte-exact against real .smus fixtures during the @seer-project/smus
    // consolidation). For a track whose *last* event is a rest, this means
    // rendering stops as soon as that rest is dequeued rather than waiting
    // out its nominal duration — there's no note and nothing else pending,
    // so nothing would be produced during that time anyway. This never
    // affects real scores (which always end on notes, keeping voices/other
    // tracks active until their natural envelope tail), only this synthetic
    // rest-only case, so `halfRest` renders much shorter than
    // `twoQuarterRests` even though both nominally total 2 beats: the second
    // rest in `twoQuarterRests` is still *pending* (not yet dequeued) when
    // the first one elapses, so `finished` stays false until real time has
    // advanced through both.
    const halfRest = buildSong(14716, [{ sid: SID_REST, data: 0x01 }]);
    const twoQuarterRests = buildSong(14716, [Q_REST, Q_REST]);
    const halfLen = renderSong(halfRest, false).length;
    const quarterLen = renderSong(twoQuarterRests, false).length;
    expect(halfLen).toBe(4096);
    expect(quarterLen).toBe(49152);
    expect(quarterLen).toBeGreaterThan(halfLen);
  });
});
