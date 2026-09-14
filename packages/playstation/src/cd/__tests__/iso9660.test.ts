import { describe, it, expect } from 'vitest';
import { PlainSectorReader } from '../sector.js';
import { parsePvd, walk, listFiles, findPath } from '../iso9660.js';

const SECTOR = 2048;

/** Write one ISO9660 directory record (self/parent or a named entry) at `pos` in `data`, returning the record length. */
function writeDirRecord(
  data: Uint8Array,
  pos: number,
  opts: { extentLba: number; dataLen: number; isDir: boolean; name: number[] | string },
): number {
  const nameBytes = typeof opts.name === 'string' ? Array.from(opts.name, (c) => c.charCodeAt(0)) : opts.name;
  const nameLen = nameBytes.length;
  const recLen = 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  data[pos] = recLen;
  view.setUint32(pos + 2, opts.extentLba, true);
  view.setUint32(pos + 6, opts.extentLba, false);
  view.setUint32(pos + 10, opts.dataLen, true);
  view.setUint32(pos + 14, opts.dataLen, false);
  data[pos + 25] = opts.isDir ? 0x02 : 0x00;
  data[pos + 32] = nameLen;
  for (let i = 0; i < nameLen; i++) data[pos + 33 + i] = nameBytes[i]!;
  return recLen;
}

/** Build a minimal synthetic ISO9660 image: PVD at LBA 16, a root directory
 * extent at LBA 17 (self/parent + one file record), and the file's own data
 * at LBA 18. */
function buildMinimalIso(fileContent: string): Uint8Array {
  const totalSectors = 20;
  const data = new Uint8Array(totalSectors * SECTOR);
  const view = new DataView(data.buffer);

  // PVD at LBA 16.
  const pvdOff = 16 * SECTOR;
  data[pvdOff] = 1; // type: Primary Volume Descriptor
  data.set(Array.from('CD001', (c) => c.charCodeAt(0)), pvdOff + 1);
  data[pvdOff + 6] = 1; // version
  const systemId = 'PLAYSTATION'.padEnd(32, ' ');
  const volumeId = 'TESTVOL'.padEnd(32, ' ');
  data.set(Array.from(systemId, (c) => c.charCodeAt(0)), pvdOff + 8);
  data.set(Array.from(volumeId, (c) => c.charCodeAt(0)), pvdOff + 40);
  view.setUint32(pvdOff + 80, totalSectors, true);
  view.setUint16(pvdOff + 128, SECTOR, true);
  // Root directory record embedded in the PVD at +156.
  writeDirRecord(data, pvdOff + 156, { extentLba: 17, dataLen: SECTOR, isDir: true, name: [0] });

  // Root directory extent at LBA 17: "." , "..", then one file.
  const rootOff = 17 * SECTOR;
  let p = rootOff;
  p += writeDirRecord(data, p, { extentLba: 17, dataLen: SECTOR, isDir: true, name: [0] });
  p += writeDirRecord(data, p, { extentLba: 17, dataLen: SECTOR, isDir: true, name: [1] });
  writeDirRecord(data, p, { extentLba: 18, dataLen: fileContent.length, isDir: false, name: 'HELLO.TXT;1' });

  // File content at LBA 18.
  data.set(Array.from(fileContent, (c) => c.charCodeAt(0)), 18 * SECTOR);

  return data;
}

function readerFor(data: Uint8Array): PlainSectorReader {
  return new PlainSectorReader((offset, length) => data.subarray(offset, offset + length), SECTOR);
}

describe('parsePvd', () => {
  it('reads the standard identifier, ids, and root extent', () => {
    const disc = readerFor(buildMinimalIso('hi'));
    const pvd = parsePvd(disc);
    expect(pvd.systemId).toBe('PLAYSTATION');
    expect(pvd.volumeId).toBe('TESTVOL');
    expect(pvd.logicalBlockSize).toBe(SECTOR);
    expect(pvd.rootExtentLba).toBe(17);
  });

  it('throws on a bad standard identifier', () => {
    const data = buildMinimalIso('hi');
    data.set(Array.from('XXXXX', (c) => c.charCodeAt(0)), 16 * SECTOR + 1);
    expect(() => parsePvd(readerFor(data))).toThrow(/bad PVD id/);
  });
});

describe('walk / listFiles / findPath', () => {
  it('walks the root directory, skipping self/parent records', () => {
    const disc = readerFor(buildMinimalIso('hello world'));
    const pvd = parsePvd(disc);
    const entries = walk(disc, pvd.rootExtentLba, pvd.rootExtentLen);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('HELLO.TXT');
    expect(entries[0]!.path).toBe('/HELLO.TXT');
    expect(entries[0]!.isDir).toBe(false);
    expect(entries[0]!.dataLen).toBe('hello world'.length);
  });

  it('strips the ";1" version suffix from filenames', () => {
    const disc = readerFor(buildMinimalIso('x'));
    const { entries } = listFiles(disc);
    expect(entries.map((e) => e.name)).toEqual(['HELLO.TXT']);
  });

  it('finds a file by path, with or without a leading slash', () => {
    const disc = readerFor(buildMinimalIso('x'));
    expect(findPath(disc, 'HELLO.TXT')?.extentLba).toBe(18);
    expect(findPath(disc, '/HELLO.TXT')?.extentLba).toBe(18);
    expect(findPath(disc, 'NOPE.TXT')).toBeUndefined();
  });
});
