/**
 * AmigaDOS HUNK executable/relocatable-module parser.
 *
 * Consolidates the seven independent per-repo copies the cross-repo audit
 * (docs/common-tooling-candidates.md §9) documents, starting from the
 * closest-to-superset implementation (strike's
 * `tools/shared/amiga-hunk.ts`) and adding what its consumers need but it
 * lacked: decoded `HUNK_RELOC32` offsets, decoded `HUNK_SYMBOL` entries,
 * the header's per-hunk memory-size table, and tests.
 *
 * Handles what's needed to find CODE/DATA/BSS hunk boundaries, their file
 * offsets, their relocations and their symbols — not a full linker/loader:
 * no relocation is applied, `HUNK_DEBUG` is skipped without decoding.
 *
 * Two masking rules learned the hard way (Desert Strike's 27 hunk-wrapped
 * chunks): linkers may embed `MEMF_CHIP`/`MEMF_FAST` flags in the top bits
 * of BOTH the header size-table entries AND the in-stream hunk-type
 * longword (e.g. raw tag `0x800003e9` = flags(CHIP) + `HUNK_CODE`), so a
 * correct parser masks `& 0x3FFFFFFF` in both places.
 */

import { r32 } from '@seer-project/core';

export const HUNK_UNIT = 0x3e7;
export const HUNK_NAME = 0x3e8;
export const HUNK_CODE = 0x3e9;
export const HUNK_DATA = 0x3ea;
export const HUNK_BSS = 0x3eb;
export const HUNK_RELOC32 = 0x3ec;
export const HUNK_EXT = 0x3ef;
export const HUNK_SYMBOL = 0x3f0;
export const HUNK_DEBUG = 0x3f1;
export const HUNK_END = 0x3f2;
export const HUNK_HEADER = 0x3f3;

const TYPE_MASK = 0x3fffffff;

export type HunkType = 'CODE' | 'DATA' | 'BSS';

/** One HUNK_RELOC32 block: 32-bit relocation offsets (within the owning hunk) that point into `targetHunk`. */
export interface HunkReloc32 {
  targetHunk: number;
  offsets: number[];
}

/** One HUNK_SYMBOL entry: a linker symbol name and its byte offset within the owning hunk. */
export interface HunkSymbol {
  name: string;
  value: number;
}

export interface Hunk {
  index: number;
  type: HunkType;
  /** Byte length of this hunk's stored payload (0 for BSS, which is reserved-but-uninitialized). */
  size: number;
  /**
   * Bytes this hunk occupies once loaded, from the header's size table
   * (flags masked off). ≥ `size` — a hunk may reserve more memory than it
   * stores, and BSS stores nothing at all.
   */
  memSize: number;
  /** File offset of this hunk's payload bytes within `data`. `null` for BSS (no stored payload). */
  fileOffset: number | null;
  /** Decoded HUNK_RELOC32 blocks following this hunk, if any. */
  relocs: HunkReloc32[];
  /** Decoded HUNK_SYMBOL entries following this hunk, if any. */
  symbols: HunkSymbol[];
}

/** True if `data` begins with the `HUNK_HEADER` magic (`000003F3`), i.e. is a HUNK executable/module. */
export function isHunkFile(data: Uint8Array): boolean {
  return data.length >= 4 && r32(data, 0, 'be') === HUNK_HEADER;
}

/**
 * Parse a HUNK_HEADER executable/relocatable module.
 *
 * Throws on an unrecognised in-stream tag (e.g. `HUNK_EXT`, `HUNK_LIB`,
 * `HUNK_OVERLAY`) rather than silently misparsing — a caller pointed at an
 * unfamiliar binary should get a clear error, not a truncated hunk list.
 */
export function parseHunkFile(data: Uint8Array): Hunk[] {
  if (!isHunkFile(data)) {
    throw new Error('parseHunkFile: missing HUNK_HEADER magic (000003F3) at offset 0');
  }
  let off = 4;

  // Resident library name list — null-terminated list of longword-counted
  // name strings; length 0 (in longwords) ends the list. Almost always
  // empty (first longword 0) for game binaries.
  for (;;) {
    const n = r32(data, off, 'be');
    off += 4;
    if (n === 0) break;
    off += n * 4;
  }

  off += 4; // table_size (total hunk count across all header table slots) — unused here
  const firstHunk = r32(data, off, 'be');
  off += 4;
  const lastHunk = r32(data, off, 'be');
  off += 4;
  const hunkCount = lastHunk - firstHunk + 1;

  // Per-hunk memory-size table (longwords; top bits carry MEMF flags).
  const memSizes: number[] = [];
  for (let i = 0; i < hunkCount; i++) {
    memSizes.push((r32(data, off, 'be') & TYPE_MASK) * 4);
    off += 4;
  }

  const hunks: Hunk[] = [];
  let index = 0;
  const current = () => hunks[hunks.length - 1];

  while (off < data.length) {
    const tag = r32(data, off, 'be') & TYPE_MASK;
    off += 4;

    if (tag === HUNK_CODE || tag === HUNK_DATA) {
      const size = r32(data, off, 'be') * 4;
      off += 4;
      hunks.push({
        index,
        type: tag === HUNK_CODE ? 'CODE' : 'DATA',
        size,
        memSize: memSizes[index] ?? size,
        fileOffset: off,
        relocs: [],
        symbols: [],
      });
      off += size;
      index++;
    } else if (tag === HUNK_BSS) {
      const size = r32(data, off, 'be') * 4;
      off += 4;
      hunks.push({
        index,
        type: 'BSS',
        size: 0,
        memSize: memSizes[index] ?? size,
        fileOffset: null,
        relocs: [],
        symbols: [],
      });
      index++;
    } else if (tag === HUNK_RELOC32) {
      for (;;) {
        const n = r32(data, off, 'be');
        off += 4;
        if (n === 0) break;
        const targetHunk = r32(data, off, 'be');
        off += 4;
        const offsets: number[] = [];
        for (let i = 0; i < n; i++) {
          offsets.push(r32(data, off, 'be'));
          off += 4;
        }
        const owner = current();
        if (!owner) throw new Error('parseHunkFile: HUNK_RELOC32 before any hunk');
        owner.relocs.push({ targetHunk, offsets });
      }
    } else if (tag === HUNK_SYMBOL) {
      for (;;) {
        const n = r32(data, off, 'be');
        off += 4;
        if (n === 0) break;
        let name = '';
        for (let i = 0; i < n * 4; i++) {
          const c = data[off + i];
          if (c) name += String.fromCharCode(c);
        }
        off += n * 4;
        const value = r32(data, off, 'be');
        off += 4;
        const owner = current();
        if (!owner) throw new Error('parseHunkFile: HUNK_SYMBOL before any hunk');
        owner.symbols.push({ name, value });
      }
    } else if (tag === HUNK_DEBUG) {
      const n = r32(data, off, 'be');
      off += 4;
      off += n * 4;
    } else if (tag === HUNK_END) {
      // no payload
    } else {
      throw new Error(
        `parseHunkFile: unhandled hunk tag 0x${tag.toString(16)} at file offset 0x${(off - 4).toString(16)}`,
      );
    }
  }

  return hunks;
}

