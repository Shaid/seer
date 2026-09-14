import { describe, it, expect } from 'vitest';
import { RAW_SECTOR_SIZE, SYNC_PATTERN, FORM1_USER_SIZE, lbaToAbsolute, hasSyncPattern } from '../sector.js';
import {
  parseCue,
  findTrack,
  sectorSizeForMode,
  cookDataTrack,
  sliceTrackSectors,
  decodeAudioSectors,
  deinterleaveStereo16,
  encodeAudioSectorsAsWav,
} from '../cue-sheet.js';

const DATA_SECTORS = 3;
const AUDIO_SECTORS = 2;

function buildBin(): Uint8Array {
  const bin = new Uint8Array((DATA_SECTORS + AUDIO_SECTORS) * RAW_SECTOR_SIZE);
  for (let s = 0; s < DATA_SECTORS; s++) {
    const base = s * RAW_SECTOR_SIZE;
    bin.set(SYNC_PATTERN, base);
    bin[base + 12] = 0x00;
    bin[base + 13] = 0x02;
    bin[base + 14] = s;
    bin[base + 15] = 0x01;
    for (let i = 0; i < FORM1_USER_SIZE; i++) {
      bin[base + 16 + i] = (s * 7 + i) & 0xff;
    }
    for (let i = 0; i < 288; i++) {
      bin[base + 16 + FORM1_USER_SIZE + i] = 0xee;
    }
  }
  const audioBase = DATA_SECTORS * RAW_SECTOR_SIZE;
  const view = new DataView(bin.buffer);
  const frames = (AUDIO_SECTORS * RAW_SECTOR_SIZE) / 4;
  for (let f = 0; f < frames; f++) {
    view.setInt16(audioBase + f * 4, f & 0x7fff, true);
    view.setInt16(audioBase + f * 4 + 2, -(f & 0x7fff), true);
  }
  return bin;
}

const CUE_TEXT = `FILE "mini.bin" BINARY
  TRACK 01 MODE1/2352
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    INDEX 01 00:00:03
`;

describe('sectorSizeForMode', () => {
  it('stores audio and MODE1/2352 alike at 2352 bytes', () => {
    expect(sectorSizeForMode('AUDIO')).toBe(RAW_SECTOR_SIZE);
    expect(sectorSizeForMode('MODE1/2352')).toBe(RAW_SECTOR_SIZE);
    expect(sectorSizeForMode('MODE2/2352')).toBe(RAW_SECTOR_SIZE);
  });

  it('recognises a cooked MODE1/2048 track', () => {
    expect(sectorSizeForMode('MODE1/2048')).toBe(FORM1_USER_SIZE);
  });
});

describe('parseCue', () => {
  const bin = buildBin();

  it('derives track offsets and lengths from INDEX 01 positions', () => {
    const cue = parseCue(CUE_TEXT, '/mini.bin', bin.length);
    expect(cue.tracks).toHaveLength(2);
    const [data, audio] = cue.tracks;
    expect(data!.number).toBe(1);
    expect(data!.isData).toBe(true);
    expect(data!.sectorSize).toBe(RAW_SECTOR_SIZE);
    expect(data!.lengthSectors).toBe(DATA_SECTORS);
    expect(audio!.isData).toBe(false);
    expect(audio!.startLba).toBe(DATA_SECTORS);
    expect(audio!.lengthSectors).toBe(AUDIO_SECTORS);
  });

  it('ignores REM, TITLE and PERFORMER lines', () => {
    const cue = parseCue(
      `REM GENRE Game\nTITLE "X"\nFILE "mini.bin" BINARY\n  TRACK 01 AUDIO\n    PERFORMER "Y"\n    INDEX 01 00:00:00\n`,
      'x.bin',
      RAW_SECTOR_SIZE * 4,
    );
    expect(cue.tracks).toHaveLength(1);
    expect(cue.tracks[0]!.lengthSectors).toBe(4);
  });

  it('records an INDEX 00 pregap separately from INDEX 01', () => {
    const cue = parseCue(
      `FILE "x.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:00:02\n    INDEX 01 00:00:04\n`,
      'x.bin',
      RAW_SECTOR_SIZE * 6,
    );
    expect(cue.tracks[1]!.pregapLba).toBe(2);
    expect(cue.tracks[1]!.startLba).toBe(4);
    expect(cue.tracks[0]!.lengthSectors).toBe(4);
  });

  it('rejects a cue with no tracks, a missing INDEX 01, or multiple FILEs', () => {
    expect(() => parseCue('FILE "x.bin" BINARY\n', 'x.bin', 0)).toThrow(/no tracks/);
    expect(() => parseCue('FILE "x.bin" BINARY\n  TRACK 01 AUDIO\n', 'x.bin', RAW_SECTOR_SIZE)).toThrow(
      /no INDEX 01/,
    );
    expect(() =>
      parseCue(
        'FILE "a.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n' +
          'FILE "b.bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n',
        'a.bin',
        RAW_SECTOR_SIZE,
      ),
    ).toThrow(/Multi-FILE/);
  });
});

