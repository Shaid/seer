import { describe, it, expect } from 'vitest';
import { r16, r24, r32, dataViewOf } from '../binary.js';

describe('dataViewOf', () => {
  it('creates a DataView over the array with correct byteOffset/byteLength', () => {
    const buf = new ArrayBuffer(16);
    const data = new Uint8Array(buf, 4, 8);
    const dv = dataViewOf(data);
    expect(dv.byteLength).toBe(8);
  });
});

describe('r16', () => {
  it('reads big-endian u16', () => {
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    expect(r16(data, 0, 'be')).toBe(0x1234);
    expect(r16(data, 2, 'be')).toBe(0x5678);
  });

  it('reads little-endian u16', () => {
    const data = new Uint8Array([0x34, 0x12, 0x78, 0x56]);
    expect(r16(data, 0, 'le')).toBe(0x1234);
    expect(r16(data, 2, 'le')).toBe(0x5678);
  });

  it('reads zero and max values', () => {
    const zero = new Uint8Array([0, 0]);
    expect(r16(zero, 0, 'be')).toBe(0);
    expect(r16(zero, 0, 'le')).toBe(0);

    const max = new Uint8Array([0xff, 0xff]);
    expect(r16(max, 0, 'be')).toBe(0xffff);
    expect(r16(max, 0, 'le')).toBe(0xffff);
  });
});

describe('r24', () => {
  it('reads big-endian u24', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xff, 0xff]);
    expect(r24(data, 0, 'be')).toBe(0x010203);
    expect(r24(data, 3, 'be')).toBe(0xffffff);
  });

  it('reads little-endian u24', () => {
    const data = new Uint8Array([0x03, 0x02, 0x01, 0xff, 0xff, 0xff]);
    expect(r24(data, 0, 'le')).toBe(0x010203);
    expect(r24(data, 3, 'le')).toBe(0xffffff);
  });
});

describe('r32', () => {
  it('reads big-endian u32', () => {
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0xff, 0xff, 0xff, 0xff]);
    expect(r32(data, 0, 'be')).toBe(0x12345678);
    expect(r32(data, 4, 'be')).toBe(0xffffffff);
  });

  it('reads little-endian u32', () => {
    const data = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0xff]);
    expect(r32(data, 0, 'le')).toBe(0x12345678);
    expect(r32(data, 4, 'le')).toBe(0xffffffff);
  });

  it('handles values with the high bit set', () => {
    const data = new Uint8Array([0x80, 0x00, 0x00, 0x00]);
    expect(r32(data, 0, 'be')).toBe(0x80000000);
    const dataLe = new Uint8Array([0x00, 0x00, 0x00, 0x80]);
    expect(r32(dataLe, 0, 'le')).toBe(0x80000000);
  });
});
