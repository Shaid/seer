import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findContainerFile, resolveRomfsLayout, type ByteSource } from '../container.js';

const TMP = join(import.meta.dirname, '__tmp_3ds_container__');

describe('findContainerFile', () => {
  beforeAll(() => {
    mkdirSync(join(TMP, 'nested'), { recursive: true });
    writeFileSync(join(TMP, 'update.cia'), '');
    writeFileSync(join(TMP, 'nested', 'game.3ds'), '');
    writeFileSync(join(TMP, 'nested', 'other.cxi'), '');
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  it('prefers a .3ds cart dump over a .cxi/.cia digital image, searching subdirectories', () => {
    expect(findContainerFile(TMP)).toBe(join(TMP, 'nested', 'game.3ds'));
  });

  it('returns undefined when nothing matches', () => {
    const empty = join(TMP, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(findContainerFile(empty)).toBeUndefined();
  });
});

describe('resolveRomfsLayout', () => {
  it('locates the Lv3 header past the IVFC master hash table, rounded to the block size', () => {
    const ivfcOffset = 0x1000;
    const masterHashSize = 0x20;
    const lv3BlockSizeLog = 12; // 2^12 = 0x1000
    const superblock = new Uint8Array(0x60);
    const view = new DataView(superblock.buffer);
    view.setUint32(8, masterHashSize, true);
    view.setUint32(0x4c, lv3BlockSizeLog, true);

    // dataOffset = ivfcOffset + roundUp(0x60 + 0x20, 0x1000) = ivfcOffset + 0x1000
    const expectedDataOffset = ivfcOffset + 0x1000;
    const lv3Header = new Uint8Array(0x28);
    const lv3View = new DataView(lv3Header.buffer);
    lv3View.setUint32(12, 0x10, true); // dirMetaOffset
    lv3View.setUint32(16, 0x20, true); // dirMetaSize
    lv3View.setUint32(28, 0x30, true); // fileMetaOffset
    lv3View.setUint32(32, 0x40, true); // fileMetaSize
    lv3View.setUint32(36, 0x50, true); // fileDataOffset

    const source: ByteSource = {
      async readAt(offset: number, length: number): Promise<Uint8Array> {
        expect(offset).toBe(expectedDataOffset);
        expect(length).toBe(0x28);
        return lv3Header;
      },
    };

    return resolveRomfsLayout(source, ivfcOffset, superblock).then((layout) => {
      expect(layout.dataOffset).toBe(expectedDataOffset);
      expect(layout.lv3).toEqual({
        dirMetaOffset: 0x10,
        dirMetaSize: 0x20,
        fileMetaOffset: 0x30,
        fileMetaSize: 0x40,
        fileDataOffset: 0x50,
      });
    });
  });

  it('throws on a truncated superblock', async () => {
    const source: ByteSource = { readAt: async () => new Uint8Array(0) };
    await expect(resolveRomfsLayout(source, 0, new Uint8Array(0x10))).rejects.toThrow(/Truncated IVFC/);
  });
});
