import { describe, it, expect } from 'vitest';
import {
  parseQsoundNoteTable,
  readQsoundNoteTableBase,
  qsoundNoteByteRange,
  parseQsoundEnvelopeDispatch,
  resolveCps2SeqTableLength,
  parseCps2SeqTable,
  parseCps2SeqHeader,
  decodeCps2TrackV1,
  parseQsoundSampleInfoTable,
  cps2InstrumentAddressV115,
  parseCps2InstrumentV115,
  parseCps2EnvelopeRateTables,
  computeCps2EnvelopeTimes,
  CPS2_DRIVER_RATE_HZ,
  clampCps2PitchIndex,
  parseCps2PitchTables,
  computeCps2PitchDelta,
  cps2TempoToSecondsPerTick,
  CPS2_DEFAULT_SECONDS_PER_TICK,
  CPS2_PPQN,
} from '../capcom/qsound-driver.js';

function writeU16BE(region: Uint8Array, addr: number, v: number): void {
  region[addr] = (v >> 8) & 0xff;
  region[addr + 1] = v & 0xff;
}

function writeU32BE(region: Uint8Array, addr: number, v: number): void {
  region[addr] = (v >>> 24) & 0xff;
  region[addr + 1] = (v >>> 16) & 0xff;
  region[addr + 2] = (v >>> 8) & 0xff;
  region[addr + 3] = v & 0xff;
}

describe('readQsoundNoteTableBase / parseQsoundNoteTable / qsoundNoteByteRange', () => {
  function buildFakeAudiocpu(): Uint8Array {
    const rom = new Uint8Array(0x8000);
    const tableBase = 0x1000;
    // base-literal field at 0x39e3, little-endian
    rom[0x39e3] = tableBase & 0xff;
    rom[0x39e3 + 1] = (tableBase >> 8) & 0xff;
    // two synthetic 8-byte records
    const rec0 = [0x00, 0x00, 0x00, 0xf3, 0x7f, 0xfe, 0x7f, 0x3c]; // bank=0 offset=0 loopSource=0x7ff3 end=0x7ffe flags=0x3c
    const rec1 = [0x01, 0x00, 0x80, 0x10, 0x90, 0x00, 0xa0, 0x2a]; // bank=1 offset=0x8000 loopSource=0x9010 end=0xa000 flags=0x2a
    rom.set(rec0, tableBase);
    rom.set(rec1, tableBase + 8);
    return rom;
  }

  it('reads the little-endian table-base literal', () => {
    const rom = buildFakeAudiocpu();
    expect(readQsoundNoteTableBase(rom, 0x39e3)).toBe(0x1000);
  });

  it('parses fixed-stride 8-byte records starting at the resolved base', () => {
    const rom = buildFakeAudiocpu();
    const base = readQsoundNoteTableBase(rom, 0x39e3);
    const records = parseQsoundNoteTable(rom, base, 2);
    expect(records).toEqual([
      { id: 0, bank: 0x00, offset: 0x0000, loopSource: 0x7ff3, end: 0x7ffe, flags: 0x3c },
      { id: 1, bank: 0x01, offset: 0x8000, loopSource: 0x9010, end: 0xa000, flags: 0x2a },
    ]);
  });

  it('stops early when the ROM buffer is too short for another full record', () => {
    const rom = buildFakeAudiocpu();
    const base = readQsoundNoteTableBase(rom, 0x39e3);
    const records = parseQsoundNoteTable(rom, base, 10000);
    // table base 0x1000, stride 8, rom length 0x8000 -> last full record starts at 0x7ff8
    expect(records.length).toBe((0x8000 - base) / 8);
  });

  it('resolves a record into concrete qsound-ROM byte offsets (bank * 0x10000 + field)', () => {
    const rec = { id: 0, bank: 2, offset: 0x0100, loopSource: 0x7ff0, end: 0x7ffe, flags: 0x3c };
    expect(qsoundNoteByteRange(rec)).toEqual({
      start: 2 * 0x10000 + 0x0100,
      end: 2 * 0x10000 + 0x7ffe,
      loopStart: 2 * 0x10000 + 0x7ff0,
    });
  });

  it("produces a valid subarray range (end >= start) for every record in a real confirmed table shape", () => {
    // Regression guard for the corpus-wide invariant confirmed against
    // real ddsom (D&D: Shadow over Mystara) data (256/256 real records
    // satisfy end >= offset) -- exercised here on synthetic data since the
    // real audiocpu ROM isn't available to unit tests.
    const rom = buildFakeAudiocpu();
    const base = readQsoundNoteTableBase(rom, 0x39e3);
    const records = parseQsoundNoteTable(rom, base, 2);
    for (const rec of records) {
      const range = qsoundNoteByteRange(rec);
      expect(range.end).toBeGreaterThanOrEqual(range.start);
    }
  });
});

