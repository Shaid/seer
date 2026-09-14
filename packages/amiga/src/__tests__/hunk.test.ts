import { describe, it, expect } from 'vitest';
import { buildHunkExe } from '../build.js';
import {
  isHunkFile,
  parseHunkFile,
  codeHunks,
  dataHunkPayloads,
  resolveHunkRelativeGlobal,
  HUNK_HEADER,
} from '../hunk.js';

const code = Uint8Array.from([0x4e, 0x71, 0x4e, 0x75, 0x4e, 0x71, 0x4e, 0x75]); // NOP RTS NOP RTS
const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

describe('isHunkFile', () => {
  it('accepts the 000003F3 magic and rejects everything else', () => {
    expect(isHunkFile(buildHunkExe([{ type: 'CODE', payload: code }]))).toBe(true);
    expect(isHunkFile(Uint8Array.from([0x00, 0x00, 0x03, 0xe9]))).toBe(false);
    expect(isHunkFile(new Uint8Array(2))).toBe(false);
  });
});

describe('parseHunkFile', () => {
  it('round-trips a CODE+DATA+BSS executable', () => {
    const exe = buildHunkExe([
      { type: 'CODE', payload: code },
      { type: 'DATA', payload: data },
      { type: 'BSS', memLongwords: 16 },
    ]);
    const hunks = parseHunkFile(exe);

    expect(hunks.map((h) => h.type)).toEqual(['CODE', 'DATA', 'BSS']);
    expect(hunks.map((h) => h.index)).toEqual([0, 1, 2]);

    const [c, d, b] = hunks;
    expect(c.size).toBe(8);
    expect(exe.subarray(c.fileOffset!, c.fileOffset! + c.size)).toEqual(code);
    expect(d.size).toBe(12);
    expect(exe.subarray(d.fileOffset!, d.fileOffset! + d.size)).toEqual(data);
    expect(b.size).toBe(0);
    expect(b.memSize).toBe(64);
    expect(b.fileOffset).toBeNull();
  });

  it('masks MEMF flags on both the size table and the in-stream tag', () => {
    const exe = buildHunkExe([
      { type: 'CODE', payload: code, chipMem: true },
      { type: 'DATA', payload: data, chipMem: true },
    ]);
    const hunks = parseHunkFile(exe);
    expect(hunks.map((h) => h.type)).toEqual(['CODE', 'DATA']);
    expect(hunks[0].memSize).toBe(8); // flag bit masked off, not 0x40000002 longwords
  });

  it('decodes HUNK_RELOC32 blocks onto the owning hunk', () => {
    const exe = buildHunkExe([
      {
        type: 'CODE',
        payload: code,
        relocs: [
          { targetHunk: 1, offsets: [0, 4] },
          { targetHunk: 0, offsets: [2] },
        ],
      },
      { type: 'DATA', payload: data },
    ]);
    const hunks = parseHunkFile(exe);
    expect(hunks[0].relocs).toEqual([
      { targetHunk: 1, offsets: [0, 4] },
      { targetHunk: 0, offsets: [2] },
    ]);
    expect(hunks[1].relocs).toEqual([]);
  });

  it('decodes HUNK_SYMBOL entries onto the owning hunk', () => {
    const exe = buildHunkExe([
      {
        type: 'CODE',
        payload: code,
        symbols: [
          { name: '_main', value: 0 },
          { name: '_LVOOpenLibrary', value: 4 },
        ],
      },
    ]);
    const hunks = parseHunkFile(exe);
    expect(hunks[0].symbols).toEqual([
      { name: '_main', value: 0 },
      { name: '_LVOOpenLibrary', value: 4 },
    ]);
  });

  it('memSize can exceed the stored payload size', () => {
    const exe = buildHunkExe([{ type: 'DATA', payload: data, memLongwords: 100 }]);
    const [d] = parseHunkFile(exe);
    expect(d.size).toBe(12);
    expect(d.memSize).toBe(400);
  });

  it('throws on a missing magic', () => {
    expect(() => parseHunkFile(Uint8Array.from([1, 2, 3, 4]))).toThrow(/HUNK_HEADER/);
  });

  it('throws with the offending tag on an unhandled hunk type', () => {
    const exe = buildHunkExe([{ type: 'CODE', payload: code }]);
    // Corrupt the in-stream HUNK_CODE tag into HUNK_EXT (0x3EF).
    const tagOff = exe.length - (4 + 8 + 4 + 4) + 3; // last: tag, size, payload, END
    const bad = Uint8Array.from(exe);
    bad[tagOff] = 0xef;
    expect(() => parseHunkFile(bad)).toThrow(/0x3ef/);
  });
});

describe('convenience accessors', () => {
  const exe = buildHunkExe([
    { type: 'CODE', payload: code },
    { type: 'DATA', payload: data },
    { type: 'CODE', payload: code },
  ]);

  it('codeHunks filters to CODE in file order', () => {
    expect(codeHunks(parseHunkFile(exe)).map((h) => h.index)).toEqual([0, 2]);
  });

  it('dataHunkPayloads returns payload bytes', () => {
    expect(dataHunkPayloads(exe, parseHunkFile(exe))).toEqual([data]);
  });
});

describe('resolveHunkRelativeGlobal', () => {
  it('resolves a value to the hunk it fits in, corroborated by a matching HUNK_RELOC32 entry', () => {
    const dataPayload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]); // size 8
    const ptr = Uint8Array.from([0, 0, 0, 4]); // stores the "absolute" value 4, hunk-relative
    const exe = buildHunkExe([
      { type: 'DATA', payload: dataPayload }, // hunk 0, size 8
      { type: 'CODE', payload: ptr, relocs: [{ targetHunk: 0, offsets: [0] }] }, // hunk 1, size 4
    ]);
    const hunks = parseHunkFile(exe);

    const results = resolveHunkRelativeGlobal(hunks, exe, 4);

    // hunk 1 (CODE, size 4) is excluded: 4 >= size, not a valid in-hunk offset.
    expect(results).toHaveLength(1);
    expect(results[0].hunk.index).toBe(0);
    expect(results[0].fileOffset).toBe(hunks[0].fileOffset! + 4);
    expect(results[0].corroboratingSites).toBe(1);
  });

  it('reports zero corroborating sites when no HUNK_RELOC32 entry stores the value', () => {
    const dataPayload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const exe = buildHunkExe([{ type: 'DATA', payload: dataPayload }]);
    const hunks = parseHunkFile(exe);

    const results = resolveHunkRelativeGlobal(hunks, exe, 4);

    expect(results).toHaveLength(1);
    expect(results[0].corroboratingSites).toBe(0);
  });

  it('returns no candidates for a value outside every hunk\'s size', () => {
    const exe = buildHunkExe([{ type: 'DATA', payload: Uint8Array.from([1, 2, 3, 4]) }]);
    const hunks = parseHunkFile(exe);

    expect(resolveHunkRelativeGlobal(hunks, exe, 999)).toEqual([]);
  });
});

describe('constants', () => {
  it('exports the header magic', () => {
    expect(HUNK_HEADER).toBe(0x3f3);
  });
});
