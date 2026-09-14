import { describe, it, expect } from 'vitest';
import {
  decryptUtf,
  utfPacket,
  parseUtf,
  readUtfRow,
  subUtfTable,
  readCpkHeader,
  readCpkFileTable,
  parseCpkTocPacket,
  decompressCrilayla,
} from '../cpk.js';
import { buildUtf } from './utf-builder.js';

function ascii4(buf: Uint8Array, offset = 0): string {
  return String.fromCharCode(buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!);
}

describe('decryptUtf / utfPacket', () => {
  it('is self-inverse (XOR keystream): decrypting twice restores the original bytes', () => {
    const plain = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 0, 128, 255]);
    const enc = decryptUtf(plain);
    expect(enc).not.toEqual(plain);
    const dec = decryptUtf(enc);
    expect(dec).toEqual(plain);
  });

  it('utfPacket leaves an already-plaintext @UTF packet untouched', () => {
    const table = buildUtf([{ name: 'X', typ: 4 }], [{ X: 1 }]);
    expect(ascii4(table)).toBe('@UTF');
    expect(utfPacket(table)).toEqual(table);
  });

  it('utfPacket decrypts a DecryptUTF-encrypted packet back to a valid @UTF stream', () => {
    const table = buildUtf([{ name: 'X', typ: 4 }], [{ X: 42 }]);
    const encrypted = decryptUtf(table);
    expect(ascii4(encrypted)).not.toBe('@UTF');
    const out = utfPacket(encrypted);
    expect(out).toEqual(table);
  });
});

describe('parseUtf / readUtfRow', () => {
  it('decodes row-storage columns of every supported type', () => {
    const table = buildUtf(
      [
        { name: 'Name', typ: 0xa },
        { name: 'Flag', typ: 0 },
        { name: 'Count', typ: 4 },
        { name: 'Big', typ: 6 },
        { name: 'Ratio', typ: 8 },
      ],
      [
        { Name: 'first', Flag: 1, Count: 100, Big: 9_000_000_000n, Ratio: 0.5 },
        { Name: 'second', Flag: 0, Count: 200, Big: 1n, Ratio: -1.25 },
      ],
    );
    const utf = parseUtf(table);
    expect(utf.numRows).toBe(2);
    expect(utf.columns.map((c) => c.name)).toEqual(['Name', 'Flag', 'Count', 'Big', 'Ratio']);

    const row0 = readUtfRow(utf, 0);
    expect(row0['Name']).toBe('first');
    expect(row0['Flag']).toBe(1);
    expect(row0['Count']).toBe(100);
    expect(row0['Big']).toBe(9_000_000_000n);
    expect(row0['Ratio']).toBe(0.5);

    const row1 = readUtfRow(utf, 1);
    expect(row1['Name']).toBe('second');
    expect(row1['Count']).toBe(200);
    expect(row1['Big']).toBe(1n);
    expect(row1['Ratio']).toBe(-1.25);
  });

  it('constant-storage (0x30) columns report the same value for every row and consume no row bytes', () => {
    const table = buildUtf(
      [
        { name: 'Id', typ: 4 },
        { name: 'Worksize', typ: 2, storage: 'const', constantValue: 7 },
        { name: 'UserData', typ: 0xa, storage: 'const', constantValue: '' },
      ],
      [{ Id: 0 }, { Id: 1 }, { Id: 2 }],
    );
    const utf = parseUtf(table);
    expect(utf.numRows).toBe(3);
    const worksizeCol = utf.columns.find((c) => c.name === 'Worksize')!;
    expect(worksizeCol.constantValue).toBe(7);
    for (let i = 0; i < 3; i++) {
      const row = readUtfRow(utf, i);
      expect(row['Id']).toBe(i);
      expect(row['Worksize']).toBe(7);
      expect(row['UserData']).toBe('');
    }
  });

  it('throws for a buffer without the @UTF magic', () => {
    expect(() => parseUtf(new Uint8Array(32))).toThrow(/Not an @UTF table/);
  });
});

