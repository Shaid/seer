/**
 * Minimal MAME-style ROM-set ZIP reader.
 *
 * Arcade platform data (`data/<game>/<platform>/*.zip`) ships as a plain ZIP
 * archive bundling one file per ROM chip (68000 program EPROMs, gfx/QSound
 * mask ROMs, a small `.key` file for CPS2's battery-backed encryption key,
 * etc). These sets are produced by "TorrentZip" — a deterministic,
 * store-or-deflate-only ZIP writer — but the format itself is plain
 * PKZIP: a local file header per entry, an End Of Central Directory (EOCD)
 * record (with the "TORRENTZIPPED-XXXXXXXX" comment MAME/clrmame tooling
 * uses to detect a canonicalized set), and a central directory listing
 * every entry's compressed/uncompressed size and its local-header offset.
 *
 * The container's structural layer — signatures, record sizes, the backward
 * EOCD scan, the central-directory and local-header field offsets — comes
 * from `@seer-project/core`'s `zip.ts`, shared with `@seer-project/probe`'s
 * tail-reading triage reader (this file and that one had independently
 * written the same field offsets). What stays here is this reader's own
 * policy: whole file in memory, UTF-8 member names, every entry kept, and a
 * throw on anything malformed — a broken ROM set is an error, not a data
 * point. The two compression methods MAME/TorrentZip ever emit (0 = stored,
 * 8 = deflate) are both handled by Node's built-in `node:zlib`.
 *
 * Confirmed: `readMameZip()` output CRC32s match every file's CRC32 as
 * reported by `unzip -v`, which themselves match the CRCs MAME's own
 * `src/mame/capcom/cps2.cpp` ROM_START(ddsom) declares byte-for-byte (see
 * docs/ddsom/cps2/data-structure.md § "Container: ddsom.zip").
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import {
  findEocdOffset,
  readZipCentralEntry,
  readZipEocd,
  zipEntryPayloadStart,
} from '@seer-project/core';

interface CentralDirEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(buf: Buffer): CentralDirEntry[] {
  const eocd = findEocdOffset(buf);
  if (eocd < 0) throw new Error('Not a ZIP file (no End Of Central Directory record found)');
  const { entryCount, centralDirOffset } = readZipEocd(buf, eocd);

  const entries: CentralDirEntry[] = [];
  let pos = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    const rec = readZipCentralEntry(buf, pos);
    if (!rec) throw new Error(`Bad central directory entry at offset 0x${pos.toString(16)}`);
    entries.push({
      // UTF-8, not one-byte-per-code-point: MAME set names are ASCII in
      // practice, but the ZIP spec's flag bit 11 says UTF-8 and the
      // original reader decoded them that way.
      name: buf.toString('utf8', rec.nameOffset, rec.nameOffset + rec.nameLength),
      compressionMethod: rec.compressionMethod,
      compressedSize: rec.compressedSize,
      uncompressedSize: rec.uncompressedSize,
      localHeaderOffset: rec.localHeaderOffset,
    });
    pos = rec.nextOffset;
  }
  return entries;
}

/** Read one entry's decompressed bytes, given its central-directory record. */
function readEntryData(buf: Buffer, entry: CentralDirEntry): Uint8Array {
  const lh = entry.localHeaderOffset;
  const dataStart = zipEntryPayloadStart(buf, lh, lh);
  if (dataStart < 0) {
    throw new Error(`Bad local file header for "${entry.name}" at offset 0x${lh.toString(16)}`);
  }
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  }
  if (entry.compressionMethod === 8) {
    const inflated = inflateRawSync(compressed);
    return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  }
  throw new Error(
    `Unsupported ZIP compression method ${entry.compressionMethod} for "${entry.name}"`,
  );
}

/**
 * Read every entry of a MAME-style ROM-set ZIP into a name -> bytes map.
 * Names are returned exactly as stored in the archive (case preserved);
 * MAME romsets use lowercase filenames throughout.
 */
export function readMameZip(zipPath: string): Map<string, Uint8Array> {
  const buf = readFileSync(zipPath);
  const entries = readCentralDirectory(buf);
  const result = new Map<string, Uint8Array>();
  for (const entry of entries) {
    result.set(entry.name, readEntryData(buf, entry));
  }
  return result;
}
