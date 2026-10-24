/**
 * CRI CPK reader.
 *
 * Decodes the CPK container: header UTF table (decryptable with CRI's
 * DecryptUTF LCG), the TOC file table, and CRILAYLA-compressed file
 * payloads. Ported from the CriPakTools reference implementation
 * (https://github.com/esperknight/CriPakTools) and verified against a real
 * Dragon's Crown PS3 CPK (`DRACRO.CPK`): 2,209 files listed, first file
 * (character/AncientDragon00.ftx) decompresses to a real FTEX texture.
 *
 * This module also holds the shared `@UTF`-table parser engine (`parseUtf`,
 * `readUtfRow`, `subUtfTable`, `UtfColumn`/`UtfTable`/`UtfRow`) that CRI's
 * ACB/AWB sound-bank formats reuse — see `acb.ts`/`awb.ts`.
 *
 * Browser-safe: pure `Uint8Array`/`DataView`, no `Buffer`/`node:` usage.
 *
 * Container layout (big-endian inside the UTF tables):
 *   "CPK " magic
 *   u32   unk1
 *   u64le header utf_size
 *   byte[utf_size]  header UTF packet (DecryptUTF'd -> "@UTF" table)
 *   ... TOC ("TOC " magic + u64le size + packet) at TocOffset ...
 *   ... file payloads from ContentOffset ...
 */

import { dataViewOf } from '@seer-project/core';

export const SECTOR = 0x800;

/** Find the first zero byte at or after `start`, or -1 if none (mirrors Buffer.indexOf(0, start)). */
function indexOfZero(buf: Uint8Array, start: number): number {
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0) return i;
  }
  return -1;
}

/** Decode `len` bytes at `start` as ASCII (mirrors Buffer.toString('ascii', ...): top bit dropped per byte). */
function asciiAt(buf: Uint8Array, start: number, len: number): string {
  let out = '';
  const end = Math.min(start + len, buf.length);
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(buf[i]! & 0x7f);
  }
  return out;
}

/** CRI DecryptUTF: byte stream XOR against an LCG (m=0x655f, t=0x4115). */
export function decryptUtf(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let m = 0x0000655f;
  const t = 0x00004115;
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i]! ^ (m & 0xff)) & 0xff;
    m = (m * t) >>> 0;
  }
  return out;
}

/**
 * A CPK's `@UTF` packets may be stored already-plaintext — CRI builds can
 * disable DecryptUTF (confirmed: Grand Knights History PSP `GKH.CPK`
 * starts `CPK ` + `ff 00 00 00` + an unencrypted `@UTF` packet, while
 * Dragon's Crown PS3 `DRACRO.CPK` packets are DecryptUTF-encrypted).
 * Auto-detect: if the packet already begins with `@UTF`, use it as-is.
 */
export function utfPacket(packet: Uint8Array): Uint8Array {
  return asciiAt(packet, 0, 4) === '@UTF' ? packet : decryptUtf(packet);
}

export interface UtfColumn {
  flags: number;
  name: string;
  /**
   * Present only for storage type 0x30 ("constant") columns — CRI's @UTF
   * schema embeds a single shared value for these directly in the column
   * definition instead of allocating per-row storage. Confirmed on Dragon's
   * Crown's ACB tables (e.g. `SynthTable`'s `Worksize`, a constant u16, and
   * `UserData`, a constant empty string) — the CPK container's own header/
   * TOC tables never exercised this path, which is why it went unhandled
   * until the ACB reader needed it. See readUtfRow: a constant column
   * contributes zero bytes to rowLength and its value is always this one.
   */
  constantValue?: number | bigint | string | { offset: number; length: number };
}

export interface UtfTable {
  tableSize: number;
  rowsOffset: number;
  stringsOffset: number;
  dataOffset: number;
  tableName: number;
  numColumns: number;
  rowLength: number;
  numRows: number;
  columns: UtfColumn[];
  /** Raw decrypted packet bytes (for data blobs / strings). */
  buf: Uint8Array;
}

/**
 * Read one @UTF-typed value (the low nibble of a column's flags byte, 0-0xb)
 * at `pos` in `buf`, returning `[value, bytesConsumed]`. Shared by
 * `parseUtf` (constant-storage columns, read once from the schema) and
 * `readUtfRow` (per-row columns, read once per row) — both need the exact
 * same per-type width/decode logic.
 */
function readUtfValue(
  buf: Uint8Array,
  pos: number,
  typ: number,
  stringsBase: number,
): [number | bigint | string | { offset: number; length: number }, number] {
  const view = dataViewOf(buf);
  switch (typ) {
    case 0:
    case 1:
      return [buf[pos]!, 1];
    case 2:
    case 3:
      return [view.getUint16(pos, false), 2];
    case 4:
    case 5:
      return [view.getUint32(pos, false), 4];
    case 6:
    case 7:
      return [view.getBigUint64(pos, false), 8];
    case 8:
      return [view.getFloat32(pos, false), 4];
    case 0xa: {
      const so = view.getUint32(pos, false);
      const start = stringsBase + so;
      const end = indexOfZero(buf, start);
      const stop = end >= 0 ? end : start + 32;
      return [asciiAt(buf, start, stop - start), 4];
    }
    case 0xb: {
      const po = view.getUint32(pos, false);
      const ln = view.getUint32(pos + 4, false);
      return [{ offset: po, length: ln }, 8];
    }
    default:
      return [0, 4];
  }
}

