import { describe, expect, it } from 'vitest';
import { parseBch, readVsBoolWord } from '../bch.js';
import { parseCgfx } from '../cgfx.js';

describe('BCH', () => {
  it('throws on a non-BCH buffer', () => {
    expect(() => parseBch(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a BCH file/);
  });

  it('parses an empty-but-well-formed header into zero models/textures/animations', () => {
    // 0x30-byte header: magic "BCH\0", bc revision byte, then the pointer
    // table offsets all pointing at (or past) the end of the buffer so every
    // table read comes back empty rather than throwing.
    const buf = new Uint8Array(0x80);
    buf.set([0x42, 0x43, 0x48, 0x00], 0);
    buf[4] = 0x21; // bc revision > 0x20 so the dataExtendedOffset field is read
    const view = new DataView(buf.buffer);
    view.setUint32(8, 0x30, true); // mainHeaderOffset
    view.setUint32(24, 0, true); // dataExtendedOffset
    view.setUint32(28, 0x30, true); // relocationTableOffset
    view.setUint32(52, 0, true); // relocationTableLength
    const bch = parseBch(buf);
    expect(bch.models).toEqual([]);
    expect(bch.textures).toEqual([]);
    expect(bch.skeletalAnimations).toEqual([]);
  });
});

describe('CGFX', () => {
  it('throws on a non-CGFX buffer', () => {
    expect(() => parseCgfx(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a CGFX file/);
  });

  it('throws when the DATA chunk magic is missing', () => {
    const buf = new Uint8Array(0x20);
    buf.set([0x43, 0x47, 0x46, 0x58], 0); // "CGFX"
    new DataView(buf.buffer).setUint16(6, 0x14, true); // headerLength
    expect(() => parseCgfx(buf)).toThrow(/no DATA chunk/);
  });
});

describe('BCH vertex-shader bool word', () => {
  const stream = (...words: number[]): DataView => {
    const b = new Uint8Array(words.length * 4);
    const v = new DataView(b.buffer);
    words.forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
    return v;
  };
  it('reads register 0x2b0 from a mesh command buffer (bit 5 = IsHemiL)', () => {
    const w = readVsBoolWord(stream(0x7fff6c2b, 0x000f02b0), 2)!;
    expect(w & 0xffff).toBe(0x6c2b);
    expect((w >> 5) & 1).toBe(1); // IsHemiL
    expect((w >> 6) & 1).toBe(0); // IsHemiO
    expect(readVsBoolWord(stream(0x7fff0003, 0x000f02b0), 2)! >> 5 & 1).toBe(0);
  });
  it('is undefined when the stream never writes the register', () => {
    expect(readVsBoolWord(stream(0x12345678, 0x000f0200), 2)).toBeUndefined();
  });
});