describe('parseQsoundEnvelopeDispatch', () => {
  it('parses the 6-entry state table with real ddsom values', () => {
    const rom = new Uint8Array(0x2000);
    const tableAddr = 0x1925;
    // Real little-endian u16 targets read from ddsom's audiocpu ROM at 0x1925:
    // state 0->0x1931, 1->0x1949, 2->0x1fc1, 3->0x1979, 4->0x198e, 5->0x1fc1
    // (states 2 and 5 share a handler -- both skip straight to the shared
    // volume/rate register-write tail with no counter/threshold comparison).
    const targets = [0x1931, 0x1949, 0x1fc1, 0x1979, 0x198e, 0x1fc1];
    targets.forEach((t, i) => {
      rom[tableAddr + i * 2] = t & 0xff;
      rom[tableAddr + i * 2 + 1] = (t >> 8) & 0xff;
    });
    expect(parseQsoundEnvelopeDispatch(rom, tableAddr)).toEqual([
      { state: 0, targetAddress: 0x1931 },
      { state: 1, targetAddress: 0x1949 },
      { state: 2, targetAddress: 0x1fc1 },
      { state: 3, targetAddress: 0x1979 },
      { state: 4, targetAddress: 0x198e },
      { state: 5, targetAddress: 0x1fc1 },
    ]);
  });

  it('defaults to 6 states, and stops early when the ROM buffer is too short', () => {
    const rom = new Uint8Array(4); // room for exactly 2 entries
    rom.set([0x00, 0x10, 0x00, 0x20], 0);
    expect(parseQsoundEnvelopeDispatch(rom, 0)).toEqual([
      { state: 0, targetAddress: 0x1000 },
      { state: 1, targetAddress: 0x2000 },
    ]);
  });
});

describe('resolveCps2SeqTableLength / parseCps2SeqTable (top-level song table)', () => {
  it('finds the table length from the first non-zero (masked) entry, and lists every non-zero slot', () => {
    const region = new Uint8Array(0x200);
    const tableOffset = 0x100;
    // slot 0 (k=0): empty. slot 1 (k=4): points to 0x140 -- this fixes the table length at 0x140-0x100=0x40.
    writeU32BE(region, tableOffset + 4, 0x140);
    // a later slot within that 0x40-byte range, also non-zero.
    writeU32BE(region, tableOffset + 0x24, 0x1a0);

    const length = resolveCps2SeqTableLength(region, tableOffset, tableOffset);
    expect(length).toBe(0x40);

    const songs = parseCps2SeqTable(region, tableOffset, length);
    expect(songs).toEqual([
      { index: 1, address: 0x140 },
      { index: 9, address: 0x1a0 }, // 0x24 / 4 = 9
    ]);
  });
});

describe('parseCps2SeqHeader', () => {
  it('parses the flags byte and 16 relative BE u16 track pointers, treating 0 as "no track"', () => {
    const region = new Uint8Array(0x100);
    const songOffset = 0x10;
    region[songOffset] = 0x00; // flags
    writeU16BE(region, songOffset + 1, 0x21); // track 0
    writeU16BE(region, songOffset + 1 + 2 * 5, 0x9f); // track 5
    // all other 14 slots stay 0 ("no track")

    const header = parseCps2SeqHeader(region, songOffset);
    expect(header).not.toBeNull();
    expect(header!.flags).toBe(0x00);
    expect(header!.trackOffsets[0]).toBe(0x21);
    expect(header!.trackOffsets[5]).toBe(0x9f);
    expect(header!.trackOffsets.filter((t) => t !== null)).toHaveLength(2);
  });

  it('rejects a header whose flags byte has bit 7 set (CPS2Seq::parseTrackPointers()\'s own early-return)', () => {
    const region = new Uint8Array(0x40);
    region[0] = 0x92; // matches CPS2Seq.cpp's own comment: "some tracks have first byte set to 0x92 in D&D SoM"
    expect(parseCps2SeqHeader(region, 0)).toBeNull();
  });
});

