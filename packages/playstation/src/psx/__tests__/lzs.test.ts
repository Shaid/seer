import { describe, it, expect } from 'vitest';
import { decompressLzss, decompressLzsFile, decompressLzsBuffer, isLzsCompressed } from '../lzs.js';

describe('decompressLzss (headerless core)', () => {
  it('decodes a literal-only stream', () => {
    // Flag = 0xFF means all 8 positions are literals; only 7 bytes follow.
    const input = new Uint8Array([0xff, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
    const result = decompressLzss(input);
    expect(result.length).toBe(7);
    expect(result[0]).toBe(0x41);
    expect(result[6]).toBe(0x47);
  });

  it('decodes a backref that copies 3 bytes from the initial window position', () => {
    // "ABC" as literals (flag bits 0-2 = literal), then a backref to offset
    // 0xFEE (the initial ring position, i.e. right where "ABC" was just
    // written) with length 3: b0=0xEE, b1=(0xF<<4)|(3-3)=0xF0.
    const input = new Uint8Array([0x07, 0x41, 0x42, 0x43, 0xee, 0xf0]);
    const result = decompressLzss(input);
    expect(Buffer.from(result).toString('ascii')).toBe('ABCABC');
  });

  it('decodes a backref with length > 3', () => {
    // "ABCDE" as literals (5 lit bits), then a backref of length 5 to the
    // start of what was just written: b1=(0xF<<4)|(5-3)=0xF2.
    const input = new Uint8Array([0x1f, 0x41, 0x42, 0x43, 0x44, 0x45, 0xee, 0xf2]);
    const result = decompressLzss(input);
    expect(Buffer.from(result).toString('ascii')).toBe('ABCDEABCDE');
  });

  it('handles multiple backrefs in one flags byte', () => {
    const input = new Uint8Array([0x07, 0x41, 0x42, 0x43, 0xee, 0xf0, 0xee, 0xf0, 0xee, 0xf0]);
    const result = decompressLzss(input);
    expect(Buffer.from(result).toString('ascii')).toBe('ABCABCABCABC');
  });
});

describe('decompressLzsFile (exact-length header)', () => {
  it('slices the payload to exactly the declared compressed length before decoding', () => {
    const payload = new Uint8Array([0xff, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
    const file = new Uint8Array(4 + payload.length + 3); // + trailing padding, not part of the stream
    new DataView(file.buffer).setUint32(0, payload.length, true);
    file.set(payload, 4);
    file.set([0xde, 0xad, 0xbe], 4 + payload.length);
    const result = decompressLzsFile(file);
    expect(Buffer.from(result).toString('ascii')).toBe('ABCDEFG');
  });

  it('rejects a file too short for its own header', () => {
    expect(() => decompressLzsFile(new Uint8Array(2))).toThrow(/too short/);
  });

  it('rejects a header declaring more compressed bytes than the file has', () => {
    const file = new Uint8Array(8);
    new DataView(file.buffer).setUint32(0, 1000, true);
    expect(() => decompressLzsFile(file)).toThrow(/declares/);
  });
});

describe('decompressLzsBuffer (approximate-length header, jitter tolerant)', () => {
  it('decodes from byte 4 to the end of the buffer regardless of the header value', () => {
    const payload = new Uint8Array([0x07, 0x41, 0x42, 0x43]);
    const buf = new Uint8Array(4 + payload.length);
    new DataView(buf.buffer).setUint32(0, payload.length + 5, true); // jittered header, not exact
    buf.set(payload, 4);
    const result = decompressLzsBuffer(buf);
    expect(Buffer.from(result).toString('ascii')).toBe('ABC');
  });

  it('rejects a buffer too short for its own header', () => {
    expect(() => decompressLzsBuffer(new Uint8Array(2))).toThrow(/too short/);
  });
});

describe('isLzsCompressed', () => {
  it('detects plausible headers', () => {
    expect(isLzsCompressed(new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0]))).toBe(true); // exact
    expect(isLzsCompressed(new Uint8Array([11, 0, 0, 0, 0, 0, 0, 0]))).toBe(true); // max jitter (+7)
    expect(isLzsCompressed(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]))).toBe(false);
    expect(isLzsCompressed(new Uint8Array([0, 0, 0]))).toBe(false); // too short
  });
});
