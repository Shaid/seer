import { describe, it, expect } from 'vitest';
import {
  findEocdOffset,
  readZipEocd,
  readZipCentralEntry,
  zipEntryPayloadStart,
  ZIP_EOCD_SIG,
  ZIP_CENTRAL_SIG,
  ZIP_LOCAL_SIG,
  ZIP_EOCD_BYTES,
  ZIP_CENTRAL_HEADER_BYTES,
  ZIP_LOCAL_HEADER_BYTES,
} from '../zip.js';

function u8(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function le32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function le16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}

/** A 22-byte EOCD with `count` entries and the given central-directory span. */
function eocd(count: number, cdSize: number, cdOffset: number, commentLen = 0): number[] {
  return [
    ...le32(ZIP_EOCD_SIG),
    ...le16(0), ...le16(0),          // disk numbers
    ...le16(count), ...le16(count),  // entries on this disk / total
    ...le32(cdSize), ...le32(cdOffset),
    ...le16(commentLen),
  ];
}

/** A 46-byte central-directory record followed by its name/extra/comment. */
function central(opts: {
  name: string; method: number; crc: number; csize: number; usize: number;
  localOffset: number; extraLen?: number; commentLen?: number;
}): number[] {
  const extraLen = opts.extraLen ?? 0;
  const commentLen = opts.commentLen ?? 0;
  const name = Array.from(opts.name, (c) => c.charCodeAt(0));
  return [
    ...le32(ZIP_CENTRAL_SIG),
    ...le16(20), ...le16(20), ...le16(0),   // versions, flags
    ...le16(opts.method),
    ...le16(0), ...le16(0),                 // time, date
    ...le32(opts.crc), ...le32(opts.csize), ...le32(opts.usize),
    ...le16(name.length), ...le16(extraLen), ...le16(commentLen),
    ...le16(0), ...le16(0), ...le32(0),     // disk start, attrs
    ...le32(opts.localOffset),
    ...name,
    ...new Array<number>(extraLen).fill(0xaa),
    ...new Array<number>(commentLen).fill(0xbb),
  ];
}

describe('findEocdOffset', () => {
  it('finds the EOCD at the very end of a comment-less archive', () => {
    const data = u8(...new Array(10).fill(0), ...eocd(1, 46, 0));
    expect(findEocdOffset(data)).toBe(10);
  });

  it('finds it behind a trailing comment (TorrentZip stamps a 22-byte one on every set)', () => {
    const comment = Array.from('TORRENTZIPPED-DEADBEEF', (c) => c.charCodeAt(0));
    const data = u8(...eocd(2, 92, 100, comment.length), ...comment);
    expect(findEocdOffset(data)).toBe(0);
  });

  it('scans backward, so a stray signature inside compressed data loses to the real one', () => {
    // The EOCD signature can occur by chance in a deflate stream; the LAST
    // occurrence is the record. A forward scan would return 4 here.
    const data = u8(0, 0, 0, 0, ...le32(ZIP_EOCD_SIG), ...new Array(30).fill(0), ...eocd(0, 0, 0));
    expect(findEocdOffset(data)).toBe(38);
  });

  it('returns -1 when there is no EOCD at all', () => {
    expect(findEocdOffset(new Uint8Array(64))).toBe(-1);
  });

  it('returns -1 for a buffer shorter than the record', () => {
    expect(findEocdOffset(u8(...le32(ZIP_EOCD_SIG)))).toBe(-1);
  });

  it('does not scan further back than maxCommentBytes allows', () => {
    const data = u8(...eocd(0, 0, 0), ...new Array(100).fill(0));
    expect(findEocdOffset(data, 100)).toBe(0);
    expect(findEocdOffset(data, 50)).toBe(-1);
  });
});

describe('readZipEocd', () => {
  it('reads the entry count and central-directory span, at an offset', () => {
    const data = u8(...new Array(7).fill(0xff), ...eocd(3, 0x1234, 0x5678));
    expect(readZipEocd(data, 7)).toEqual({ entryCount: 3, centralDirSize: 0x1234, centralDirOffset: 0x5678 });
  });
});