describe('decodeCps2TrackV1', () => {
  it('decodes a Set-Octave control event followed by one note, terminating cleanly at EndOfTrack', () => {
    const region = new Uint8Array(0x40);
    const trackOffset = 0x10;
    // 0x09 0x02: "Set Octave" -> noteState = (0 & 0xf8) | 2 = 2 -> octave_table[2] = 0x18.
    // 0x21: note event, status&0x1f=1 (not rest), key = 1 + 0x18 - 1 = 0x18 (24).
    // 0x17: EndOfTrack.
    region.set([0x09, 0x02, 0x21, 0x17], trackOffset);

    const result = decodeCps2TrackV1(region, trackOffset);
    expect(result.ended).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.noteCount).toBe(1);
    expect(result.minKey).toBe(24);
    expect(result.maxKey).toBe(24);
    expect(result.events.map((e) => e.kind)).toEqual(['controlChange', 'note', 'endOfTrack']);
  });

  it('regression: the Set-Octave control event (0x09) must mutate noteState, not just consume its operand byte', () => {
    // Caught during promotion: an earlier draft merged 0x09 into the same
    // "read one operand byte, no-op" switch case as 0x06/0x07/0x0a-0x0d,
    // silently dropping its noteState mutation. That produced a corpus-wide
    // note-key range of 0-48 against real ddsom bytes instead of the correct
    // 10-99 (same total note COUNT either way, since the bug doesn't change
    // control flow -- only the computed key values), catchable only by
    // checking actual decoded values, not just "does it terminate cleanly".
    const withOctave = new Uint8Array(0x10);
    withOctave.set([0x09, 0x04, 0x21, 0x17], 0); // octave_table[4] = 0x30
    const withoutOctaveChange = new Uint8Array(0x10);
    withoutOctaveChange.set([0x21, 0x17], 0); // octave_table[0] = 0x00 (default noteState)

    const a = decodeCps2TrackV1(withOctave, 0);
    const b = decodeCps2TrackV1(withoutOctaveChange, 0);
    expect(a.minKey).toBe(1 + 0x30 - 1); // 48
    expect(b.minKey).toBe(1 + 0x00 - 1); // 0
    expect(a.minKey).not.toBe(b.minKey);
  });

  it('resolves a Program Change event (0x08) into a MIDI-style {bank 0-1, program 0-127} pair', () => {
    const region = new Uint8Array(0x10);
    region.set([0x08, 0x85, 0x17], 0); // prog=0x85 (133) -> bank=1, program=5
    const result = decodeCps2TrackV1(region, 0);
    expect(result.events[0]).toMatchObject({ kind: 'program', bank: 1, program: 5 });
  });

  it("resolves a Bank Change / extended Program Change event (0x1f, the < CPS2_V116 formula) into {bank 2-3, program}", () => {
    const region = new Uint8Array(0x10);
    region.set([0x1f, 0x85, 0x17], 0); // value=0x85 -> bank=2+1=3, program=5
    const result = decodeCps2TrackV1(region, 0);
    expect(result.events[0]).toMatchObject({ kind: 'program', bank: 3, program: 5 });
  });

  it('follows a Loop (0x0e) event back to replay a note exactly `count` extra times, then falls through', () => {
    const region = new Uint8Array(0x20);
    // layout: [0]=0x21 (note), [1]=0x0e (loop#0), [2]=count(2), [3]=backDistance(4, jump = curOffset(4)-4 = back to offset 0, the note), [4]=0x17 (EndOfTrack, reached once the loop count hits 0 and falls through instead of jumping back).
    region.set([0x21, 0x0e, 0x02, 0x04, 0x17], 0);
    const result = decodeCps2TrackV1(region, 0);
    expect(result.ended).toBe(true);
    // 1 initial note + 2 loop-triggered repeats (each replays the note at offset 0) = 3 notes total.
    expect(result.noteCount).toBe(3);
    // The loop opcode is visited 3 times structurally: once to set up the
    // loop (count=2 -> 2 more passes), then once per decrement (2, then 1,
    // the second of which resets the loop and falls through instead of
    // jumping) -- a 'loop' event is pushed unconditionally on every visit.
    expect(result.events.filter((e) => e.kind === 'loop')).toHaveLength(3);
  });

  it('reports out-of-bounds rather than reading past the buffer', () => {
    const region = new Uint8Array(4);
    // Start decoding right at the buffer's end -- the very first status-byte fetch is out of bounds.
    const result = decodeCps2TrackV1(region, region.length);
    expect(result.ended).toBe(false);
    expect(result.error).toBe('out-of-bounds');
  });
});

