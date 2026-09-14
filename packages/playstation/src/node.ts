/**
 * File-backed disc I/O for `@seer-project/playstation` -- opening a real
 * `.bin`/`.iso`/`.cue` off disk. Kept out of the main browser-safe barrel
 * (`./index.js`) since it imports `node:fs`.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FORM1_USER_SIZE, PlainSectorReader, RawCdReader, RAW_SECTOR_SIZE } from './cd/sector.js';
import { cookDataTrack, findTrack, parseCue, type CueSheet, type CueTrack } from './cd/cue-sheet.js';

function openFileReader(path: string): { size: number; read(offset: number, length: number): Uint8Array; close(): void } {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  return {
    size,
    read(offset: number, length: number): Uint8Array {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    close(): void {
      closeSync(fd);
    },
  };
}

export interface OpenDiscImage<Reader> {
  reader: Reader;
  size: number;
  close(): void;
}

/** Open a raw MODE2/2352 `.bin` disc image (PSX-style) for sector-level and ISO9660 access. Call `.close()` when done. */
export function openRawCdImage(path: string): OpenDiscImage<RawCdReader> & { numSectors: number } {
  const f = openFileReader(path);
  const reader = new RawCdReader((offset, length) => f.read(offset, length));
  return { reader, size: f.size, numSectors: Math.floor(f.size / RAW_SECTOR_SIZE), close: () => f.close() };
}

/** Open a plain fixed-stride logical-sector image (e.g. a PSP UMD ISO, 2048-byte stride) for ISO9660 access. Call `.close()` when done. */
export function openPlainSectorImage(path: string, sectorSize = FORM1_USER_SIZE): OpenDiscImage<PlainSectorReader> {
  const f = openFileReader(path);
  const reader = new PlainSectorReader((offset, length) => f.read(offset, length), sectorSize);
  return { reader, size: f.size, close: () => f.close() };
}

/** Read a `.cue` from disk and resolve its `FILE` reference. */
export function loadCue(cuePath: string): CueSheet {
  const text = readFileSync(cuePath, 'utf8');
  const fileMatch = /^\s*FILE\s+(?:"([^"]*)"|(\S+))/im.exec(text);
  if (!fileMatch) throw new Error(`Cue sheet has no FILE line: ${cuePath}`);
  const binPath = resolve(dirname(cuePath), (fileMatch[1] ?? fileMatch[2])!);
  const binSize = statSync(binPath).size;
  return parseCue(text, binPath, binSize);
}

/**
 * Read a byte range of a track directly off disk, in stored (raw) form.
 * `startSector`/`sectorCount` are relative to the track's own `INDEX 01`.
 */
export function readTrackSectors(
  cue: CueSheet,
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
  const length = sectorCount * track.sectorSize;
  const f = openFileReader(cue.binPath);
  try {
    return f.read(from, length);
  } finally {
    f.close();
  }
}

/** Read a whole data track off disk and cook it to 2048-byte sectors. */
export function readCookedDataTrack(cue: CueSheet, trackNumber: number): Uint8Array {
  const track = findTrack(cue, trackNumber);
  if (!track.isData) throw new Error(`Track ${trackNumber} is audio, not data`);
  return cookDataTrack(readTrackSectors(cue, track), track.sectorSize);
}
