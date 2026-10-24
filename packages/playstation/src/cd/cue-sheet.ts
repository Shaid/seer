/**
 * Parse a `.cue` sheet and index into the `.bin` image it describes.
 *
 * A CD rip normally arrives as a single `.bin` holding every track back to
 * back, plus a `.cue` sheet giving each track's mode and start position. This
 * module turns that pair into per-track byte ranges, and extracts either the
 * raw sectors or the cooked user data.
 *
 * Two facts drive the whole design:
 *
 *  1. **In a `.bin`, every track is stored at 2352 bytes per sector** -- audio
 *     and data alike. A `MODE1/2352` data track therefore carries the full raw
 *     sector: 12-byte sync + 4-byte header + 2048 bytes of user data + 288
 *     bytes of EDC/ECC. To get a mountable ISO image out of it you must drop
 *     the leading 16 bytes and the trailing 288 of every sector. A separately
 *     supplied `.iso` file is usually already cooked at 2048 and needs none of
 *     that -- so the sector layout must be read from the cue's `TRACK` line and
 *     never assumed.
 *
 *  2. **MSF timecodes in a cue sheet are relative to LBA 0**, i.e. `00:00:00`
 *     is the first sector of the disc. Absolute Red Book MSF as used by the
 *     drive adds the 150-sector, 2-second lead-in, so `absoluteSector = lba +
 *     150`. Mixing the two up shifts everything by two seconds. Use
 *     `lbaToAbsolute`/`absoluteToLba` (`./sector.js`) rather than open-coding
 *     the offset.
 *
 * Audio sectors are 16-bit signed **little-endian** stereo at 44,100 Hz (Red
 * Book), which is what `RAW_SECTOR_SIZE` bytes of audio decode as.
 *
 * This module is pure/browser-safe -- it never touches the filesystem. See
 * `../node.js` for `loadCue`/`readTrackSectors`, which resolve a `.cue`'s
 * `FILE` line and read the `.bin` off disk.
 */
import { dataViewOf, encodeWav } from '@seer-project/core';
import { FORM1_USER_SIZE, HEADER_SIZE, RAW_SECTOR_SIZE, msfStringToSectors } from './sector.js';

export const SAMPLE_RATE = 44100;

/** Track modes we understand. Anything else is reported but not decoded. */
export type TrackMode = 'AUDIO' | 'MODE1/2352' | 'MODE1/2048' | 'MODE2/2352' | 'MODE2/2336';

export interface CueTrack {
  /** 1-based track number as written in the cue sheet. */
  number: number;
  mode: TrackMode | string;
  /** Bytes stored per sector of this track inside the `.bin`. */
  sectorSize: number;
  /** True when the track carries filesystem data rather than audio. */
  isData: boolean;
  /** `INDEX 00` position in LBA sectors, when the cue supplies one. */
  pregapLba?: number;
  /** `INDEX 01` position in LBA sectors -- where the track's content starts. */
  startLba: number;
  /** Length in sectors, derived from the next track's start (or the file end). */
  lengthSectors: number;
  /** Byte offset of `INDEX 01` within the `.bin`. */
  byteOffset: number;
  /** Byte length of the track within the `.bin`. */
  byteLength: number;
}

export interface CueSheet {
  /** Absolute path to the `.bin` named by the cue's `FILE` line. */
  binPath: string;
  binSize: number;
  tracks: CueTrack[];
}

/** Bytes per stored sector for a given cue `TRACK` mode. */
export function sectorSizeForMode(mode: string): number {
  switch (mode.toUpperCase()) {
    case 'AUDIO':
    case 'MODE1/2352':
    case 'MODE2/2352':
      return RAW_SECTOR_SIZE;
    case 'MODE1/2048':
      return FORM1_USER_SIZE;
    case 'MODE2/2336':
      return 2336;
    default:
      return RAW_SECTOR_SIZE;
  }
}

/**
 * Parse cue-sheet text. `binSize` and `binPath` come from the caller so this
 * stays pure and testable; `../node.js`'s `loadCue` wires it to the filesystem.
 */
