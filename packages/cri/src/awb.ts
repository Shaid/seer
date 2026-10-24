/**
 * CRI AWB (Atom Wave Bank) readers — two structurally distinct sub-formats:
 *
 * 1. **AFS2** (e.g. Dragon's Crown PS3 `snd/*.awb`) — the classic wave-bank
 *    layout: `AFS2` magic, a flat id table, then an offset table.
 * 2. **Nested-CPK/ITOC** (e.g. Grand Knights History PSP `snd/*.awb` and
 *    the embedded wave data inside `snd/*.acb` files) — despite the `.awb`
 *    extension, the wave bank is itself a complete mini CPK container
 *    (`CPK ` magic) using CRI's ITOC (id-indexed table-of-contents) TOC
 *    variant instead of the classic AFS2 layout. Confirmed via its own
 *    `Tvers` string (`awb.01.01.00, DLL2.78.04`).
 *
 * Both are parsed here as "list of {id, offset, size} relative to the
 * AWB's own start byte" — decoding the audio payload itself is out of
 * scope for both containers (HCA for AFS2, ATRAC3-in-WAV for ITOC are both
 * out of scope for this package).
 */
import { dataViewOf, fourCCAt } from '@seer-project/core';
import { parseUtf, readUtfRow, subUtfTable, type UtfTable } from './cpk.js';

export interface AwbEntry {
  id: number;
  /** Byte offset relative to the AWB container's own start. */
  offset: number;
  size: number;
}

export interface AwbTable {
  format: 'afs2' | 'itoc-cpk';
  entries: AwbEntry[];
}

/**
 * Parse a classic AFS2 wave bank. `buf` must contain the whole header
 * region (magic through the offset table) — safe to over-read a chunk
 * that also includes payload bytes.
 */
export function parseAfs2(buf: Uint8Array): AwbTable | null {
  if (buf.length < 0x10) return null;
  const tag = fourCCAt(buf);
  if (tag !== 'AFS2') return null;
  const dv = dataViewOf(buf);
  const offsetSize = buf[5]!;
  const idSize = buf[6]!;
  const count = dv.getUint32(8, true);
  // `align` (header byte 12, e.g. 32) does NOT gate the id-table -> offset-
  // table transition — a prior version of this parser rounded
  // offsetTableStart up to it, which silently shifted the WHOLE offset
  // table forward by one 4-byte slot for every real corpus file tested
  // (idTableLen happened to be < align already), corrupting every entry's
  // resolved byte range and making the last entry's size go negative.
  // Confirmed byte-exact via an independent oracle (Dragon's Crown's
  // `bgm.awb`: searching the whole 161,966,642-byte file for the literal
  // `HCA\0` magic finds exactly 54 hits — matching `count` and
  // vgmstream-cli's own reported `stream count: 54` — and the UNALIGNED
  // offset table (id-table end, byte 124, no rounding) reproduces all 54
  // hit positions within 0-30 bytes (small intra-slot padding before each
  // stream's own magic — expected, not a boundary error), while the
  // 32-byte-aligned table (byte 128) reproduces none of them exactly and
  // its computed entry 53 has offset === buf.length (a negative size).
  // `align` instead governs the DATA layout: consecutive real entries'
  // offsets are placed `align`-bytes-rounded apart from each other.
  const idTableStart = 0x10;
  const idTableLen = count * idSize;
  if (buf.length < idTableStart + idTableLen) return null;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = idTableStart + i * idSize;
    ids.push(idSize === 2 ? dv.getUint16(p, true) : dv.getUint32(p, true));
  }

  const offsetTableStart = idTableStart + idTableLen;
  const nOffsets = count + 1; // trailing entry = end-of-last-file offset
  const offsetsLen = nOffsets * offsetSize;
  if (buf.length < offsetTableStart + offsetsLen) return null;
  const offsets: number[] = [];
  for (let i = 0; i < nOffsets; i++) {
    const p = offsetTableStart + i * offsetSize;
    offsets.push(offsetSize === 4 ? dv.getUint32(p, true) : Number(dv.getBigUint64(p, true)));
  }

  const entries: AwbEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({ id: ids[i]!, offset: offsets[i]!, size: offsets[i + 1]! - offsets[i]! });
  }
  return { format: 'afs2', entries };
}

/**
 * Parse a nested-CPK/ITOC wave bank (GKH's `.awb` shape). `buf` must
 * contain the whole mini-CPK header + ITOC table (a few KB is enough —
 * the ITOC packet's own declared size bounds it, checked below).
 */
export function parseItocAwb(buf: Uint8Array): AwbTable | null {
  if (buf.length < 0x20) return null;
  const tag = fourCCAt(buf);
  if (tag !== 'CPK ') return null;
  const dv = dataViewOf(buf);
  const utfSize = Number(dv.getBigUint64(8, true));
  if (buf.length < 0x10 + utfSize) return null;
  const header = parseUtf(buf.subarray(0x10, 0x10 + utfSize));
  const row = readUtfRow(header, 0);
  const contentOffset = Number(row['ContentOffset'] ?? 0);
  const itocOffset = Number(row['ItocOffset'] ?? 0);
  const align = Number(row['Align'] ?? 32) || 32;
  if (!itocOffset) return null;

  if (buf.length < itocOffset + 0x10) return null;
  const itocMagic = fourCCAt(buf, itocOffset);
  if (itocMagic !== 'ITOC') return null;
  const itocPacketSize = Number(dv.getBigUint64(itocOffset + 8, true));
  if (buf.length < itocOffset + 0x10 + itocPacketSize) return null;
  const itoc = parseUtf(buf.subarray(itocOffset + 0x10, itocOffset + 0x10 + itocPacketSize));
  const itocRow = readUtfRow(itoc, 0);

  const readBlob = (col: unknown): { id: number; size: number }[] => {
    const t = subUtfTable(itoc, col);
    if (!t) return [];
    const out: { id: number; size: number }[] = [];
    for (let i = 0; i < t.numRows; i++) {
      const r = readUtfRow(t, i);
      out.push({ id: Number(r['ID'] ?? 0), size: Number(r['FileSize'] ?? 0) });
    }
    return out;
  };

  const rows = [...readBlob(itocRow['DataL']), ...readBlob(itocRow['DataH'])].sort((a, b) => a.id - b.id);
  const entries: AwbEntry[] = [];
  let cursor = contentOffset;
  const roundUp = (x: number, a: number) => Math.ceil(x / a) * a;
  for (const r of rows) {
    entries.push({ id: r.id, offset: cursor, size: r.size });
    cursor += roundUp(r.size, align);
  }
  return { format: 'itoc-cpk', entries };
}

/** Try AFS2 first, then the nested-CPK/ITOC shape. */
export function parseAwb(buf: Uint8Array): AwbTable | null {
  return parseAfs2(buf) ?? parseItocAwb(buf);
}

export type { UtfTable };
