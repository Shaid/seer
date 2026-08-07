import { describe, it, expect } from 'vitest';
import { Module } from '../micromod.ts';
import { buildMod } from './mod-fixture.ts';

/**
 * `Module` is the MOD *parser* half of the bundled Micromod port — pure,
 * synchronous, and completely independent of Web Audio, so it can be pinned
 * down exactly. These cover the header decoding, the period→key table lookup,
 * and the instrument-header edge cases (signed finetune nibble, volume
 * masking, degenerate loops, truncated sample data) that a malformed or
 * unusual real-world module would hit.
 */
describe('Module', () => {
  it('constructs a blank module with no data', () => {
    const mod = new Module();
    expect(mod.songName).toBe('Blank');
    expect(mod.numChannels).toBe(4);
    expect(mod.numPatterns).toBe(1);
    expect(mod.sequenceLength).toBe(1);
  });

  it('reads the song name, substituting spaces for control characters', () => {
    const mod = new Module(buildMod({ songName: 'dune desert' }));
    // The field is a fixed 20 bytes, zero-padded; zeros read back as spaces.
    expect(mod.songName).toBe('dune desert'.padEnd(20, ' '));
  });

  describe('format tags', () => {
    it.each([
      ['M.K.', 4, 8287, 64],
      ['M!K!', 4, 8287, 64],
      ['FLT4', 4, 8287, 64],
    ])('recognises the 4-channel tag %s', (tag, channels, c2Rate, gain) => {
      const mod = new Module(buildMod({ tag }));
      expect(mod.numChannels).toBe(channels);
      expect(mod.c2Rate).toBe(c2Rate);
      expect(mod.gain).toBe(gain);
    });

    it('derives the channel count from an xCHN tag', () => {
      const mod = new Module(buildMod({ tag: '6CHN' }));
      expect(mod.numChannels).toBe(6);
      expect(mod.c2Rate).toBe(8363);
      expect(mod.gain).toBe(32);
    });

    it('derives a two-digit channel count from an xxCH tag', () => {
      const mod = new Module(buildMod({ tag: '16CH' }));
      expect(mod.numChannels).toBe(16);
    });

    it('throws on an unrecognised tag rather than mis-parsing', () => {
      const bad = buildMod();
      bad[1080] = 0x5a; // 'Z' — clobbers 'M.K.' into nonsense
      bad[1081] = 0x5a;
      bad[1082] = 0x5a;
      bad[1083] = 0x5a;
      expect(() => new Module(bad)).toThrow('MOD format not recognised');
    });
  });

  describe('sequence', () => {
    it('masks the high bit off the sequence length and restart position', () => {
      const mod = new Module(buildMod({ sequence: [0, 1], sequenceLength: 0x82, restartPos: 0x81 }));
      expect(mod.sequenceLength).toBe(2); // 0x82 & 0x7F
      expect(mod.restartPos).toBe(1); // 0x81 & 0x7F
    });

    it('resets an out-of-range restart position to zero', () => {
      const mod = new Module(buildMod({ sequence: [0], sequenceLength: 1, restartPos: 5 }));
      expect(mod.restartPos).toBe(0);
    });

    it('derives numPatterns from the highest pattern index referenced anywhere in the 128 slots', () => {
      // Slot 3 is past sequenceLength, but the parser still scans all 128.
      const seq = [0, 1, 0, 7];
      const mod = new Module(buildMod({ sequence: seq, sequenceLength: 2 }));
      expect(mod.numPatterns).toBe(8);
    });
  });

  describe('pattern note decoding', () => {
    it('maps a period to its key index via the period table', () => {
      // 856 is the table entry for key 13; 1712 is key 1 an octave below.
      const mod = new Module(
        buildMod({ notes: [{ index: 0, period: 856 }, { index: 1, period: 1712 }] }),
      );
      expect(mod.patterns[0]).toBe(13);
      expect(mod.patterns[4]).toBe(1);
    });

    it('treats a period below the table floor as "no note"', () => {
      const mod = new Module(buildMod({ notes: [{ index: 0, period: 20 }] }));
      expect(mod.patterns[0]).toBe(0);
    });

    it('reassembles a 5-bit instrument number split across two bytes', () => {
      // Instrument 17 = 0x11: bit 4 lives in byte 0, the low nibble in byte 2.
      const mod = new Module(
        buildMod({ notes: [{ index: 0, period: 856, instrument: 17, effect: 0xc, param: 32 }] }),
      );
      expect(mod.patterns[1]).toBe(17);
      expect(mod.patterns[2]).toBe(0xc);
      expect(mod.patterns[3]).toBe(32);
    });
  });

  describe('instrument headers', () => {
    it('converts the finetune nibble from a signed 4-bit value to the 0..15 internal scale', () => {
      const mod = new Module(
        buildMod({
          instruments: {
            1: { lengthWords: 2, fineTune: 0 },
            2: { lengthWords: 2, fineTune: 7 },
            3: { lengthWords: 2, fineTune: 8 },
            4: { lengthWords: 2, fineTune: 15 },
          },
        }),
      );
      expect(mod.instruments[1]!.fineTune).toBe(8); // 0 -> centre
      expect(mod.instruments[2]!.fineTune).toBe(15); // +7
      expect(mod.instruments[3]!.fineTune).toBe(0); // -8
      expect(mod.instruments[4]!.fineTune).toBe(7); // -1
    });

    it('masks the volume byte and clamps it to 64', () => {
      const mod = new Module(
        buildMod({
          instruments: {
            1: { lengthWords: 2, volume: 0x9e }, // high bit set: 0x9E & 0x7F = 30
            2: { lengthWords: 2, volume: 100 }, // over maximum
          },
        }),
      );
      expect(mod.instruments[1]!.volume).toBe(30);
      expect(mod.instruments[2]!.volume).toBe(64);
    });

    it('converts loop points from words to bytes', () => {
      const mod = new Module(
        buildMod({ instruments: { 1: { lengthWords: 50, loopStartWords: 10, loopLengthWords: 10 } } }),
      );
      expect(mod.instruments[1]!.loopStart).toBe(20);
      expect(mod.instruments[1]!.loopLength).toBe(20);
    });

    it('disables a loop shorter than 4 bytes by parking it at the sample end', () => {
      const mod = new Module(
        buildMod({ instruments: { 1: { lengthWords: 50, loopStartWords: 10, loopLengthWords: 1 } } }),
      );
      const inst = mod.instruments[1]!;
      expect(inst.loopLength).toBe(0);
      expect(inst.loopStart).toBe(100); // the full sample length in bytes
    });

    it('clamps a loop that overruns the sample', () => {
      const mod = new Module(
        buildMod({ instruments: { 1: { lengthWords: 50, loopStartWords: 45, loopLengthWords: 40 } } }),
      );
      const inst = mod.instruments[1]!;
      expect(inst.loopStart + inst.loopLength).toBeLessThanOrEqual(100);
    });

    it('reads sample bytes as signed 8-bit', () => {
      const mod = new Module(
        buildMod({ instruments: { 1: { lengthWords: 2, sample: [0, 127, 128, 255] } } }),
      );
      const data = mod.instruments[1]!.sampleData;
      expect(data[0]).toBe(0);
      expect(data[1]).toBe(127);
      expect(data[2]).toBe(-128); // 0x80 as signed
      expect(data[3]).toBe(-1); // 0xFF as signed
    });

    it('survives a file whose sample data is truncated mid-instrument', () => {
      // A real hazard for a module ripped straight out of a game's data file:
      // the header declares more sample bytes than the file actually carries.
      const spec = { instruments: { 1: { lengthWords: 32, volume: 64, sample: Array(64).fill(50) } } };
      const full = new Module(buildMod(spec));
      const truncated = new Module(buildMod({ ...spec, dropTrailingBytes: 40 }));

      expect(full.instruments[1]!.sampleData.length).toBe(65); // len + 1
      expect(Array.from(full.instruments[1]!.sampleData.slice(0, 64)).every((b) => b === 50)).toBe(true);

      // The buffer is still allocated at the *declared* length, but only the 24
      // bytes the file actually carried were copied — the rest stay zero.
      const data = truncated.instruments[1]!.sampleData;
      expect(data.length).toBe(65);
      expect(data[23]).toBe(50); // last byte that existed
      expect(data[24]).toBe(0); // first byte past the end of the file
      expect(data[63]).toBe(0);
    });

    it('reads consecutive instruments from consecutive sample offsets', () => {
      // The read cursor advances by each instrument's sample length, so an
      // off-by-one here would shift every later instrument's data.
      const mod = new Module(
        buildMod({
          instruments: {
            1: { lengthWords: 2, sample: [1, 2, 3, 4] },
            2: { lengthWords: 2, sample: [5, 6, 7, 8] },
          },
        }),
      );
      expect(Array.from(mod.instruments[1]!.sampleData.slice(0, 4))).toEqual([1, 2, 3, 4]);
      expect(Array.from(mod.instruments[2]!.sampleData.slice(0, 4))).toEqual([5, 6, 7, 8]);
    });

    it('always exposes 32 instrument slots with a blank at index 0', () => {
      const mod = new Module(buildMod());
      expect(mod.numInstruments).toBe(31);
      expect(mod.instruments.length).toBe(32);
      expect(mod.instruments[0]!.sampleData.length).toBe(0);
    });
  });
});
