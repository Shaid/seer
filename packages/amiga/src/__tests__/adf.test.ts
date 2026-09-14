import { describe, it, expect } from 'vitest';
import { adfBootblockType, isAdfSize, listAdf, readAdfFile } from '../adf.js';

/**
 * Minimal OFS/FFS image builder — test-local (the package is read-only
 * by design). Builds a structurally valid DD ADF: bootblock, root block,
 * file/dir header blocks with reverse-order data tables, OFS data-block
 * headers. Checksums are left zero; the reader doesn't verify them.
 */
const BLOCK = 512;
const HT = 72;

function w32(img: Uint8Array, off: number, v: number) {
  img[off] = (v >>> 24) & 0xff;
  img[off + 1] = (v >>> 16) & 0xff;
  img[off + 2] = (v >>> 8) & 0xff;
  img[off + 3] = v & 0xff;
}

function writeName(img: Uint8Array, blockStart: number, name: string) {
  img[blockStart + 0x1b0] = name.length;
  for (let i = 0; i < name.length; i++) img[blockStart + 0x1b1 + i] = name.charCodeAt(i);
}

interface Spec {
  path: string;
  content: Uint8Array;
}

function buildAdf(files: Spec[], ffs: boolean): Uint8Array {
  const img = new Uint8Array(901120);
  img.set([0x44, 0x4f, 0x53, ffs ? 1 : 0]); // 'DOS\0' / 'DOS\1'
  const root = 880;
  w32(img, root * BLOCK, 2); // T_HEADER
  w32(img, root * BLOCK + BLOCK - 4, 1); // ST_ROOT
  writeName(img, root * BLOCK, 'TestDisk');

  let nextFree = 881;
  const alloc = () => nextFree++;
  const dirBlocks = new Map<string, number>([['', root]]);
  const slotOf = new Map<number, number>(); // dirBlock -> next hash slot

  const hashInsert = (dirBlock: number, headerBlock: number) => {
    const slot = slotOf.get(dirBlock) ?? 0;
    slotOf.set(dirBlock, slot + 1);
    w32(img, dirBlock * BLOCK + 24 + slot * 4, headerBlock);
  };

  const ensureDir = (path: string): number => {
    if (dirBlocks.has(path)) return dirBlocks.get(path)!;
    const parent = ensureDir(path.split('/').slice(0, -1).join('/'));
    const block = alloc();
    w32(img, block * BLOCK, 2);
    w32(img, block * BLOCK + BLOCK - 4, 2); // ST_USERDIR
    writeName(img, block * BLOCK, path.split('/').pop()!);
    hashInsert(parent, block);
    dirBlocks.set(path, block);
    return block;
  };

  for (const f of files) {
    const dir = ensureDir(f.path.split('/').slice(0, -1).join('/'));
    const header = alloc();
    const chunkSize = ffs ? BLOCK : BLOCK - 24;
    const nBlocks = Math.ceil(f.content.length / chunkSize);
    w32(img, header * BLOCK, 2); // T_HEADER
    w32(img, header * BLOCK + BLOCK - 47 * 4, f.content.length); // byte_size
    w32(img, header * BLOCK + BLOCK - 4, -3 >>> 0); // ST_FILE
    writeName(img, header * BLOCK, f.path.split('/').pop()!);

    // Data-block pointers live in the header block's own 72-entry table;
    // once a file needs more than that, chain through T_LIST ("file
    // extension") blocks — each with its own 72-entry table and its own
    // "next extension block" pointer at the same block-end offset. Assign
    // pointers to blocks up front so each block's high_seq (its own valid
    // entry count) is known before any field is written.
    const chainBlocks: number[] = [header];
    while (chainBlocks.length * HT < nBlocks) {
      const ext = alloc();
      w32(img, ext * BLOCK, 16); // T_LIST — extension blocks are NOT T_HEADER
      w32(img, ext * BLOCK + BLOCK - 4, -3 >>> 0); // ST_FILE
      w32(img, chainBlocks[chainBlocks.length - 1] * BLOCK + BLOCK - 2 * 4, ext); // prev's next-ext ptr
      chainBlocks.push(ext);
    }
    let i = 0;
    for (const blk of chainBlocks) {
      const count = Math.min(HT, nBlocks - i);
      w32(img, blk * BLOCK + 8, count); // high_seq: valid entries in this block
      for (let slot = 0; slot < count; slot++, i++) {
        const db = alloc();
        w32(img, blk * BLOCK + 24 + (HT - 1 - slot) * 4, db); // reverse order
        const chunk = f.content.subarray(i * chunkSize, (i + 1) * chunkSize);
        if (ffs) {
          img.set(chunk, db * BLOCK);
        } else {
          w32(img, db * BLOCK, 8); // T_DATA
          w32(img, db * BLOCK + 12, chunk.length);
          img.set(chunk, db * BLOCK + 24);
        }
      }
    }
    hashInsert(dir, header);
  }
  return img;
}