describe('subUtfTable', () => {
  it('resolves a data-blob (0xb) column into its own nested @UTF table', () => {
    const inner = buildUtf([{ name: 'Value', typ: 4 }], [{ Value: 111 }, { Value: 222 }]);
    const outer = buildUtf([{ name: 'Nested', typ: 0xb }], [{ Nested: inner }]);
    const utf = parseUtf(outer);
    const row = readUtfRow(utf, 0);
    const sub = subUtfTable(utf, row['Nested']);
    expect(sub).not.toBeNull();
    expect(sub!.numRows).toBe(2);
    expect(readUtfRow(sub!, 0)['Value']).toBe(111);
    expect(readUtfRow(sub!, 1)['Value']).toBe(222);
  });

  it('returns null for a non-blob column value', () => {
    const outer = buildUtf([{ name: 'X', typ: 4 }], [{ X: 5 }]);
    const utf = parseUtf(outer);
    expect(subUtfTable(utf, readUtfRow(utf, 0)['X'])).toBeNull();
  });
});

/** Assemble a minimal synthetic CPK container: header @UTF packet (DecryptUTF-encrypted, like Dragon's Crown), then a "TOC " packet (left plaintext, like Grand Knights History) at a chosen offset. */
function buildSyntheticCpk(): { bytes: Uint8Array; tocOffset: number; contentOffset: number } {
  const headerTable = buildUtf(
    [
      { name: 'ContentOffset', typ: 4 },
      { name: 'TocOffset', typ: 4 },
      { name: 'Files', typ: 4 },
      { name: 'Align', typ: 4 },
      { name: 'Version', typ: 4 },
      { name: 'Revision', typ: 4 },
      { name: 'Tvers', typ: 0xa },
    ],
    [{ ContentOffset: 0x800, TocOffset: 0x200, Files: 2, Align: 32, Version: 7, Revision: 2, Tvers: 'CPKMC2.42.00' }],
  );
  const encryptedHeader = decryptUtf(headerTable);

  const tocTable = buildUtf(
    [
      { name: 'DirName', typ: 0xa },
      { name: 'FileName', typ: 0xa },
      { name: 'FileSize', typ: 4 },
      { name: 'ExtractSize', typ: 4 },
      { name: 'FileOffset', typ: 4 },
      { name: 'ID', typ: 4 },
    ],
    [
      { DirName: 'stage', FileName: 'a.tex', FileSize: 100, ExtractSize: 312, FileOffset: 0, ID: 0 },
      { DirName: 'stage', FileName: 'b.tex', FileSize: 50, ExtractSize: 50, FileOffset: 100, ID: 1 },
    ],
  );

  const tocOffset = 0x200;
  const bytes = new Uint8Array(tocOffset + 16 + tocTable.length);
  bytes.set([0x43, 0x50, 0x4b, 0x20], 0); // "CPK "
  new DataView(bytes.buffer).setUint32(4, 0xff, false); // unk1, value irrelevant
  new DataView(bytes.buffer).setBigUint64(8, BigInt(encryptedHeader.length), true);
  bytes.set(encryptedHeader, 0x10);

  bytes.set([0x54, 0x4f, 0x43, 0x20], tocOffset); // "TOC "
  new DataView(bytes.buffer).setBigUint64(tocOffset + 8, BigInt(tocTable.length), true);
  bytes.set(tocTable, tocOffset + 16);

  return { bytes, tocOffset, contentOffset: 0x800 };
}

