/**
 * Nintendo Switch `NSO0` executable container (an ExeFS's `main`,
 * `subsdk*`, `rtld`, `sdk`) — header parse plus the LZ4 block
 * decompression its segments normally use, producing one flat image
 * addressable by the module's own virtual addresses.
 *
 * Why a flat image: the ROM filesystem alone never says what a numeric
 * resource ID *means*. A title's own `main` routinely carries the ID ->
 * name registry that no external source has (Fire Emblem Warriors' is
 * 13,133 entries), and reaching it needs the executable decompressed and
 * laid out first, because the tables are linked by virtual address.
 *
 * Format (all little-endian), per the public `NSO0` documentation:
 *
 * | Offset | Size | Field |
 * |---|---|---|
 * | `0x00` | 4 | magic `"NSO0"` |
 * | `0x04` | 4 | version |
 * | `0x08` | 4 | reserved |
 * | `0x0c` | 4 | flags — bit 0/1/2 set = text/rodata/data segment is LZ4-compressed |
 * | `0x10` | 16 | text segment header: `u32 fileOffset, u32 memoryOffset, u32 decompressedSize` (+ 4 unused) |
 * | `0x20` | 16 | rodata segment header, same shape |
 * | `0x30` | 16 | data segment header, same shape |
 * | `0x3c` | 4 | `.bss` size |
 * | `0x60` | 12 | `u32 compressedSize[3]` for the three segments |
 *
 * A segment's bytes live at `fileOffset` for `compressedSize` bytes and
 * expand (or are copied verbatim when its flag bit is clear) to exactly
 * `decompressedSize` bytes at image offset `memoryOffset`. `buildNsoImage`
 * lays all three out at their `memoryOffset`s in one zero-filled buffer
 * sized to cover the last segment plus `.bss`, so a virtual address read
 * out of the module's own pointers indexes the returned buffer directly.
 * (A `text` at vaddr 0 makes that mapping the identity, which is the
 * common case; the loader does not assume it.)
 *
 * Verified byte-exact against `Fire Emblem Warriors [0100F15003E64000][v0]`'s
 * ExeFS `main` (8,949,332 bytes on disk, flags `0x3f` = all three
 * compressed): every segment's LZ4 stream expands to *exactly* its declared
 * `decompressedSize` with no remainder — a zero-deviation structural
 * invariant across all three — giving a 19,423,232-byte image whose strings
 * and pointer arrays are internally consistent.
 */

import { decompressLz4Block } from '@seer-project/core';

export interface NsoSegment {
  /** Byte offset of this segment's (possibly compressed) bytes in the file. */
  fileOffset: number;
  /** Virtual address / image offset the segment is laid out at. */
  memoryOffset: number;
  /** Size after decompression. */
  size: number;
  compressed: boolean;
}

export interface NsoImage {
  /** Flat image: index by the module's own virtual address. */
  image: Uint8Array;
  segments: { text: NsoSegment; rodata: NsoSegment; data: NsoSegment };
  bssSize: number;
}

/**
 * Parse an `NSO0` file and return its fully laid-out, decompressed image.
 * Throws on a bad magic or on any segment whose stream does not expand to
 * exactly its declared size — the latter is the check that makes a
 * misparsed header fail here rather than as nonsense ten tables later.
 */
export function buildNsoImage(file: Uint8Array): NsoImage {
  if (file.length < 0x100) throw new Error('nso: too small');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, false) !== 0x4e534f30) throw new Error('nso: bad magic (expected "NSO0")');
  const flags = view.getUint32(0x0c, true);
  const bssSize = view.getUint32(0x3c, true);

  const segs: NsoSegment[] = [];
  for (let i = 0; i < 3; i++) {
    const base = 0x10 + i * 0x10;
    segs.push({
      fileOffset: view.getUint32(base + 0, true),
      memoryOffset: view.getUint32(base + 4, true),
      size: view.getUint32(base + 8, true),
      compressed: (flags & (1 << i)) !== 0,
    });
  }
  const compressedSizes = [0, 1, 2].map((i) => view.getUint32(0x60 + i * 4, true));

  const end = Math.max(...segs.map((s) => s.memoryOffset + s.size)) + bssSize;
  const image = new Uint8Array(end);
  for (const [i, seg] of segs.entries()) {
    const raw = file.subarray(seg.fileOffset, seg.fileOffset + compressedSizes[i]);
    const bytes = seg.compressed ? decompressLz4Block(raw, seg.size) : raw.subarray(0, seg.size);
    if (bytes.length !== seg.size) {
      throw new Error(`nso: segment ${i} expanded to ${bytes.length}, declared ${seg.size}`);
    }
    image.set(bytes, seg.memoryOffset);
  }
  return { image, segments: { text: segs[0], rodata: segs[1], data: segs[2] }, bssSize };
}

/**
 * Read a NUL-terminated ASCII string at `va` in an NSO image, or `null` if
 * the address is out of range, the string is unterminated within `maxLen`,
 * or it contains a non-ASCII/control byte.
 *
 * The `null` returns are the point, and are why this is not
 * `@seer-project/core`'s `cStringAt`: this is a *pointer oracle*. Walking a
 * module's data segment looking for string tables means testing millions of
 * words that are not pointers, and the useful answer for those is "not a
 * string", not a plausible-looking mojibake fragment that a later heuristic
 * then counts as evidence.
 */
export function readCString(image: Uint8Array, va: number, maxLen = 256): string | null {
  if (!Number.isInteger(va) || va <= 0 || va >= image.length) return null;
  let end = va;
  const limit = Math.min(image.length, va + maxLen);
  while (end < limit && image[end] !== 0) {
    const c = image[end];
    if (c < 0x20 || c > 0x7e) return null;
    end++;
  }
  if (end >= limit) return null;
  if (end === va) return '';
  return String.fromCharCode(...image.subarray(va, end));
}
