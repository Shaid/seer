/**
 * PFS0 — the partition filesystem a Nintendo Switch NSP (and an NCA's ExeFS
 * section) is laid out as.
 *
 * A fixed 0x10 header, then one 0x18 entry per file, then a string table,
 * then the file data. Every field is little-endian:
 *
 * | Offset | Size | Field |
 * |---|---|---|
 * | `0x00` | 4 | magic `"PFS0"` |
 * | `0x04` | 4 | entry count |
 * | `0x08` | 4 | string-table size (padded, so the data base is aligned) |
 * | `0x0c` | 4 | reserved |
 *
 * and per entry, at `0x10 + i * 0x18`:
 *
 * | Offset | Size | Field |
 * |---|---|---|
 * | `0x00` | 8 | data offset, **relative to the data base** |
 * | `0x08` | 8 | size |
 * | `0x10` | 4 | name offset into the string table |
 * | `0x14` | 4 | reserved |
 *
 * The data base is `0x10 + entryCount * 0x18 + stringTableSize`, and
 * `parsePfs0` adds it, so every `Pfs0Entry.absOffset` is already absolute
 * within the container — which is why the field is not just called
 * `offset`. That is the one invariant worth stating loudly:
 * entry offsets as stored are *not* file offsets, and treating them as such
 * carves the wrong bytes out of a multi-gigabyte NSP without any error.
 *
 * Only the header region has to be in memory — an NSP is routinely tens of
 * gigabytes, so `pfs0HeaderLength` exists to let a caller read the 0x10
 * header, size the rest, and read exactly that much. See
 * `@seer-project/switch/node`'s `listPfs0File` for that shape.
 *
 * Scope: PFS0 only. XCI's HFS0 is the same idea with a 0x40 entry stride
 * and a per-entry hash, and is not implemented here.
 */

import { dataViewOf, fourCCAt } from '@seer-project/core';

/** Bytes of fixed header before the entry table. */
export const PFS0_HEADER_SIZE = 0x10;

/** Bytes per entry-table record. */
export const PFS0_ENTRY_SIZE = 0x18;

/** One file in a PFS0 partition, with its offset already made absolute. */
export interface Pfs0Entry {
  name: string;
  /** Offset from the start of the container, not from the PFS0 data base. */
  absOffset: number;
  size: number;
}

/** The counts in a PFS0's fixed header, and the sizes they imply. */
export interface Pfs0Header {
  entryCount: number;
  stringTableSize: number;
  /** Bytes of header + entry table + string table, i.e. the data base. */
  headerLength: number;
}

/**
 * Parse the 0x10-byte PFS0 header. Needs only those bytes. Throws when the
 * magic is not `PFS0` — the message names what was found instead, because
 * the usual cause is an XCI (`HFS0`) handed to an NSP reader.
 */
export function parsePfs0Header(bytes: Uint8Array): Pfs0Header {
  if (bytes.length < PFS0_HEADER_SIZE) throw new Error('not a PFS0 (truncated header)');
  const magic = fourCCAt(bytes, 0);
  if (magic !== 'PFS0') throw new Error(`not a PFS0 (${magic})`);
  const view = dataViewOf(bytes);
  const entryCount = view.getUint32(4, true);
  const stringTableSize = view.getUint32(8, true);
  return {
    entryCount,
    stringTableSize,
    headerLength: PFS0_HEADER_SIZE + entryCount * PFS0_ENTRY_SIZE + stringTableSize,
  };
}

/**
 * Bytes of `bytes` (or of the whole container) that `parsePfs0` has to see:
 * the header, the entry table and the string table. The file data after it
 * is never touched.
 */
export function pfs0HeaderLength(bytes: Uint8Array): number {
  return parsePfs0Header(bytes).headerLength;
}

/**
 * Walk a PFS0 entry table. `bytes` must cover at least the header region
 * (`pfs0HeaderLength`); the file data itself may be absent, which is what
 * makes this usable against a 30 GB NSP without reading it.
 */
export function parsePfs0(bytes: Uint8Array): Pfs0Entry[] {
  const { entryCount, stringTableSize, headerLength } = parsePfs0Header(bytes);
  if (bytes.length < headerLength) {
    throw new Error(`not a PFS0 (header region needs ${headerLength} bytes, got ${bytes.length})`);
  }
  const view = dataViewOf(bytes);
  const stringBase = PFS0_HEADER_SIZE + entryCount * PFS0_ENTRY_SIZE;
  const out: Pfs0Entry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const e = PFS0_HEADER_SIZE + i * PFS0_ENTRY_SIZE;
    const relative = view.getBigUint64(e, true);
    const size = view.getBigUint64(e + 8, true);
    const nameOffset = view.getUint32(e + 16, true);
    let name = '';
    for (let j = stringBase + nameOffset; j < stringBase + stringTableSize; j++) {
      const c = bytes[j];
      if (c === undefined || c === 0) break;
      name += String.fromCharCode(c);
    }
    out.push({ name, absOffset: Number(relative) + headerLength, size: Number(size) });
  }
  return out;
}