describe('readCpkHeader / readCpkFileTable', () => {
  it('decrypts and decodes the header row', () => {
    const { bytes } = buildSyntheticCpk();
    const header = readCpkHeader(bytes);
    expect(header.contentOffset).toBe(0x800);
    expect(header.tocOffset).toBe(0x200);
    expect(header.files).toBe(2);
    expect(header.align).toBe(32);
    expect(header.version).toBe(7);
    expect(header.revision).toBe(2);
    expect(header.tvers).toBe('CPKMC2.42.00');
  });

  it('rejects a buffer without the CPK magic', () => {
    expect(() => readCpkHeader(new Uint8Array(32))).toThrow(/Not a CPK file/);
  });

  it('reads the (plaintext) TOC and applies the min(ContentOffset,TocOffset) addOffset', () => {
    const { bytes } = buildSyntheticCpk();
    const header = readCpkHeader(bytes);
    const { entries } = readCpkFileTable(bytes, header);
    expect(entries.length).toBe(2);
    // addOffset = min(contentOffset=0x800, tocOffset=0x200) = 0x200
    expect(entries[0]).toEqual({ dirName: 'stage', fileName: 'a.tex', fileSize: 100, extractSize: 312, fileOffset: 0x200 + 0, id: 0 });
    expect(entries[1]).toEqual({ dirName: 'stage', fileName: 'b.tex', fileSize: 50, extractSize: 50, fileOffset: 0x200 + 100, id: 1 });
  });

  it('rejects a TOC region missing the "TOC " magic', () => {
    const { bytes } = buildSyntheticCpk();
    const header = readCpkHeader(bytes);
    const corrupted = new Uint8Array(bytes);
    corrupted[header.tocOffset] = 0;
    expect(() => readCpkFileTable(corrupted, header)).toThrow(/Missing TOC magic/);
  });
});

describe('parseCpkTocPacket', () => {
  it('parses a raw TOC packet directly, given an explicit addOffset', () => {
    const tocTable = buildUtf(
      [
        { name: 'DirName', typ: 0xa },
        { name: 'FileName', typ: 0xa },
        { name: 'FileSize', typ: 4 },
        { name: 'ExtractSize', typ: 4 },
        { name: 'FileOffset', typ: 4 },
        { name: 'ID', typ: 4 },
      ],
      [{ DirName: 'snd', FileName: 'bgm.acb', FileSize: 10, ExtractSize: 10, FileOffset: 5, ID: 9 }],
    );
    const entries = parseCpkTocPacket(tocTable, 1000);
    expect(entries).toEqual([{ dirName: 'snd', fileName: 'bgm.acb', fileSize: 10, extractSize: 10, fileOffset: 1005, id: 9 }]);
  });
});

/**
 * Encode a synthetic all-literal CRILAYLA stream (no back-references) —
 * enough to exercise the Buffer->DataView port's bit-reader and byte
 * layout without needing to reproduce the back-reference path by hand.
 * See decompressCrilayla's own doc comment for the bit-stream shape this
 * mirrors in reverse.
 */
function encodeCrilaylaLiteral(outputBytes: Uint8Array): Uint8Array {
  const bits: number[] = [];
  for (let i = outputBytes.length - 1; i >= 0; i--) {
    bits.push(0); // "literal" flag
    const v = outputBytes[i]!;
    for (let b = 7; b >= 0; b--) bits.push((v >> b) & 1);
  }
  const packed: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    packed.push(byte);
  }
  const K = packed.length;
  const total = 0x210 + K; // headerOffset=0 (context source [0x10,0x110)) + bitstream region [0x110, 0x110+K)
  const buf = new Uint8Array(total);
  buf.set([0x43, 0x52, 0x49, 0x4c, 0x41, 0x59, 0x4c, 0x41], 0); // "CRILAYLA"
  const view = new DataView(buf.buffer);
  view.setUint32(8, outputBytes.length, true); // uncompressedSize
  view.setUint32(12, 0, true); // headerOffset

  const inputEnd = total - 0x100 - 1;
  for (let j = 0; j < K; j++) buf[inputEnd - j] = packed[j]!;
  return buf;
}

describe('decompressCrilayla', () => {
  it('decompresses a synthetic all-literal stream byte-exact', () => {
    const expected = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    const compressed = encodeCrilaylaLiteral(expected);
    const out = decompressCrilayla(compressed);
    expect(out.length).toBe(expected.length + 0x100);
    expect(out.subarray(0x100, 0x100 + expected.length)).toEqual(expected);
  });

  it('decompresses a single-byte stream', () => {
    const expected = new Uint8Array([0x7f]);
    const compressed = encodeCrilaylaLiteral(expected);
    const out = decompressCrilayla(compressed);
    expect(out.subarray(0x100, 0x101)).toEqual(expected);
  });
});