export function parseCue(text: string, binPath: string, binSize: number): CueSheet {
  interface Partial {
    number: number;
    mode: string;
    pregapLba?: number;
    startLba?: number;
  }
  const partials: Partial[] = [];
  let fileSeen = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fileMatch = /^FILE\s+(?:"([^"]*)"|(\S+))\s+(\S+)/i.exec(line);
    if (fileMatch) {
      if (fileSeen) {
        throw new Error('Multi-FILE cue sheets are not supported (expected a single .bin)');
      }
      fileSeen = true;
      continue;
    }
    const trackMatch = /^TRACK\s+(\d+)\s+(\S+)/i.exec(line);
    if (trackMatch) {
      partials.push({ number: Number(trackMatch[1]), mode: trackMatch[2]!.toUpperCase() });
      continue;
    }
    const indexMatch = /^INDEX\s+(\d+)\s+(\d+:\d+:\d+)/i.exec(line);
    if (indexMatch) {
      const current = partials[partials.length - 1];
      if (!current) throw new Error('INDEX line appeared before any TRACK line');
      const sectors = msfStringToSectors(indexMatch[2]!);
      if (Number(indexMatch[1]) === 0) current.pregapLba = sectors;
      else if (Number(indexMatch[1]) === 1) current.startLba = sectors;
      continue;
    }
    // REM, TITLE, PERFORMER, FLAGS, CATALOG, POSTGAP … all ignored.
  }

  if (partials.length === 0) throw new Error('Cue sheet declares no tracks');

  const tracks: CueTrack[] = [];
  for (let i = 0; i < partials.length; i++) {
    const p = partials[i]!;
    if (p.startLba === undefined) {
      throw new Error(`Track ${p.number} has no INDEX 01`);
    }
    const sectorSize = sectorSizeForMode(p.mode);
    const byteOffset = p.startLba * sectorSize;
    const next = partials[i + 1];
    const endLba = next?.startLba ?? Math.floor(binSize / sectorSize);
    const lengthSectors = endLba - p.startLba;
    if (lengthSectors < 0) {
      throw new Error(`Track ${p.number} starts after track ${next?.number} — cue out of order`);
    }
    tracks.push({
      number: p.number,
      mode: p.mode,
      sectorSize,
      isData: p.mode.toUpperCase() !== 'AUDIO',
      pregapLba: p.pregapLba,
      startLba: p.startLba,
      lengthSectors,
      byteOffset,
      byteLength: lengthSectors * sectorSize,
    });
  }
  return { binPath, binSize, tracks };
}

/** Look a track up by its cue-sheet number. */
export function findTrack(cue: CueSheet, trackNumber: number): CueTrack {
  const track = cue.tracks.find((t) => t.number === trackNumber);
  if (!track) throw new Error(`Track ${trackNumber} not present in cue sheet`);
  return track;
}

/**
 * Slice a byte range of a track directly out of an in-memory `.bin` buffer,
 * in stored (raw) form. `startSector`/`sectorCount` are relative to the
 * track's own `INDEX 01`.
 */
export function sliceTrackSectors(
  bin: Uint8Array,
  track: CueTrack,
  startSector = 0,
  sectorCount = track.lengthSectors - startSector,
): Uint8Array {
  if (startSector < 0 || sectorCount < 0) {
    throw new Error('startSector and sectorCount must be non-negative');
  }
  if (startSector + sectorCount > track.lengthSectors) {
    throw new Error(
      `Requested sectors ${startSector}..${startSector + sectorCount} exceed ` +
        `track ${track.number} length ${track.lengthSectors}`,
    );
  }
  const from = track.byteOffset + startSector * track.sectorSize;
  const to = from + sectorCount * track.sectorSize;
  return bin.subarray(from, to);
}

/**
 * Strip sync + header + ECC from a raw MODE1/2352 track, yielding the
 * 2048-byte user data of every sector -- i.e. a cooked image equivalent to a
 * `.iso`.
 *
 * A track already stored at 2048 (`MODE1/2048`) is returned unchanged, since
 * there is nothing to strip. This is the distinction that makes assuming a
 * layout dangerous: both produce a filesystem that half-parses if confused.
 */
export function cookDataTrack(raw: Uint8Array, sectorSize: number): Uint8Array {
  if (sectorSize === FORM1_USER_SIZE) return raw;
  if (sectorSize !== RAW_SECTOR_SIZE) {
    throw new Error(`Cannot cook a data track stored at ${sectorSize} bytes per sector`);
  }
  const sectors = Math.floor(raw.length / RAW_SECTOR_SIZE);
  const out = new Uint8Array(sectors * FORM1_USER_SIZE);
  for (let s = 0; s < sectors; s++) {
    out.set(
      raw.subarray(s * RAW_SECTOR_SIZE + HEADER_SIZE, s * RAW_SECTOR_SIZE + HEADER_SIZE + FORM1_USER_SIZE),
      s * FORM1_USER_SIZE,
    );
  }
  return out;
}

/**
 * Decode raw audio sectors into interleaved signed 16-bit stereo samples.
 * Red Book audio is little-endian; a big-endian read produces full-scale hash
 * rather than an obvious failure, so this deliberately offers no byte-order
 * option.
 */
export function decodeAudioSectors(raw: Uint8Array): Int16Array {
  const frames = Math.floor(raw.length / 4);
  const out = new Int16Array(frames * 2);
  const view = dataViewOf(raw);
  for (let i = 0; i < frames * 2; i++) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

/** Split interleaved stereo samples (as `decodeAudioSectors` returns) into independent left/right channels. */
export function deinterleaveStereo16(samples: Int16Array): [Int16Array, Int16Array] {
  const n = samples.length >> 1;
  const l = new Int16Array(n);
  const r = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = samples[i * 2]!;
    r[i] = samples[i * 2 + 1]!;
  }
  return [l, r];
}

/** Encode interleaved 16-bit stereo PCM (e.g. from `decodeAudioSectors`) as a WAV file, via `@seer-project/core`'s `encodeWav`. */
export function encodeAudioSectorsAsWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const [l, r] = deinterleaveStereo16(samples);
  return encodeWav([l, r], { sampleRate, bits: 16 });
}