describe('parseQsoundSampleInfoTable (dynamic terminator scan)', () => {
  it('stops one record short of the first all-zero "next neighbor", matching CPS2SampleInfoTable::loadMain()\'s exact off-by-one C++ loop shape', () => {
    const region = new Uint8Array(0x300);
    const tableBase = 0x200;
    // record 0 (valid) @0x200, record 1 (valid) @0x208, record 2 (valid,
    // but excluded -- see the off-by-one note below) @0x210, record 3
    // (all-zero terminator) @0x218.
    region.set([1, 0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x3c], tableBase);
    region.set([2, 0x50, 0x00, 0x60, 0x00, 0x70, 0x00, 0x40], tableBase + 8);
    region.set([3, 0x90, 0x00, 0xa0, 0x00, 0xb0, 0x00, 0x41], tableBase + 16);
    // tableBase+24 stays all-zero (the terminator record).

    const records = parseQsoundSampleInfoTable(region, tableBase);
    // Per the original C++ for-loop's own semantics (condition checked
    // BEFORE the body that reads the NEXT record), the terminator check
    // needs one more "real-looking" record past the last one actually
    // returned -- record 2 above has plausible non-zero content but is
    // still excluded, exactly matching vgmtrans's own off-by-one shape.
    expect(records).toEqual([
      { id: 0, bank: 1, offset: 0x10, loopSource: 0x20, end: 0x30, unityKey: 0x3c },
      { id: 1, bank: 2, offset: 0x50, loopSource: 0x60, end: 0x70, unityKey: 0x40 },
    ]);
  });

  it('returns an empty array when the very first neighbor is already a terminator', () => {
    const region = new Uint8Array(0x20); // all zero
    expect(parseQsoundSampleInfoTable(region, 0)).toEqual([]);
  });
});

describe('cps2InstrumentAddressV115', () => {
  const table0 = 0x300;
  const table1 = 0x500;

  it('resolves bank 0-1 into the first physical 256-entry table (128 entries per bank half)', () => {
    expect(cps2InstrumentAddressV115(table0, table1, 0, 5)).toBe(table0 + 5 * 8);
    expect(cps2InstrumentAddressV115(table0, table1, 1, 5)).toBe(table0 + (128 + 5) * 8);
  });

  it('resolves bank 2-3 into the second physical 256-entry table', () => {
    expect(cps2InstrumentAddressV115(table0, table1, 2, 3)).toBe(table1 + 3 * 8);
    expect(cps2InstrumentAddressV115(table0, table1, 3, 3)).toBe(table1 + (128 + 3) * 8);
  });
});

describe('parseCps2InstrumentV115', () => {
  it('parses the 8-byte qs_prog_info_ver_101 record shape', () => {
    const region = new Uint8Array(0x10);
    region.set([7, 0xff, 1, 2, 3, 4, 5, 0xaa], 0);
    expect(parseCps2InstrumentV115(region, 0)).toEqual({
      sampleIndex: 7,
      attackRate: 1,
      decayRate: 2,
      sustainLevel: 3,
      sustainRate: 4,
      releaseRate: 5,
    });
  });
});

