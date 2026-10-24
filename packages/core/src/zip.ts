/**
 * The PKZIP container's structural layer: signatures, record sizes, the
 * backward End-Of-Central-Directory scan, and the fixed-field layout of a
 * central-directory record and a local file header.
 *
 * This is deliberately *only* the structure. It performs no I/O, decompresses
 * nothing, and does not decode member names — because that is exactly where
 * the two readers in this repo legitimately differ, and the thing they
 * actually duplicated was the field offsets (10/16/20/24/28/30/32/42/46 and
 * 26/28/30) and the EOCD scan, twice, from two different reference
 * implementations:
 *
 * - `@seer-project/probe`'s `zip.ts` reads only the archive's *tail* through
 *   a `ByteSource`, decodes names one byte per code point, skips directory
 *   entries, and returns `null` rather than throwing on a malformed archive
 *   (it triages corpora that contain damaged files).
 * - `@seer-project/arcade`'s `mame-zip.ts` holds the whole file in a
 *   `Buffer`, decodes names as UTF-8, keeps every entry, and throws (a
 *   malformed MAME ROM set is a hard error, not a data point).
 *
 * Both of those policies are right for their caller, so each keeps its own
 * loop over these primitives.
 *
 * Scope: no zip64, no encryption, no data-descriptor recovery — the callers
 * handle what they need above this layer.
 */

import { r16, r32 } from './binary.js';

export const ZIP_EOCD_SIG = 0x06054b50;
export const ZIP_CENTRAL_SIG = 0x02014b50;
export const ZIP_LOCAL_SIG = 0x04034b50;

/** Size of the End Of Central Directory record, excluding any trailing comment. */
export const ZIP_EOCD_BYTES = 22;
/** Fixed part of a central-directory record, before name/extra/comment. */
export const ZIP_CENTRAL_HEADER_BYTES = 46;
/** Fixed part of a local file header, before name/extra. */
export const ZIP_LOCAL_HEADER_BYTES = 30;
/** The EOCD comment length field is 16-bit, so a comment can be this long. */
export const ZIP_MAX_COMMENT_BYTES = 0xffff;

/**
 * Scan backward from the end of `data` for the EOCD signature, returning its
 * offset or `-1`. The scan stops `maxCommentBytes` before the last possible
 * EOCD position, since the record can only be followed by its own comment.
 *
 * Backward, not forward, because the signature can occur by chance inside
 * compressed data; the *last* occurrence is the real one.
 */
export function findEocdOffset(data: Uint8Array, maxCommentBytes = ZIP_MAX_COMMENT_BYTES): number {
  const min = Math.max(0, data.length - ZIP_EOCD_BYTES - maxCommentBytes);
  for (let i = data.length - ZIP_EOCD_BYTES; i >= min; i--) {
    if (r32(data, i, 'le') === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

/** The three EOCD fields a reader needs to find and size the central directory. */
export interface ZipEocd {
  entryCount: number;
  centralDirSize: number;
  centralDirOffset: number;
}

/** Read the EOCD record at `off` (its signature is assumed already matched). */
export function readZipEocd(data: Uint8Array, off = 0): ZipEocd {
  return {
    entryCount: r16(data, off + 10, 'le'),
    centralDirSize: r32(data, off + 12, 'le'),
    centralDirOffset: r32(data, off + 16, 'le'),
  };
}

/**
 * One central-directory record's fixed fields. The member's name is given as
 * a byte range rather than a string: the two readers in this repo decode it
 * differently (one byte-per-code-point, one UTF-8), and that choice belongs
 * to the caller.
 */
export interface ZipCentralEntry {
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Offset of the name bytes within the same buffer this was read from. */
  nameOffset: number;
  nameLength: number;
  /** Offset of the next record — this one's size, including name/extra/comment. */
  nextOffset: number;
}

/**
 * Read the central-directory record at `off`, or `null` if there isn't one
 * there (the buffer is too short, or the signature doesn't match). Returning
 * `null` rather than throwing lets each caller pick its own policy for a
 * malformed archive.
 */
export function readZipCentralEntry(data: Uint8Array, off: number): ZipCentralEntry | null {
  if (off < 0 || off + ZIP_CENTRAL_HEADER_BYTES > data.length) return null;
  if (r32(data, off, 'le') !== ZIP_CENTRAL_SIG) return null;
  const nameLength = r16(data, off + 28, 'le');
  const extraLength = r16(data, off + 30, 'le');
  const commentLength = r16(data, off + 32, 'le');
  return {
    compressionMethod: r16(data, off + 10, 'le'),
    crc32: r32(data, off + 16, 'le'),
    compressedSize: r32(data, off + 20, 'le'),
    uncompressedSize: r32(data, off + 24, 'le'),
    localHeaderOffset: r32(data, off + 42, 'le'),
    nameOffset: off + ZIP_CENTRAL_HEADER_BYTES,
    nameLength,
    nextOffset: off + ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength,
  };
}

/**
 * Where a member's compressed payload begins, given `header` — at least
 * `ZIP_LOCAL_HEADER_BYTES` starting at the local header — and the header's
 * absolute offset in the archive. Returns `-1` if the signature doesn't match.
 *
 * The local header repeats the name and extra field with its *own* lengths,
 * which the spec allows to differ from the central directory's, so the
 * payload offset has to be computed from the local header and not guessed
 * from the central one.
 */
export function zipEntryPayloadStart(header: Uint8Array, localHeaderOffset: number, headerOff = 0): number {
  if (header.length - headerOff < ZIP_LOCAL_HEADER_BYTES) return -1;
  if (r32(header, headerOff, 'le') !== ZIP_LOCAL_SIG) return -1;
  const nameLength = r16(header, headerOff + 26, 'le');
  const extraLength = r16(header, headerOff + 28, 'le');
  return localHeaderOffset + ZIP_LOCAL_HEADER_BYTES + nameLength + extraLength;
}
