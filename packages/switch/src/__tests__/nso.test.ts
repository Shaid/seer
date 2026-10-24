/**
 * NSO0 header parse and image layout, against hand-assembled files —
 * including one whose `rodata` segment is a real LZ4 block, since the
 * compressed path is what every shipped executable actually takes.
 */
import { describe, it, expect } from 'vitest';

import { buildNsoImage, readCString } from '../nso.js';

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * An LZ4 block expanding to `'ABCDEABCDEABCXYZ'` (16 bytes): a 5-literal
 * run, an overlapping 8-byte match at offset 5, then a literals-only tail.
 */
const LZ4_RODATA = Uint8Array.from([
  0x54, 0x41, 0x42, 0x43, 0x44, 0x45, 0x05, 0x00,
  0x30, 0x58, 0x59, 0x5a,
]);
const LZ4_RODATA_PLAIN = 'ABCDEABCDEABCXYZ';

/**
 * Build an NSO0 from three segment payloads. `sizes[i]` is the segment's
 * *decompressed* size; a payload is marked compressed via `flags`.
 */
function buildNso(
  payloads: [Uint8Array, Uint8Array, Uint8Array],
  sizes: [number, number, number],
  flags: number,
  bss = 0,
): Uint8Array {
  const headerSize = 0x100;
  const memOffsets = [0, 0x1000, 0x2000];
  const fileOffsets: number[] = [];
  let at = headerSize;
  for (const p of payloads) {
    fileOffsets.push(at);
    at += p.length;
  }
  const file = new Uint8Array(at);
  const view = new DataView(file.buffer);
  view.setUint32(0, 0x4e534f30, false); // "NSO0"
  view.setUint32(0x0c, flags, true);
  view.setUint32(0x3c, bss, true);
  for (let i = 0; i < 3; i++) {
    view.setUint32(0x10 + i * 0x10 + 0, fileOffsets[i]!, true);
    view.setUint32(0x10 + i * 0x10 + 4, memOffsets[i]!, true);
    view.setUint32(0x10 + i * 0x10 + 8, sizes[i]!, true);
    view.setUint32(0x60 + i * 4, payloads[i]!.length, true); // compressed size
    file.set(payloads[i]!, fileOffsets[i]!);
  }
  return file;
}

describe('buildNsoImage', () => {
  it('lays uncompressed segments out at their virtual addresses and appends bss', () => {
    const text = Uint8Array.from([1, 2, 3, 4]);
    const rodata = ascii('hello\0');
    const data = Uint8Array.from([9, 9]);
    const { image, segments, bssSize } = buildNsoImage(
      buildNso([text, rodata, data], [text.length, rodata.length, data.length], 0, 0x40),
    );
    expect(bssSize).toBe(0x40);
    expect(segments.rodata.memoryOffset).toBe(0x1000);
    expect(segments.rodata.compressed).toBe(false);
    expect(image.length).toBe(0x2000 + 2 + 0x40);
    expect(Array.from(image.subarray(0, 4))).toEqual([1, 2, 3, 4]);
    expect(readCString(image, 0x1000)).toBe('hello');
    expect(Array.from(image.subarray(0x2000, 0x2002))).toEqual([9, 9]);
  });

  it('decompresses a segment whose flag bit is set, mixed with plain ones', () => {
    const text = Uint8Array.from([1, 2, 3, 4]);
    const data = Uint8Array.from([9, 9]);
    const nso = buildNso(
      [text, LZ4_RODATA, data],
      [text.length, LZ4_RODATA_PLAIN.length, data.length],
      0b010, // only rodata is compressed
    );
    const { image, segments } = buildNsoImage(nso);
    expect(segments.rodata.compressed).toBe(true);
    expect(segments.text.compressed).toBe(false);
    expect(String.fromCharCode(...image.subarray(0x1000, 0x1000 + LZ4_RODATA_PLAIN.length))).toBe(
      LZ4_RODATA_PLAIN,
    );
    expect(Array.from(image.subarray(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it('rejects a segment whose stream does not expand to its declared size', () => {
    const text = Uint8Array.from([1, 2, 3, 4]);
    const data = Uint8Array.from([9, 9]);
    // Declare 64 bytes of rodata; the block only produces 16.
    const nso = buildNso([text, LZ4_RODATA, data], [text.length, 64, data.length], 0b010);
    expect(() => buildNsoImage(nso)).toThrow(/segment 1 expanded to 16, declared 64/);
  });

  it('rejects a file whose magic is not NSO0', () => {
    const bad = buildNso([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)], [4, 4, 4], 0);
    new DataView(bad.buffer).setUint32(0, 0x4e534f31, false);
    expect(() => buildNsoImage(bad)).toThrow(/bad magic/);
  });

  it('rejects a file too short to hold a header', () => {
    expect(() => buildNsoImage(new Uint8Array(0x20))).toThrow(/too small/);
  });
});

describe('readCString', () => {
  it('returns null for a pointer into non-ASCII bytes rather than mojibake', () => {
    expect(readCString(Uint8Array.from([0, 0x41, 0x42, 0xff, 0x00]), 1)).toBeNull();
  });

  it('returns null for an out-of-range or zero address', () => {
    const image = Uint8Array.from([0x41, 0x00]);
    expect(readCString(image, 0)).toBeNull();
    expect(readCString(image, 999)).toBeNull();
  });

  it('returns null for a string unterminated within maxLen', () => {
    const image = ascii('\0aaaaaaaa');
    expect(readCString(image, 1, 4)).toBeNull();
    expect(readCString(image, 1, 64)).toBeNull(); // runs off the end too
  });
});