describe('parseCps2EnvelopeRateTables / computeCps2EnvelopeTimes', () => {
  // Synthetic tables (not real ROM data, per this project's convention of
  // not vendoring copyrighted ROM bytes into committed tests) -- shaped
  // like real 16-bit rate values, at arbitrary base addresses.
  const region = new Uint8Array(0x400);
  const attackBase = 0x00;
  const decayBase = 0x100;
  const sustainBase = 0x200;
  const setWord = (base: number, index: number, value: number): void => {
    region[base + index * 2] = value & 0xff;
    region[base + index * 2 + 1] = (value >> 8) & 0xff;
  };
  setWord(attackBase, 0, 0); // rate=0 -> attackSeconds=0 (vgmtrans's own edge case)
  setWord(attackBase, 5, 0x1000);
  setWord(decayBase, 3, 0x0080);
  setWord(decayBase, 4, 0xffff); // rate=0xffff -> seconds=0 (vgmtrans's own edge case)
  setWord(decayBase, 6, 0x0040);
  setWord(sustainBase, 2, 0x5fe);

  it('reads all 3 tables at their given base addresses', () => {
    const tables = parseCps2EnvelopeRateTables(region, attackBase, decayBase, sustainBase);
    expect(tables.attack).toHaveLength(64);
    expect(tables.decay).toHaveLength(64);
    expect(tables.sustainLevel).toHaveLength(128);
    expect(tables.attack[5]).toBe(0x1000);
    expect(tables.decay[3]).toBe(0x0080);
    expect(tables.sustainLevel[2]).toBe(0x5fe);
  });

  it("converts raw ADSR bytes to real seconds via vgmtrans's own ticks=0xFFFF/rate formula", () => {
    const tables = parseCps2EnvelopeRateTables(region, attackBase, decayBase, sustainBase);
    const times = computeCps2EnvelopeTimes(
      { sampleIndex: 0, attackRate: 5, decayRate: 3, sustainLevel: 2, sustainRate: 6, releaseRate: 4 },
      tables
    );
    expect(times.attackSeconds).toBeCloseTo((0xffff / 0x1000) / CPS2_DRIVER_RATE_HZ, 6);
    expect(times.decaySeconds).toBeCloseTo((0xffff / 0x0080) / CPS2_DRIVER_RATE_HZ, 6);
    expect(times.sustainSeconds).toBeCloseTo((0xffff / 0x0040) / CPS2_DRIVER_RATE_HZ, 6);
    expect(times.releaseSeconds).toBe(0); // rate 0xffff -> 0 seconds (instant), not Infinity
    expect(times.sustainLevel).toBeCloseTo(0x5fe / 0xffff, 6);
  });

  it('treats a rate=0 attack byte as 0 seconds (matches vgmtrans exactly, not Infinity)', () => {
    const tables = parseCps2EnvelopeRateTables(region, attackBase, decayBase, sustainBase);
    const times = computeCps2EnvelopeTimes(
      { sampleIndex: 0, attackRate: 0, decayRate: 3, sustainLevel: 2, sustainRate: 6, releaseRate: 4 },
      tables
    );
    expect(times.attackSeconds).toBe(0);
  });
});

describe('clampCps2PitchIndex', () => {
  it('leaves already-in-range values [0x00, 0x6b] unchanged', () => {
    expect(clampCps2PitchIndex(0x00)).toBe(0x00);
    expect(clampCps2PitchIndex(0x05)).toBe(0x05);
    expect(clampCps2PitchIndex(0x6b)).toBe(0x6b);
  });

  it('clamps [0x6c, 0xeb] to 0 -- the real cp/jp m asymmetry, not a naive high clamp', () => {
    expect(clampCps2PitchIndex(0x6c)).toBe(0);
    expect(clampCps2PitchIndex(0x80)).toBe(0);
    expect(clampCps2PitchIndex(0xeb)).toBe(0);
  });

  it('clamps [0xec, 0xff] to 0x6b', () => {
    expect(clampCps2PitchIndex(0xec)).toBe(0x6b);
    expect(clampCps2PitchIndex(0xff)).toBe(0x6b);
  });
});

