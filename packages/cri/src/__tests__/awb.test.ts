import { describe, it, expect } from 'vitest';
import { parseAfs2, parseItocAwb, parseAwb } from '../awb.js';
import { buildUtf } from './utf-builder.js';

/** Build a minimal synthetic AFS2 wave-bank header (id table + offset table only — no payload bytes). */
function buildAfs2(ids: number[], offsets: number[], opts: { idSize: 2 | 4; offsetSize: 4 | 8 } = { idSize: 2, offsetSize: 4 }): Uint8Array {
  const idTableStart = 0x10;
  const idTableLen = ids.length * opts.idSize;
  const offsetTableStart = idTableStart + idTableLen;
  const offsetsLen = offsets.length * opts.offsetSize;
  const buf = new Uint8Array(offsetTableStart + offsetsLen);
  buf.set([0x41, 0x46, 0x53, 0x32], 0); // "AFS2"
  buf[5] = opts.offsetSize;
  buf[6] = opts.idSize;
  new DataView(buf.buffer).setUint32(8, ids.length, true);
  const view = new DataView(buf.buffer);
  ids.forEach((id, i) => {
    const p = idTableStart + i * opts.idSize;
    if (opts.idSize === 2) view.setUint16(p, id, true);
    else view.setUint32(p, id, true);
  });
  offsets.forEach((off, i) => {
    const p = offsetTableStart + i * opts.offsetSize;
    if (opts.offsetSize === 4) view.setUint32(p, off, true);
    else view.setBigUint64(p, BigInt(off), true);
  });
  return buf;
}

describe('awb — AFS2', () => {
  it('parses a synthetic AFS2 header into {id, offset, size} entries', () => {
    const awb = parseAfs2(buildAfs2([10, 11, 12], [100, 150, 220, 300]));
    expect(awb).not.toBeNull();
    expect(awb!.format).toBe('afs2');
    expect(awb!.entries).toEqual([
      { id: 10, offset: 100, size: 50 },
      { id: 11, offset: 150, size: 70 },
      { id: 12, offset: 220, size: 80 },
    ]);
  });

  it('supports the 4-byte id / 8-byte offset variant', () => {
    const awb = parseAfs2(buildAfs2([1000, 2000], [500, 600, 900], { idSize: 4, offsetSize: 8 }));
    expect(awb!.entries).toEqual([
      { id: 1000, offset: 500, size: 100 },
      { id: 2000, offset: 600, size: 300 },
    ]);
  });

  it('rejects a buffer without the AFS2 magic', () => {
    expect(parseAfs2(new Uint8Array(32))).toBeNull();
  });

  it('parseItocAwb rejects an AFS2 buffer', () => {
    expect(parseItocAwb(buildAfs2([1], [0, 10]))).toBeNull();
  });
});

/** Build a synthetic nested-CPK/ITOC AWB (Grand Knights History's `.awb` shape): a mini-CPK header @UTF table + an "ITOC" packet whose row's DataL/DataH blob columns are themselves nested @UTF tables of {ID, FileSize}. */
function buildItocAwb(dataL: { id: number; size: number }[], dataH: { id: number; size: number }[], contentOffset: number, align: number): Uint8Array {
  const subTable = (rows: { id: number; size: number }[]) =>
    buildUtf(
      [
        { name: 'ID', typ: 4 },
        { name: 'FileSize', typ: 4 },
      ],
      rows.map((r) => ({ ID: r.id, FileSize: r.size })),
    );

  const itocTable = buildUtf(
    [
      { name: 'DataL', typ: 0xb },
      { name: 'DataH', typ: 0xb },
    ],
    [{ DataL: subTable(dataL), DataH: subTable(dataH) }],
  );

  const headerTable = buildUtf(
    [
      { name: 'ContentOffset', typ: 4 },
      { name: 'ItocOffset', typ: 4 },
      { name: 'Align', typ: 4 },
    ],
    [{ ContentOffset: contentOffset, ItocOffset: 0, Align: align }],
  );

  const itocOffset = Math.ceil((0x10 + headerTable.length) / 16) * 16;
  // Re-encode the header now that itocOffset is known.
  const finalHeader = buildUtf(
    [
      { name: 'ContentOffset', typ: 4 },
      { name: 'ItocOffset', typ: 4 },
      { name: 'Align', typ: 4 },
    ],
    [{ ContentOffset: contentOffset, ItocOffset: itocOffset, Align: align }],
  );

  const total = itocOffset + 0x10 + itocTable.length;
  const buf = new Uint8Array(total);
  buf.set([0x43, 0x50, 0x4b, 0x20], 0); // "CPK "
  new DataView(buf.buffer).setBigUint64(8, BigInt(finalHeader.length), true);
  buf.set(finalHeader, 0x10);

  buf.set([0x49, 0x54, 0x4f, 0x43], itocOffset); // "ITOC"
  new DataView(buf.buffer).setBigUint64(itocOffset + 8, BigInt(itocTable.length), true);
  buf.set(itocTable, itocOffset + 0x10);

  return buf;
}

describe('awb — nested-CPK/ITOC', () => {
  it('parses DataL/DataH into entries sorted by id, laid out from contentOffset with align-rounded strides', () => {
    const buf = buildItocAwb(
      [{ id: 0, size: 1000 }, { id: 2, size: 1200 }],
      [{ id: 1, size: 1100 }],
      0x800,
      32,
    );
    const awb = parseItocAwb(buf);
    expect(awb).not.toBeNull();
    expect(awb!.format).toBe('itoc-cpk');
    expect(awb!.entries.map((e) => e.id)).toEqual([0, 1, 2]);
    // roundUp(1000, 32) = 1024, roundUp(1100, 32) = 1120
    expect(awb!.entries[0]).toEqual({ id: 0, offset: 0x800, size: 1000 });
    expect(awb!.entries[1]).toEqual({ id: 1, offset: 0x800 + 1024, size: 1100 });
    expect(awb!.entries[2]).toEqual({ id: 2, offset: 0x800 + 1024 + 1120, size: 1200 });
  });

  it('parseAfs2 rejects an ITOC (mini-CPK) buffer', () => {
    const buf = buildItocAwb([{ id: 0, size: 10 }], [], 0x800, 32);
    expect(parseAfs2(buf)).toBeNull();
  });
});

describe('awb — parseAwb (format auto-detect)', () => {
  it('tries AFS2 first, falls back to ITOC', () => {
    expect(parseAwb(buildAfs2([1], [0, 10]))?.format).toBe('afs2');
    expect(parseAwb(buildItocAwb([{ id: 0, size: 10 }], [], 0x800, 32))?.format).toBe('itoc-cpk');
  });

  it('returns null for neither shape', () => {
    expect(parseAwb(new Uint8Array(32))).toBeNull();
  });
});