describe('raw sector handling', () => {
  const bin = buildBin();
  const cue = parseCue(CUE_TEXT, '/mini.bin', bin.length);

  it('detects the sync pattern on data sectors and its absence on audio', () => {
    expect(hasSyncPattern(bin, 0)).toBe(true);
    expect(hasSyncPattern(bin, RAW_SECTOR_SIZE)).toBe(true);
    expect(hasSyncPattern(bin, DATA_SECTORS * RAW_SECTOR_SIZE)).toBe(false);
  });

  it('cooks a MODE1/2352 track down to 2048-byte user data', () => {
    const track = findTrack(cue, 1);
    const cooked = cookDataTrack(sliceTrackSectors(bin, track), track.sectorSize);
    expect(cooked.length).toBe(DATA_SECTORS * FORM1_USER_SIZE);
    for (let s = 0; s < DATA_SECTORS; s++) {
      for (const i of [0, 1, 1023, FORM1_USER_SIZE - 1]) {
        expect(cooked[s * FORM1_USER_SIZE + i]).toBe((s * 7 + i) & 0xff);
      }
    }
    expect(hasSyncPattern(cooked, 0)).toBe(false);
  });

  it('leaves an already-cooked MODE1/2048 track untouched', () => {
    const already = new Uint8Array(FORM1_USER_SIZE * 2).fill(0x5a);
    expect(cookDataTrack(already, FORM1_USER_SIZE)).toBe(already);
  });

  it('refuses to cook a sector size it cannot interpret', () => {
    expect(() => cookDataTrack(new Uint8Array(2336), 2336)).toThrow(/Cannot cook/);
  });
});

describe('sliceTrackSectors', () => {
  const bin = buildBin();
  const cue = parseCue(CUE_TEXT, '/mini.bin', bin.length);

  it('returns the requested slice of a track, indexed from its own start', () => {
    const audio = findTrack(cue, 2);
    const whole = sliceTrackSectors(bin, audio);
    expect(whole.length).toBe(AUDIO_SECTORS * RAW_SECTOR_SIZE);
    const second = sliceTrackSectors(bin, audio, 1, 1);
    expect(second.length).toBe(RAW_SECTOR_SIZE);
    expect(Array.from(second.subarray(0, 4))).toEqual(Array.from(whole.subarray(RAW_SECTOR_SIZE, RAW_SECTOR_SIZE + 4)));
  });

  it('rejects a range that runs past the end of the track', () => {
    const audio = findTrack(cue, 2);
    expect(() => sliceTrackSectors(bin, audio, 0, AUDIO_SECTORS + 1)).toThrow(/exceed/);
    expect(() => sliceTrackSectors(bin, audio, -1, 1)).toThrow(/non-negative/);
  });
});

describe('audio decoding', () => {
  it('reads samples little-endian, as Red Book requires', () => {
    const raw = new Uint8Array([0x00, 0x01, 0x00, 0xff]);
    const samples = decodeAudioSectors(raw);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBe(256);
    expect(samples[1]).toBe(-256);
  });

  it('decodes a whole audio track into interleaved stereo frames', () => {
    const bin = buildBin();
    const cue = parseCue(CUE_TEXT, '/mini.bin', bin.length);
    const raw = sliceTrackSectors(bin, findTrack(cue, 2));
    const samples = decodeAudioSectors(raw);
    expect(samples.length).toBe((AUDIO_SECTORS * RAW_SECTOR_SIZE) / 2);
    for (const f of [0, 1, 100, 587]) {
      expect(samples[f * 2]).toBe(f & 0x7fff);
      expect(samples[f * 2 + 1]).toBe(-(f & 0x7fff) | 0);
    }
  });

  it('deinterleaves stereo samples', () => {
    const [l, r] = deinterleaveStereo16(new Int16Array([1, -1, 2, -2, 3, -3]));
    expect(Array.from(l)).toEqual([1, 2, 3]);
    expect(Array.from(r)).toEqual([-1, -2, -3]);
  });

  it('encodes interleaved samples as a WAV file via @seer-project/core', () => {
    const wav = encodeAudioSectorsAsWav(new Int16Array([1, -1, 2, -2]));
    const text = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getInt16(44, true)).toBe(1);
    expect(view.getInt16(46, true)).toBe(-1);
  });
});

describe('lead-in helper re-export', () => {
  it('matches the real Spirit-of-Excalibur-style track origin math', () => {
    expect(lbaToAbsolute(8825)).toBe(8975);
  });
});
