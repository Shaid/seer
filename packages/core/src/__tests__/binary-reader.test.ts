import { describe, it, expect } from 'vitest';
import { BinaryReader } from '../binary-reader.js';

describe('BinaryReader (default big-endian)', () => {
  function makeReader(bytes: number[]): BinaryReader {
    return new BinaryReader(new Uint8Array(bytes).buffer);
  }

  it('reads big-endian uint16', () => {
    const r = makeReader([0x12, 0x34]);
    expect(r.readUint16()).toBe(0x1234);
  });

  it('reads big-endian uint32', () => {
    const r = makeReader([0x00, 0x01, 0x00, 0x00]);
    expect(r.readUint32()).toBe(65536);
  });

  it('reads FourCC', () => {
    const r = makeReader([0x46, 0x4f, 0x52, 0x4d]); // "FORM"
    expect(r.readFourCC()).toBe('FORM');
  });

  it('tracks offset correctly', () => {
    const r = makeReader([0x01, 0x02, 0x03, 0x04]);
    expect(r.offset).toBe(0);
    r.readUint8();
    expect(r.offset).toBe(1);
    r.readUint16();
    expect(r.offset).toBe(3);
  });

  it('seek and skip work', () => {
    const r = makeReader([0x00, 0x00, 0x00, 0x42]);
    r.seek(3);
    expect(r.readUint8()).toBe(0x42);

    r.seek(0);
    r.skip(3);
    expect(r.readUint8()).toBe(0x42);
  });

  it('reads null-terminated C strings', () => {
    const r = makeReader([0x48, 0x69, 0x00, 0xff]); // "Hi\0\xff"
    expect(r.readCString()).toBe('Hi');
  });

  it('reads fixed-length strings', () => {
    const r = makeReader([0x41, 0x42, 0x00, 0x00]); // "AB\0\0"
    expect(r.readString(4)).toBe('AB');
  });

  it('throws on out-of-bounds read', () => {
    const r = makeReader([0x01]);
    expect(() => r.readUint16()).toThrow(RangeError);
  });

  it('subReader creates an independent reader over a slice', () => {
    const r = makeReader([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    r.skip(2);
    const sub = r.subReader(2);
    expect(sub.readUint8()).toBe(0x02);
    expect(sub.readUint8()).toBe(0x03);
    // Parent reader's offset advanced past the sub-reader's range.
    expect(r.offset).toBe(4);
  });
});

describe('BinaryReader (little-endian)', () => {
  function makeLEReader(bytes: number[]): BinaryReader {
    return new BinaryReader(new Uint8Array(bytes).buffer, 0, 'le');
  }

  it('reads little-endian uint16', () => {
    const r = makeLEReader([0x34, 0x12]);
    expect(r.readUint16()).toBe(0x1234);
  });

  it('reads little-endian uint32', () => {
    const r = makeLEReader([0x00, 0x00, 0x01, 0x00]);
    expect(r.readUint32()).toBe(65536);
  });

  it('propagates endianness through subReader', () => {
    const r = makeLEReader([0x00, 0x00, 0x34, 0x12]);
    r.skip(2);
    const sub = r.subReader(2);
    expect(sub.readUint16()).toBe(0x1234);
  });

  it('exposes the configured endianness', () => {
    expect(makeLEReader([0, 0]).endian).toBe('le');
  });
});