describe('readZipCentralEntry', () => {
  const rec = central({ name: 'rom/a.bin', method: 8, crc: 0xdeadbeef, csize: 11, usize: 22, localOffset: 0x40, extraLen: 3, commentLen: 5 });

  it('reads every fixed field and locates the name without decoding it', () => {
    const data = new Uint8Array(rec);
    const e = readZipCentralEntry(data, 0)!;
    expect(e.compressionMethod).toBe(8);
    expect(e.crc32).toBe(0xdeadbeef);
    expect(e.compressedSize).toBe(11);
    expect(e.uncompressedSize).toBe(22);
    expect(e.localHeaderOffset).toBe(0x40);
    expect(e.nameOffset).toBe(ZIP_CENTRAL_HEADER_BYTES);
    expect(e.nameLength).toBe('rom/a.bin'.length);
    // Name decoding is the caller's: core only hands back the byte range.
    expect(new TextDecoder().decode(data.subarray(e.nameOffset, e.nameOffset + e.nameLength))).toBe('rom/a.bin');
  });

  it('nextOffset steps over name, extra and comment', () => {
    const e = readZipCentralEntry(new Uint8Array(rec), 0)!;
    expect(e.nextOffset).toBe(ZIP_CENTRAL_HEADER_BYTES + 'rom/a.bin'.length + 3 + 5);
    expect(e.nextOffset).toBe(rec.length);
  });

  it('walks consecutive records', () => {
    const a = central({ name: 'a', method: 0, crc: 1, csize: 2, usize: 2, localOffset: 0 });
    const b = central({ name: 'bb', method: 8, crc: 2, csize: 3, usize: 4, localOffset: 50 });
    const data = new Uint8Array([...a, ...b]);
    const first = readZipCentralEntry(data, 0)!;
    const second = readZipCentralEntry(data, first.nextOffset)!;
    expect(first.nameLength).toBe(1);
    expect(second.nameLength).toBe(2);
    expect(second.localHeaderOffset).toBe(50);
    expect(readZipCentralEntry(data, second.nextOffset)).toBeNull();
  });

  it('returns null rather than throwing on a bad signature or a short buffer', () => {
    const bad = new Uint8Array(rec);
    bad[0] = 0x00;
    expect(readZipCentralEntry(bad, 0)).toBeNull();
    expect(readZipCentralEntry(new Uint8Array(ZIP_CENTRAL_HEADER_BYTES - 1), 0)).toBeNull();
    expect(readZipCentralEntry(new Uint8Array(rec), -4)).toBeNull();
  });
});

describe('zipEntryPayloadStart', () => {
  /** A 30-byte local header whose own name/extra lengths are what counts. */
  function local(nameLen: number, extraLen: number): number[] {
    return [
      ...le32(ZIP_LOCAL_SIG),
      ...le16(20), ...le16(0), ...le16(8),
      ...le16(0), ...le16(0),
      ...le32(0), ...le32(0), ...le32(0),
      ...le16(nameLen), ...le16(extraLen),
    ];
  }

  it('adds the local header size plus its OWN name and extra lengths', () => {
    const header = new Uint8Array(local(9, 7));
    expect(zipEntryPayloadStart(header, 0x100)).toBe(0x100 + ZIP_LOCAL_HEADER_BYTES + 9 + 7);
  });

  it('reads the header in place when given the whole archive', () => {
    const data = new Uint8Array([...new Array(0x40).fill(0), ...local(4, 0)]);
    expect(zipEntryPayloadStart(data, 0x40, 0x40)).toBe(0x40 + ZIP_LOCAL_HEADER_BYTES + 4);
  });

  it('returns -1 on a bad signature or a truncated header', () => {
    const bad = new Uint8Array(local(4, 0));
    bad[3] = 0x00;
    expect(zipEntryPayloadStart(bad, 0)).toBe(-1);
    expect(zipEntryPayloadStart(new Uint8Array(ZIP_LOCAL_HEADER_BYTES - 1), 0)).toBe(-1);
  });
});

describe('record sizes match the PKZIP spec', () => {
  it('EOCD 22, central 46, local 30', () => {
    expect([ZIP_EOCD_BYTES, ZIP_CENTRAL_HEADER_BYTES, ZIP_LOCAL_HEADER_BYTES]).toEqual([22, 46, 30]);
  });
});
