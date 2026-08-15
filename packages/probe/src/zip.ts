/**
 * Minimal read-only ZIP support for corpus triage.
 *
 * TOSEC-style corpora ship disks as ADFs inside ZIPs, with many
 * duplicate dumps of each disk. The central directory carries every
 * member's CRC-32 and sizes, and it lives at the END of the file — so
 * `listZipFromSource` reads only the tail, and duplicate members are
 * recognised having transferred a few KB rather than the whole archive.
 * That is the difference between minutes and hours over SMB.
 *
 * Members decompress on demand (stored and deflate only; anything else
 * is reported and skipped). No zip64, no encryption — beyond what a
 * disk-image corpus needs.
 */

import { inflateRawSync } from 'node:zlib';
import { r16 as rd16, r32 as rd32 } from '@seer-project/core';
import { bufferSource, type ByteSource } from './source.js';

export interface ZipEntry {
  name: string;
  /** Uncompressed size. */
  size: number;
  /** Stored (compressed) size, from the central directory. */
  compressedSize: number;
  /** CRC-32 from the central directory — a free dedupe key. */
  crc32: number;
  compressionMethod: number;
  /** Offset of the member's local header. */
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** EOCD is 22 bytes plus a comment of at most 64 KB. */
const MAX_EOCD_SEARCH = 22 + 0xffff;

export function isZipFile(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 3 || data[2] === 5) &&
    (data[3] === 4 || data[3] === 6)
  );
}

/** Parse central-directory bytes that start at absolute offset `cdOffset`. */
function parseCentralDirectory(cd: Uint8Array, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let off = 0;
  for (let i = 0; i < count; i++) {
    if (off + 46 > cd.length || rd32(cd, off, 'le') !== CENTRAL_SIG) break;
    const method = rd16(cd, off + 10, 'le');
    const crc32Value = rd32(cd, off + 16, 'le');
    const compressedSize = rd32(cd, off + 20, 'le');
    const size = rd32(cd, off + 24, 'le');
    const nameLen = rd16(cd, off + 28, 'le');
    const extraLen = rd16(cd, off + 30, 'le');
    const commentLen = rd16(cd, off + 32, 'le');
    const localHeaderOffset = rd32(cd, off + 42, 'le');
    let name = '';
    for (let c = 0; c < nameLen; c++) name += String.fromCharCode(cd[off + 46 + c]);
    if (!name.endsWith('/')) {
      entries.push({ name, size, compressedSize, crc32: crc32Value, compressionMethod: method, localHeaderOffset });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * List members by reading only the archive's tail (EOCD + central
 * directory) — never the compressed payloads.
 */
export function listZipFromSource(src: ByteSource): ZipEntry[] | null {
  if (src.size < 22) return null;

  // Fast path: an archive with no trailing comment (the overwhelming
  // majority) puts the EOCD in its last 22 bytes, so listing a whole
  // archive costs 22 bytes plus the central directory. Only fall back to
  // the 64 KB comment scan when that check fails.
  let eocd = src.read(src.size - 22, 22);
  if (rd32(eocd, 0, 'le') !== EOCD_SIG) {
    const tailLen = Math.min(src.size, MAX_EOCD_SEARCH);
    const tail = src.read(src.size - tailLen, tailLen);
    let found = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (rd32(tail, i, 'le') === EOCD_SIG) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    eocd = tail.subarray(found, found + 22);
  }

  const count = rd16(eocd, 10, 'le');
  const cdSize = rd32(eocd, 12, 'le');
  const cdOffset = rd32(eocd, 16, 'le');
  if (cdOffset + cdSize > src.size) return null;

  const entries = parseCentralDirectory(src.read(cdOffset, cdSize), count);
  return entries.length > 0 || count === 0 ? entries : null;
}

/** List central-directory entries from a full in-memory archive. */
export function listZip(data: Uint8Array): ZipEntry[] | null {
  return listZipFromSource(bufferSource(data));
}

/** Decompress one member, reading only its own byte range from `src`. */
export function readZipEntryFromSource(src: ByteSource, entry: ZipEntry): Uint8Array {
  const header = src.read(entry.localHeaderOffset, 30);
  if (header.length < 30 || rd32(header, 0, 'le') !== LOCAL_SIG) {
    throw new Error(`zip: bad local header for ${entry.name}`);
  }
  // The local header repeats name/extra with its OWN lengths, which can
  // differ from the central directory's.
  const nameLen = rd16(header, 26, 'le');
  const extraLen = rd16(header, 28, 'le');
  const start = entry.localHeaderOffset + 30 + nameLen + extraLen;

  if (entry.compressionMethod === 0) {
    return src.read(start, entry.size);
  }
  if (entry.compressionMethod === 8) {
    // Trust the central directory's compressed size; a local header may
    // carry zeroes when a data descriptor follows the payload.
    const length = entry.compressedSize || src.size - start;
    return new Uint8Array(inflateRawSync(src.read(start, length)));
  }
  throw new Error(`zip: unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
}

/** Decompress one member from a full in-memory archive. */
export function readZipEntry(data: Uint8Array, entry: ZipEntry): Uint8Array {
  return readZipEntryFromSource(bufferSource(data), entry);
}

// ── CRC-32 (for dedupe keys of non-zip data) ───────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32, matching what ZIP central directories store. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