/** Parse a big-endian @UTF table from already-decrypted bytes. */
export function parseUtf(buf: Uint8Array, base = 0): UtfTable {
  const view = dataViewOf(buf);
  const u32 = (o: number) => view.getUint32(base + o, false);
  const u16 = (o: number) => view.getUint16(base + o, false);
  if (asciiAt(buf, base, 4) !== '@UTF') {
    throw new Error('Not an @UTF table');
  }
  const tableSize = u32(4);
  const rowsOffset = u32(8);
  const stringsOffset = u32(12);
  const dataOffset = u32(16);
  const tableName = u32(20);
  const numColumns = u16(24);
  const rowLength = u16(26);
  const numRows = u32(28);
  const columns: UtfColumn[] = [];
  let pos = 32;
  const stringsBase = base + 8 + stringsOffset;
  for (let i = 0; i < numColumns; i++) {
    let flags = buf[base + pos]!;
    pos += 1;
    if (flags === 0) {
      pos += 3;
      flags = buf[base + pos]!;
      pos += 1;
    }
    const nameOff = u32(pos);
    pos += 4;
    const nameStart = stringsBase + nameOff;
    const nameEnd = indexOfZero(buf, nameStart);
    const nameStop = nameEnd >= 0 ? nameEnd : nameStart + 32;
    const name = asciiAt(buf, nameStart, nameStop - nameStart);
    const storage = flags & 0xf0;
    const typ = flags & 0x0f;
    // Storage 0x30 ("constant"): the schema embeds one shared value for
    // every row right here, immediately after nameOff — consuming schema
    // bytes but NOT contributing to rowLength/per-row storage. Storage
    // 0x10 ("none") has no value at all, constant or per-row.
    if (storage === 0x30) {
      const [value, width] = readUtfValue(buf, base + pos, typ, stringsBase);
      pos += width;
      columns.push({ flags, name, constantValue: value });
    } else {
      columns.push({ flags, name });
    }
  }
  return { tableSize, rowsOffset, stringsOffset, dataOffset, tableName, numColumns, rowLength, numRows, columns, buf };
}

export interface UtfRow {
  [name: string]: number | bigint | string | { offset: number; length: number } | undefined;
}

/**
 * Resolve a type-0xb ("data blob") column's value (as returned in a
 * `UtfRow`) into its own nested `@UTF` sub-table, parsed from `parent`'s own
 * buffer at the blob's declared offset/length — the standard way CRI @UTF
 * tables nest (e.g. an ACB row's `CueTable`/`WaveformTable`/`SynthTable`
 * columns, or a CPK ITOC row's `DataL`/`DataH` columns). Returns null if
 * `col` isn't a well-formed blob reference.
 */
export function subUtfTable(parent: UtfTable, col: unknown): UtfTable | null {
  if (!col || typeof col !== 'object' || !('offset' in col) || !('length' in col)) return null;
  const { offset, length } = col as { offset: number; length: number };
  const blobBase = 8 + parent.dataOffset;
  const start = blobBase + offset;
  if (length <= 0 || start + length > parent.buf.length) return null;
  const sub = parent.buf.subarray(start, start + length);
  if (sub.length < 4 || asciiAt(sub, 0, 4) !== '@UTF') return null;
  return parseUtf(sub);
}

/** Read one row of a parsed @UTF table (big-endian values). */
export function readUtfRow(utf: UtfTable, row: number): UtfRow {
  const { buf } = utf;
  const base = 8 + utf.rowsOffset + row * utf.rowLength;
  const stringsBase = 8 + utf.stringsOffset;
  let pos = base;
  const out: UtfRow = {};
  for (const col of utf.columns) {
    const storage = col.flags & 0xf0;
    const typ = col.flags & 0x0f;
    if (storage === 0x50) {
      // Per-row storage: value lives at `pos` in this row's own bytes.
      const [value, width] = readUtfValue(buf, pos, typ, stringsBase);
      out[col.name] = value;
      pos += width;
    } else if (storage === 0x30) {
      // Constant storage: one shared value embedded in the schema itself
      // (parseUtf already decoded it into constantValue) — every row
      // reports the same value, and it consumes zero row bytes.
      out[col.name] = col.constantValue;
    }
    // storage === 0x10 ("none"): no value, no row bytes.
  }
  return out;
}

export interface CpkHeader {
  contentOffset: number;
  tocOffset: number;
  files: number;
  align: number;
  version: number;
  revision: number;
  tvers: string;
}

export interface CpkFileEntry {
  dirName: string;
  fileName: string;
  fileSize: number;
  extractSize: number;
  fileOffset: number;
  id: number;
}