describe('parseCps2PitchTables / computeCps2PitchDelta', () => {
  const region = new Uint8Array(0x1000);
  const shiftBase = 0x000;
  const octaveBase = 0x100;
  const semitoneBase = 0x200;
  const mantissaBase = 0x400; // 12*256 = 0xc00 bytes, fits before region end (0x1000)

  // idx=13 -> octave 1, semitone 1 (13 - 12).
  region[shiftBase + 13] = 1;
  region[octaveBase + 1] = 12;
  region[semitoneBase + 13 * 2] = 0x70; // semitoneBase[13] = 0x0270 (LE)
  region[semitoneBase + 13 * 2 + 1] = 0x02;
  region[mantissaBase + 1 * 256 + 200] = 5; // mantissa[semitone=1][fracLow=200] = 5
  // idx=0x6b (the clamp target for out-of-range inputs) -> octave 8, semitone 11 (0x6b=107, 107-96=11).
  region[shiftBase + 0x6b] = 8;
  region[octaveBase + 8] = 96;

  it('reads the 4 tables at their given base addresses', () => {
    const tables = parseCps2PitchTables(region, shiftBase, octaveBase, semitoneBase, mantissaBase);
    expect(tables.shiftCount).toHaveLength(108);
    expect(tables.octaveBase).toHaveLength(9);
    expect(tables.semitoneBase).toHaveLength(108);
    expect(tables.mantissa).toHaveLength(12);
    expect(tables.mantissa[0]).toHaveLength(256);
    expect(tables.shiftCount[13]).toBe(1);
    expect(tables.semitoneBase[13]).toBe(0x0270);
    expect(tables.mantissa[1][200]).toBe(5);
  });

  it('computes semitoneBase[idx] + (mantissa[semitone][fracLow] << octave) for an in-range input', () => {
    const tables = parseCps2PitchTables(region, shiftBase, octaveBase, semitoneBase, mantissaBase);
    // rawIndexInput=13 (already in [0,0x6b], clampCps2PitchIndex is a no-op) -> idx=13, octave=1, semitone=1.
    expect(computeCps2PitchDelta(13, 200, tables)).toBe(0x0270 + (5 << 1));
  });

  it('applies the clamp before the table lookups (an out-of-range input still resolves to a valid table entry)', () => {
    const tables = parseCps2PitchTables(region, shiftBase, octaveBase, semitoneBase, mantissaBase);
    // rawIndexInput=0xec clamps to 0x6b (107), not 13 -- must not throw / index out of bounds.
    expect(() => computeCps2PitchDelta(0xec, 0, tables)).not.toThrow();
  });
});

describe('cps2TempoToSecondsPerTick / tempo event capture', () => {
  it('captures the raw 16-bit tempoTicksPerIteration payload on a tempo (0x05) event', () => {
    const region = new Uint8Array(0x10);
    region.set([0x05, 0x01, 0x00, 0x17], 0); // tempo=0x0100, then EndOfTrack
    const result = decodeCps2TrackV1(region, 0);
    expect(result.events[0]).toMatchObject({ kind: 'tempo', tempoTicksPerIteration: 0x0100 });
  });

  it("matches vgmtrans's own CPS2TrackV1.cpp micros-per-beat formula (divided by ppqn again for per-tick seconds)", () => {
    const ticksPerIteration = 0x0100;
    const internalPpqn = CPS2_PPQN << 8;
    const iterationsPerBeat = internalPpqn / ticksPerIteration;
    const expectedSecondsPerBeat = iterationsPerBeat / (250 / 4.0);
    const expectedSecondsPerTick = expectedSecondsPerBeat / CPS2_PPQN;
    expect(cps2TempoToSecondsPerTick(ticksPerIteration)).toBeCloseTo(expectedSecondsPerTick, 9);
  });

  it('defaults to 120 BPM (500000 microseconds/quarter) before any tempo event, matching CPS2Seq.cpp', () => {
    expect(CPS2_DEFAULT_SECONDS_PER_TICK).toBeCloseTo(500000 / CPS2_PPQN / 1e6, 9);
  });
});
