import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_SECTOR_SIZE, SYNC_PATTERN, FORM1_USER_SIZE, HEADER_SIZE, writeCdxaSubheader, SUBMODE_VIDEO } from '../cd/sector.js';
import { listFiles } from '../cd/iso9660.js';
import { findTrack } from '../cd/cue-sheet.js';
import { openRawCdImage, loadCue, readTrackSectors, readCookedDataTrack } from '../node.js';

const TMP = join(import.meta.dirname, '__tmp_playstation_node__');

describe('openRawCdImage', () => {
  const discPath = join(TMP, 'disc.bin');

  beforeAll(() => {
    mkdirSync(TMP, { recursive: true });
    // One MODE2/CD-XA sector (LBA 0, unused) + a minimal ISO9660 PVD (LBA 16)
    // + root directory extent (LBA 17), so listFiles() has something to walk.
    const totalSectors = 18;
    const img = new Uint8Array(totalSectors * RAW_SECTOR_SIZE);
    for (let s = 0; s < totalSectors; s++) {
      const base = s * RAW_SECTOR_SIZE;
      img.set(SYNC_PATTERN, base);
      img[base + 15] = 2;
      writeCdxaSubheader(img, base + HEADER_SIZE, { fileNumber: 0, channel: 0, submode: SUBMODE_VIDEO, codingInfo: 0 });
    }
    const userDataOffset = (lba: number) => lba * RAW_SECTOR_SIZE + HEADER_SIZE + 8;
    const pvd = userDataOffset(16);
    const view = new DataView(img.buffer);
    img[pvd] = 1;
    img.set(Array.from('CD001', (c) => c.charCodeAt(0)), pvd + 1);
    view.setUint32(pvd + 80, totalSectors, true);
    view.setUint16(pvd + 128, FORM1_USER_SIZE, true);
    // Root dir record embedded in the PVD: extent LBA 17, one 2048-byte sector.
    view.setUint32(pvd + 156 + 2, 17, true);
    view.setUint32(pvd + 156 + 10, FORM1_USER_SIZE, true);
    img[pvd + 156] = 34; // recLen
    img[pvd + 156 + 32] = 1; // nameLen
    img[pvd + 156 + 33] = 0; // name byte 0x00 -> self record

    // Root directory extent at LBA 17: "." + ".." + one file record.
    const rootBase = userDataOffset(17);
    let p = rootBase;
    const writeRec = (extentLba: number, dataLen: number, name: number[]) => {
      const recLen = 33 + name.length;
      img[p] = recLen;
      view.setUint32(p + 2, extentLba, true);
      view.setUint32(p + 10, dataLen, true);
      img[p + 25] = 0x00;
      img[p + 32] = name.length;
      for (let i = 0; i < name.length; i++) img[p + 33 + i] = name[i]!;
      p += recLen;
    };
    writeRec(17, FORM1_USER_SIZE, [0]);
    writeRec(17, FORM1_USER_SIZE, [1]);
    writeRec(0, 4, Array.from('A.TXT', (c) => c.charCodeAt(0)));

    writeFileSync(discPath, Buffer.from(img));
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  it('opens a real file and walks its ISO9660 tree', () => {
    const { reader, size, numSectors, close } = openRawCdImage(discPath);
    try {
      expect(numSectors).toBe(18);
      expect(size).toBe(18 * RAW_SECTOR_SIZE);
      const { pvd, entries } = listFiles(reader);
      expect(pvd.rootExtentLba).toBe(17);
      expect(entries.map((e) => e.name)).toEqual(['A.TXT']);
    } finally {
      close();
    }
  });
});

describe('loadCue / readTrackSectors / readCookedDataTrack', () => {
  const DATA_SECTORS = 2;

  beforeAll(() => {
    mkdirSync(TMP, { recursive: true });
    const bin = new Uint8Array(DATA_SECTORS * RAW_SECTOR_SIZE);
    for (let s = 0; s < DATA_SECTORS; s++) {
      const base = s * RAW_SECTOR_SIZE;
      bin.set(SYNC_PATTERN, base);
      bin.fill((s + 1) & 0xff, base + HEADER_SIZE, base + HEADER_SIZE + FORM1_USER_SIZE);
    }
    writeFileSync(join(TMP, 'mini.bin'), Buffer.from(bin));
    writeFileSync(join(TMP, 'mini.cue'), 'FILE "mini.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  it('resolves the FILE reference relative to the cue and reads its size', () => {
    const cue = loadCue(join(TMP, 'mini.cue'));
    expect(cue.binPath).toBe(join(TMP, 'mini.bin'));
    expect(cue.binSize).toBe(DATA_SECTORS * RAW_SECTOR_SIZE);
    expect(findTrack(cue, 1).number).toBe(1);
    expect(() => findTrack(cue, 9)).toThrow(/not present/);
  });

  it('reads a byte range of a track directly off disk', () => {
    const cue = loadCue(join(TMP, 'mini.cue'));
    const track = findTrack(cue, 1);
    const sector1 = readTrackSectors(cue, track, 1, 1);
    expect(sector1.length).toBe(RAW_SECTOR_SIZE);
    expect(sector1[HEADER_SIZE]).toBe(2);
  });

  it('reads and cooks a whole data track off disk', () => {
    const cue = loadCue(join(TMP, 'mini.cue'));
    const cooked = readCookedDataTrack(cue, 1);
    expect(cooked.length).toBe(DATA_SECTORS * FORM1_USER_SIZE);
    expect(cooked[0]).toBe(1);
    expect(cooked[FORM1_USER_SIZE]).toBe(2);
  });
});
