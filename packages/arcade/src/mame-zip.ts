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
 * No project dependency ships a ZIP reader, and the two compression
 * methods MAME/TorrentZip ever emit (0 = stored, 8 = deflate) are both
 * handled by Node's built-in `node:zlib`, so this avoids adding one.
 *
 * Confirmed: `readMameZip()` output CRC32s match every file's CRC32 as
 * reported by `unzip -v`, which themselves match the CRCs MAME's own
 * `src/mame/capcom/cps2.cpp` ROM_START(ddsom) declares byte-for-byte (see
 * docs/ddsom/cps2/data-structure.md § "Container: ddsom.zip").
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

interface CentralDirEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Locate the EOCD record by scanning backward from EOF (it may be followed by a comment of arbitrary length, e.g. TorrentZip's 22-byte marker). */
function findEndOfCentralDirectory(buf: Buffer): number {
  const maxCommentLength = 65535;
  const minPos = Math.max(0, buf.length - 22 - maxCommentLength);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Not a ZIP file (no End Of Central Directory record found)');
}

function readCentralDirectory(buf: Buffer): CentralDirEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralDirOffset = buf.readUInt32LE(eocd + 16);

  const entries: CentralDirEntry[] = [];
  let pos = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`Bad central directory entry at offset 0x${pos.toString(16)}`);
    }
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);

    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Read one entry's decompressed bytes, given its central-directory record. */
function readEntryData(buf: Buffer, entry: CentralDirEntry): Uint8Array {
  const lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`Bad local file header for "${entry.name}" at offset 0x${lh.toString(16)}`);
  }
  const nameLength = buf.readUInt16LE(lh + 26);
  const extraLength = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLength + extraLength;
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