/**
 * Load address of each hunk under the contiguous layout LoadSeg-style
 * tooling (IRA's `SECSTRT_n`, with `OFFSET` as `base`) assumes: hunk n
 * starts at `base + Σ memSize` of the hunks before it, BSS included —
 * memory sizes, not stored payload sizes. Verified against IRA's own
 * section addresses for a real 10-hunk executable (Frontier: a
 * 0x10000-byte BSS hunk at 0x18C puts the next CODE hunk at 0x1018C).
 */
export function hunkLoadAddresses(hunks: Hunk[], base = 0): number[] {
  const out: number[] = [];
  let addr = base;
  for (const h of hunks) {
    out.push(addr);
    addr += h.memSize;
  }
  return out;
}

/** Convenience: every CODE hunk, in file order. */
export function codeHunks(hunks: Hunk[]): Hunk[] {
  return hunks.filter((h) => h.type === 'CODE');
}

/** Convenience: every DATA hunk's payload bytes, in file order. */
export function dataHunkPayloads(data: Uint8Array, hunks: Hunk[]): Uint8Array[] {
  return hunks
    .filter((h): h is Hunk & { fileOffset: number } => h.type === 'DATA' && h.fileOffset !== null)
    .map((h) => data.subarray(h.fileOffset, h.fileOffset + h.size));
}

/**
 * One candidate resolution of a bare "absolute address" literal, as
 * returned by {@link resolveHunkRelativeGlobal}.
 */
export interface ResolvedGlobal {
  hunk: Hunk;
  /** `hunk.fileOffset + value`, or `null` if `hunk` is BSS (a reserved-but-uninitialized runtime location only, populated by code at startup). */
  fileOffset: number | null;
  /**
   * How many places across the whole module store `value` as the
   * pre-relocation payload of a `HUNK_RELOC32` entry whose `targetHunk`
   * equals `hunk.index` — i.e. how many real instructions in the binary
   * actually reference this exact value as a pointer into this hunk. `0`
   * means `value` merely happens to be smaller than `hunk.size` (a
   * necessary but not sufficient condition) with no corroborating
   * reference found — treat as a weak/coincidental candidate, not a
   * confirmed one.
   */
  corroboratingSites: number;
}

/**
 * Resolve a bare 32-bit "absolute address" literal — e.g. an instruction
 * operand a disassembly session hand-cited as "the global's address"
 * (`move.l #0,$18344.l`) — to its real file offset within one of `hunks`.
 *
 * For a HUNK-format binary not loaded via a fixed/deterministic base (the
 * normal AmigaOS `LoadSeg` case), an absolute-long operand's *raw stored
 * bytes* are only meaningful pre-relocation when the operand itself is
 * covered by a `HUNK_RELOC32` entry — in which case the stored value is
 * the referenced datum's *hunk-relative offset within its target hunk*,
 * not a portable runtime address (the loader patches it to
 * `targetHunk.runtimeBase + storedValue` at load time, and `runtimeBase`
 * is exactly the thing no static parse of the file can know). This
 * corroborates a candidate hunk by counting how many other `HUNK_RELOC32`
 * entries in the file store that exact value as a pointer into it — a
 * value with **no** hits at all across every hunk (checked, not just "no
 * reloc block exists") is decisive evidence it is not relative to any hunk
 * in this file, most likely a genuinely fixed absolute address belonging
 * to a different, separately-loaded file.
 */
export function resolveHunkRelativeGlobal(hunks: Hunk[], data: Uint8Array, value: number): ResolvedGlobal[] {
  const results: ResolvedGlobal[] = [];
  for (const h of hunks) {
    if (value < 0 || value >= h.size) continue;
    let corroboratingSites = 0;
    for (const owner of hunks) {
      if (owner.fileOffset === null) continue;
      for (const g of owner.relocs) {
        if (g.targetHunk !== h.index) continue;
        for (const relOff of g.offsets) {
          const pos = owner.fileOffset + relOff;
          if (pos + 4 <= data.length && r32(data, pos, 'be') === value) corroboratingSites++;
        }
      }
    }
    results.push({
      hunk: h,
      fileOffset: h.fileOffset !== null ? h.fileOffset + value : null,
      corroboratingSites,
    });
  }
  return results;
}
