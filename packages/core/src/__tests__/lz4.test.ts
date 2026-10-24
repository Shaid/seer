/**
 * LZ4 block decompression, against hand-assembled blocks.
 *
 * The three paths that matter in the wild are a plain literal run, an
 * *overlapping* back-reference (the one a bulk `set(subarray)` copy gets
 * wrong), and the literals-only final sequence with no trailing match —
 * every NSO segment ends in that third shape.
 */
import { describe, it, expect } from 'vitest';

import { decompressLz4Block } from '../lz4.js';

const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/**
 *   token 0x54 -> 5 literals ("ABCDE"), match length nibble 4 (=> 4+4 = 8)
 *   offset 0x0005 -> copy 8 bytes starting 5 back, overlapping the run
 *   token 0x30 -> 3 literals ("XYZ"), end of block
 */
const BLOCK = Uint8Array.from([
  0x54, 0x41, 0x42, 0x43, 0x44, 0x45, 0x05, 0x00,
  0x30, 0x58, 0x59, 0x5a,
]);
const EXPECTED = 'ABCDEABCDEABCXYZ';

describe('decompressLz4Block', () => {
  it('expands literals, an overlapping match, and a literals-only tail', () => {
    expect(ascii(decompressLz4Block(BLOCK, EXPECTED.length))).toBe(EXPECTED);
  });

  it('handles the 15+extension length encoding for a long literal run', () => {
    const lit = 'z'.repeat(20);
    // litLen nibble 15 + one extension byte (20 - 15 = 5), no match.
    const src = Uint8Array.from([0xf0, 5, ...Array.from(lit, (c) => c.charCodeAt(0))]);
    expect(ascii(decompressLz4Block(src, 20))).toBe(lit);
  });

  it('handles the 15+extension length encoding for a long match', () => {
    // 1 literal 'a', then matchLen nibble 15 + extension 1 (=> 15+1+4 = 20)
    // at offset 1, i.e. a 21-byte run of 'a'.
    const src = Uint8Array.from([0x1f, 0x61, 1, 0, 1]);
    expect(ascii(decompressLz4Block(src, 21))).toBe('a'.repeat(21));
  });

  it('throws rather than silently truncating when a match offset is impossible', () => {
    // 1 literal then a match reaching 99 bytes before the start of output.
    const src = Uint8Array.from([0x14, 0x41, 99, 0]);
    expect(() => decompressLz4Block(src, 16)).toThrow(/bad match offset/);
  });

  it('throws when a literal run overruns the declared output size', () => {
    expect(() => decompressLz4Block(Uint8Array.from([0x50, 1, 2, 3, 4, 5]), 3)).toThrow(
      /literal run overruns buffer/,
    );
  });

  it('throws when a match run overruns the declared output size', () => {
    // 4 literals, then a 4+4 = 8 byte match at offset 1 into a 6-byte buffer.
    const src = Uint8Array.from([0x44, 1, 2, 3, 4, 1, 0, 0x00]);
    expect(() => decompressLz4Block(src, 6)).toThrow(/match run overruns buffer/);
  });

  it('trims the result to what the stream produced, so a short stream is visible', () => {
    // Declares 32 bytes of output; the block only produces 3.
    expect(decompressLz4Block(Uint8Array.from([0x30, 1, 2, 3]), 32)).toHaveLength(3);
  });
});
