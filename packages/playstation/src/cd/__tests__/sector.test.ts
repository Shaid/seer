import { describe, it, expect } from 'vitest';
import {
  RAW_SECTOR_SIZE,
  SYNC_PATTERN,
  HEADER_SIZE,
  USER_DATA_OFFSET,
  FORM1_USER_SIZE,
  SUBMODE_VIDEO,
  bcdEncode,
  bcdDecode,
  msfStringToSectors,
  sectorsToMsfString,
  lbaToAbsolute,
  absoluteToLba,
  hasSyncPattern,
  writeRawSectorHeader,
  writeCdxaSubheader,
  readCdxaSubheader,
  isForm2Submode,
  RawCdReader,
  PlainSectorReader,
} from '../sector.js';

describe('BCD/MSF/LBA conversions', () => {
  it('round-trips BCD encode/decode', () => {
    expect(bcdEncode(0)).toBe(0x00);
    expect(bcdEncode(59)).toBe(0x59);
    expect(bcdDecode(bcdEncode(37))).toBe(37);
  });

  it('converts MM:SS:FF to sectors at 75 frames per second', () => {
    expect(msfStringToSectors('00:00:00')).toBe(0);
    expect(msfStringToSectors('00:00:01')).toBe(1);
    expect(msfStringToSectors('00:01:00')).toBe(75);
    expect(msfStringToSectors('01:00:00')).toBe(4500);
    expect(msfStringToSectors('01:57:50')).toBe(8825);
  });

  it('round-trips through sectorsToMsfString', () => {
    for (const msf of ['00:00:00', '01:57:50', '52:53:45', '10:33:74']) {
      expect(sectorsToMsfString(msfStringToSectors(msf))).toBe(msf);
    }
  });

  it('rejects malformed and out-of-range timecodes', () => {
    expect(() => msfStringToSectors('1:2')).toThrow(/Malformed/);
    expect(() => msfStringToSectors('00:60:00')).toThrow(/seconds out of range/);
    expect(() => msfStringToSectors('00:00:75')).toThrow(/frames out of range/);
  });

  it('separates LBA from absolute Red Book time by the 150-sector lead-in', () => {
    expect(lbaToAbsolute(0)).toBe(150);
    expect(absoluteToLba(150)).toBe(0);
    expect(absoluteToLba(lbaToAbsolute(12345))).toBe(12345);
  });
});

describe('hasSyncPattern', () => {
  it('detects the sync pattern and its absence', () => {
    const buf = new Uint8Array(24);
    buf.set(SYNC_PATTERN, 0);
    expect(hasSyncPattern(buf, 0)).toBe(true);
    expect(hasSyncPattern(new Uint8Array(24), 0)).toBe(false);
    expect(hasSyncPattern(buf, 20)).toBe(false); // too short from this offset
  });
});

describe('writeRawSectorHeader / writeCdxaSubheader / readCdxaSubheader', () => {
  it('writes a full raw sector header + subheader that round-trips', () => {
    const out = new Uint8Array(RAW_SECTOR_SIZE);
    writeRawSectorHeader(out, 0, 150, 2);
    expect(Array.from(out.subarray(0, 12))).toEqual(Array.from(SYNC_PATTERN));
    expect(out[15]).toBe(2); // mode

    writeCdxaSubheader(out, HEADER_SIZE, { fileNumber: 1, channel: 2, submode: SUBMODE_VIDEO, codingInfo: 0 });
    const sub = readCdxaSubheader(out, HEADER_SIZE);
    expect(sub).toEqual({ fileNumber: 1, channel: 2, submode: SUBMODE_VIDEO, codingInfo: 0 });
    // duplicate copy at +4
    expect(Array.from(out.subarray(HEADER_SIZE + 4, HEADER_SIZE + 8))).toEqual([1, 2, SUBMODE_VIDEO, 0]);
    expect(isForm2Submode(sub.submode)).toBe(false);
  });
});

describe('RawCdReader', () => {
  function buildImage(sectors: number, fill: (sectorIndex: number) => number): Uint8Array {
    const img = new Uint8Array(sectors * RAW_SECTOR_SIZE);
    for (let s = 0; s < sectors; s++) {
      const base = s * RAW_SECTOR_SIZE;
      img.set(SYNC_PATTERN, base);
      img[base + 15] = 2; // MODE2
      writeCdxaSubheader(img, base + HEADER_SIZE, { fileNumber: 0, channel: 0, submode: 0, codingInfo: 0 });
      img.fill(fill(s), base + USER_DATA_OFFSET, base + RAW_SECTOR_SIZE);
    }
    return img;
  }

  it('reads Form1 logical data spanning multiple sectors', () => {
    const img = buildImage(3, (s) => s + 1);
    const reader = new RawCdReader((offset, length) => img.subarray(offset, offset + length));
    const data = reader.readLogical(0, FORM1_USER_SIZE * 3);
    expect(data.length).toBe(FORM1_USER_SIZE * 3);
    expect(data[0]).toBe(1);
    expect(data[FORM1_USER_SIZE]).toBe(2);
    expect(data[FORM1_USER_SIZE * 2]).toBe(3);
  });

  it('detects Form2 via the submode flag', () => {
    const img = buildImage(1, () => 0);
    writeCdxaSubheader(img, HEADER_SIZE, { fileNumber: 0, channel: 0, submode: 0x20, codingInfo: 0 });
    const reader = new RawCdReader((offset, length) => img.subarray(offset, offset + length));
    expect(reader.isForm2(0)).toBe(true);
  });

  it('chunks large logical reads', () => {
    const img = buildImage(5, (s) => s);
    const reader = new RawCdReader((offset, length) => img.subarray(offset, offset + length));
    const chunks = Array.from(reader.readLogicalChunks(0, FORM1_USER_SIZE * 5, 2));
    expect(chunks.map((c) => c.data.length)).toEqual([FORM1_USER_SIZE * 2, FORM1_USER_SIZE * 2, FORM1_USER_SIZE]);
    expect(chunks[1]!.offset).toBe(FORM1_USER_SIZE * 2);
  });
});

describe('PlainSectorReader', () => {
  it('reads at lba * sectorSize with no raw-sector layer', () => {
    const img = new Uint8Array(2048 * 3);
    img[2048] = 0x42;
    const reader = new PlainSectorReader((offset, length) => img.subarray(offset, offset + length), 2048);
    const data = reader.readLogical(1, 4);
    expect(data[0]).toBe(0x42);
  });
});