const small = new Uint8Array(300).map((_, i) => i & 0xff);
const big = new Uint8Array(1500).map((_, i) => (i * 7) & 0xff);
// Forces an OFS extension-block chain: 72 pointers/block * 488 B = 35,136 B
// per block, so this needs 3 header/extension blocks.
const huge = new Uint8Array(90000).map((_, i) => (i * 13 + 5) & 0xff);

describe('adfBootblockType', () => {
  it('classifies DOS variants, NDOS and KICK', () => {
    expect(adfBootblockType(buildAdf([], false))).toBe('OFS');
    expect(adfBootblockType(buildAdf([], true))).toBe('FFS');
    expect(adfBootblockType(Uint8Array.from([0x44, 0x4f, 0x53, 3]))).toBe('FFS-INTL');
    expect(adfBootblockType(Uint8Array.from([0x4b, 0x49, 0x43, 0x4b]))).toBe('KICK');
    expect(adfBootblockType(new Uint8Array(901120))).toBe('NDOS');
  });

  it('isAdfSize accepts DD and HD images only', () => {
    expect(isAdfSize(901120)).toBe(true);
    expect(isAdfSize(1802240)).toBe(true);
    expect(isAdfSize(901121)).toBe(false);
  });
});

describe('listAdf / readAdfFile', () => {
  for (const ffs of [false, true]) {
    const label = ffs ? 'FFS' : 'OFS';
    it(`walks directories and reads multi-block files (${label})`, () => {
      const img = buildAdf(
        [
          { path: 'Startup', content: small },
          { path: 'data/level1.bin', content: big },
        ],
        ffs,
      );
      const entries = listAdf(img)!;
      expect(entries.map((e) => [e.path, e.type])).toEqual([
        ['Startup', 'file'],
        ['data', 'dir'],
        ['data/level1.bin', 'file'],
      ]);
      const [startup, , level] = entries;
      expect(readAdfFile(img, startup)).toEqual(small);
      expect(level.size).toBe(1500);
      expect(readAdfFile(img, level)).toEqual(big);
    });

    it(`follows the extension-block chain past the header block's 72-entry table (${label})`, () => {
      const img = buildAdf([{ path: 'Big.dat', content: huge }], ffs);
      const [entry] = listAdf(img)!;
      expect(entry.size).toBe(huge.length);
      expect(readAdfFile(img, entry)).toEqual(huge);
    });
  }

  it('never sizes a read from an impossible on-disk size field', () => {
    // A corrupt/non-DOS header block yields sizes near 2^32. Trusting
    // one means allocating gigabytes for an 880 KB floppy — seen in the
    // wild on a TOSEC disk that reported 4 GB of files.
    const img = buildAdf([{ path: 'Real', content: small }], false);
    const entriesBefore = listAdf(img)!;
    const header = entriesBefore[0].headerBlock;
    // Corrupt the byte_size field to 0xFFFFFFF0.
    for (let i = 0; i < 4; i++) img[header * BLOCK + BLOCK - 47 * 4 + i] = i === 3 ? 0xf0 : 0xff;

    const [entry] = listAdf(img)!;
    expect(entry.size).toBe(0);
    expect(readAdfFile(img, entry).length).toBeLessThanOrEqual(img.length);
  });

  it('returns null for NDOS trackloader images', () => {
    expect(listAdf(new Uint8Array(901120))).toBeNull();
    const junk = new Uint8Array(901120);
    junk.set([0x44, 0x4f, 0x53, 0]); // DOS bootblock but garbage root
    expect(listAdf(junk)).toBeNull();
  });
});