/** Read and decrypt the CPK header; returns parsed values. */
export function readCpkHeader(buf: Uint8Array): CpkHeader {
  if (asciiAt(buf, 0, 4) !== 'CPK ') throw new Error('Not a CPK file');
  const utfSize = dataViewOf(buf).getBigUint64(8, true);
  const dec = utfPacket(buf.subarray(0x10, 0x10 + Number(utfSize)));
  const utf = parseUtf(dec);
  const row = readUtfRow(utf, 0);
  return {
    contentOffset: Number(row['ContentOffset'] ?? 0),
    tocOffset: Number(row['TocOffset'] ?? 0),
    files: Number(row['Files'] ?? 0),
    align: Number(row['Align'] ?? 0),
    version: Number(row['Version'] ?? 0),
    revision: Number(row['Revision'] ?? 0),
    tvers: String(row['Tvers'] ?? ''),
  };
}

export interface CpkFileTable {
  header: CpkHeader;
  entries: CpkFileEntry[];
}

/**
 * Parse a raw (already-decrypted) TOC `@UTF` packet into file entries.
 * `addOffset` is added to each FileOffset (per CriPakTools it is
 * min(ContentOffset, TocOffset)). Used both by readCpkFileTable and by
 * readers that must seek to a TOC that lives late in the CPK.
 */
export function parseCpkTocPacket(packet: Uint8Array, addOffset: number): CpkFileEntry[] {
  const utf = parseUtf(packet);
  const entries: CpkFileEntry[] = [];
  for (let r = 0; r < utf.numRows; r++) {
    const row = readUtfRow(utf, r);
    entries.push({
      dirName: String(row['DirName'] ?? ''),
      fileName: String(row['FileName'] ?? ''),
      fileSize: Number(row['FileSize'] ?? 0),
      extractSize: Number(row['ExtractSize'] ?? 0),
      fileOffset: Number(row['FileOffset'] ?? 0) + addOffset,
      id: Number(row['ID'] ?? 0),
    });
  }
  return entries;
}

/** Read the TOC table and return the full file listing. */
export function readCpkFileTable(buf: Uint8Array, header: CpkHeader): CpkFileTable {
  const tocOff = header.tocOffset;
  if (asciiAt(buf, tocOff, 4) !== 'TOC ') throw new Error('Missing TOC magic');
  const tocSize = dataViewOf(buf).getBigUint64(tocOff + 8, true);
  const dec = utfPacket(buf.subarray(tocOff + 16, tocOff + 16 + Number(tocSize)));
  // add_offset = min(ContentOffset, TocOffset) per CriPakTools
  const addOffset = Math.min(header.contentOffset, header.tocOffset);
  return { header, entries: parseCpkTocPacket(dec, addOffset) };
}

/** CRILAYLA decompressor (ported from CriPakTools DecompressCRILAYLA). */
export function decompressCrilayla(input: Uint8Array): Uint8Array {
  const buf = input;
  const view = dataViewOf(buf);
  const uncompressedSize = view.getUint32(8, true);
  const headerOffset = view.getUint32(12, true);
  const result = new Uint8Array(uncompressedSize + 0x100);
  result.set(buf.subarray(headerOffset + 0x10, headerOffset + 0x10 + 0x100), 0);

  const inputEnd = buf.length - 0x100 - 1;
  let inputOffset = inputEnd;
  const outputEnd = 0x100 + uncompressedSize - 1;
  let bitPool = 0;
  let bitsLeft = 0;
  let bytesOutput = 0;
  const vleLens = [2, 3, 5, 8];

  const getBits = (count: number): number => {
    let out = 0;
    let produced = 0;
    while (produced < count) {
      if (bitsLeft === 0) {
        bitPool = buf[inputOffset]!;
        bitsLeft = 8;
        inputOffset--;
      }
      const n = bitsLeft > count - produced ? count - produced : bitsLeft;
      out = (out << n) | ((bitPool >> (bitsLeft - n)) & ((1 << n) - 1));
      bitsLeft -= n;
      produced += n;
    }
    return out;
  };

  while (bytesOutput < uncompressedSize) {
    const pos = outputEnd - bytesOutput;
    if (getBits(1) > 0) {
      let backRef = pos + getBits(13) + 3;
      let len = 3;
      let finalVle = 0;
      for (const vle of vleLens) {
        const level = getBits(vle);
        len += level;
        finalVle = level;
        if (level !== (1 << vle) - 1) break;
      }
      // The final 8-bit VLE group may repeat while it is 0xff.  Large
      // texture streams exercise this path; stopping after one group leaves
      // the bit reader out of sync even though short fixtures still decode.
      while (finalVle === 0xff) {
        finalVle = getBits(8);
        len += finalVle;
      }
      for (let i = 0; i < len; i++) {
        if (bytesOutput >= uncompressedSize) break;
        result[outputEnd - bytesOutput] = result[backRef]!;
        backRef--;
        bytesOutput++;
      }
    } else {
      result[outputEnd - bytesOutput] = getBits(8);
      bytesOutput++;
    }
  }
  return result;
}
