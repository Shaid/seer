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
import {
  asciiAt,
  findEocdOffset,
  readZipCentralEntry,
  readZipEocd,
  zipEntryPayloadStart,
  ZIP_EOCD_BYTES,
  ZIP_LOCAL_HEADER_BYTES,
  ZIP_MAX_COMMENT_BYTES,
} from '@seer-project/core';
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

/** EOCD is 22 bytes plus a comment of at most 64 KB. */
const MAX_EOCD_SEARCH = ZIP_EOCD_BYTES + ZIP_MAX_COMMENT_BYTES;

export function isZipFile(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 3 || data[2] === 5) &&
    (data[3] === 4 || data[3] === 6)
  );
}

/**
 * Parse central-directory bytes. Record layout comes from
 * `@seer-project/core`'s `readZipCentralEntry`; the policy here is this
 * reader's own — stop at the first malformed record rather than throw
 * (a triage corpus contains damaged archives), decode names one byte per
 * code point, and drop directory entries.
 */
function parseCentralDirectory(cd: Uint8Array, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let off = 0;
  for (let i = 0; i < count; i++) {
    const rec = readZipCentralEntry(cd, off);
    if (!rec) break;
    const name = asciiAt(cd, rec.nameOffset, rec.nameLength);
    if (!name.endsWith('/')) {
      entries.push({
        name,
        size: rec.uncompressedSize,
        compressedSize: rec.compressedSize,
        crc32: rec.crc32,
        compressionMethod: rec.compressionMethod,
        localHeaderOffset: rec.localHeaderOffset,
      });
    }
    off = rec.nextOffset;
  }
  return entries;
}

/**
 * List members by reading only the archive's tail (EOCD + central
 * directory) — never the compressed payloads.
 */
export function listZipFromSource(src: ByteSource): ZipEntry[] | null {
  if (src.size < ZIP_EOCD_BYTES) return null;

  // The EOCD sits at the end, behind a comment of up to 64 KB. A first
  // probe of 22 bytes would only catch comment-less archives — and real
  // collections are torrentzipped, which stamps a 22-byte
  // "TORRENTZIPPED-xxxxxxxx" comment on EVERY archive, so that probe
  // missed on 100% of a TOSEC corpus and each miss cost a 64 KB
  // fallback read. A 1 KB first probe covers torrentzip and practically
  // every human-written comment; the full 64 KB scan remains as the
  // rare-case fallback.
  const searchTail = (tail: Uint8Array): Uint8Array | null => {
    const at = findEocdOffset(tail);
    return at < 0 ? null : tail.subarray(at, at + ZIP_EOCD_BYTES);
  };
  const probeLen = Math.min(src.size, 1024);
  let eocd = searchTail(src.read(src.size - probeLen, probeLen));
  if (!eocd && src.size > probeLen) {
    const tailLen = Math.min(src.size, MAX_EOCD_SEARCH);
    eocd = searchTail(src.read(src.size - tailLen, tailLen));
  }
  if (!eocd) return null;

  const { entryCount: count, centralDirSize: cdSize, centralDirOffset: cdOffset } = readZipEocd(eocd);
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
  const header = src.read(entry.localHeaderOffset, ZIP_LOCAL_HEADER_BYTES);
  // The local header repeats name/extra with its OWN lengths, which can
  // differ from the central directory's — see `zipEntryPayloadStart`.
  const start = zipEntryPayloadStart(header, entry.localHeaderOffset);
  if (start < 0) {
    throw new Error(`zip: bad local header for ${entry.name}`);
  }

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
