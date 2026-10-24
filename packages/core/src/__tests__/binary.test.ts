import { describe, it, expect } from 'vitest';
import {
  r16, r24, r32, dataViewOf,
  asciiAt, fourCCAt, printableAsciiAt, cStringAt, hexAt, matchesMagic, alignUp, clamp, clamp01,
} from '../binary.js';

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

const BYTES = new Uint8Array([0x46, 0x4f, 0x52, 0x4d, 0x00, 0x7f, 0x80, 0xff, 0x41, 0x42, 0x00, 0x43]);

describe('asciiAt', () => {
  it('maps one byte to one code point, filtering nothing', () => {
    expect(asciiAt(BYTES, 0, 4)).toBe('FORM');
    // 0x00/0x7f/0x80/0xff all pass through as code points 0/127/128/255.
    expect(Array.from(asciiAt(BYTES, 4, 4)).map((c) => c.charCodeAt(0))).toEqual([0, 0x7f, 0x80, 0xff]);
  });

  it('reads a byte past the end as \\0 rather than throwing', () => {
    expect(asciiAt(BYTES, BYTES.length - 1, 3)).toBe('C\u0000\u0000');
  });

  it('respects a subarray window (byteOffset is not ignored)', () => {
    expect(asciiAt(BYTES.subarray(8), 0, 2)).toBe('AB');
  });
});

describe('fourCCAt', () => {
  it('reads the four-byte tag at 0 by default', () => {
    expect(fourCCAt(BYTES)).toBe('FORM');
  });
  it('reads a tag at an offset', () => {
    expect(fourCCAt(BYTES, 8)).toBe('AB\u0000C');
  });
});

describe('printableAsciiAt', () => {
  it('substitutes the placeholder outside 0x20-0x7e', () => {
    // 0x00, 0x7f, 0x80 and 0xff are all outside 0x20-0x7e.
    expect(printableAsciiAt(BYTES, 0, 8)).toBe('FORM....');
  });
  it('keeps 0x20 and 0x7e as the inclusive bounds', () => {
    const edge = new Uint8Array([0x1f, 0x20, 0x7e, 0x7f]);
    expect(printableAsciiAt(edge, 0, 4)).toBe('. ~.');
  });
  it('takes a custom placeholder', () => {
    expect(printableAsciiAt(BYTES, 4, 4, '_')).toBe('____');
  });
});

describe('cStringAt', () => {
  it('stops at the first NUL', () => {
    expect(cStringAt(BYTES, 8)).toBe('AB');
  });
  it('stops at maxLen', () => {
    expect(cStringAt(BYTES, 0, 2)).toBe('FO');
  });
  it('stops at the end of the data when there is no NUL', () => {
    expect(cStringAt(new Uint8Array([0x41, 0x42]), 0)).toBe('AB');
  });
  it('returns an empty string at a NUL', () => {
    expect(cStringAt(BYTES, 10)).toBe('');
  });
});

describe('matchesMagic', () => {
  it('matches at an offset', () => {
    expect(matchesMagic(BYTES, 0, 'FORM')).toBe(true);
    expect(matchesMagic(BYTES, 8, 'AB')).toBe(true);
  });
  it('rejects a mismatch', () => {
    expect(matchesMagic(BYTES, 0, 'FOR8')).toBe(false);
  });
  it('rejects a magic that would run past the end rather than reading undefined', () => {
    expect(matchesMagic(BYTES, BYTES.length - 1, 'CC')).toBe(false);
  });
  it('can never match a code unit above 255', () => {
    expect(matchesMagic(new Uint8Array([0xff]), 0, '\u01ff')).toBe(false);
  });
});

describe('clamp / clamp01', () => {
  it('clamps into the given range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
  it('clamp01 is clamp(v, 0, 1)', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(2)).toBe(1);
  });
});

describe('hexAt', () => {
  const data = new Uint8Array([0x00, 0x0f, 0xa5, 0xff]);

  it('is two lowercase digits per byte with no separator', () => {
    expect(hexAt(data, 0, 4)).toBe('000fa5ff');
    expect(hexAt(data, 2, 1)).toBe('a5');
    expect(hexAt(data, 0, 0)).toBe('');
  });

  // Deliberately the opposite of asciiAt's pad-with-NUL: `00` is a real byte
  // value, so padding a short read would turn a truncated buffer into a
  // plausible-looking digest.
  it('truncates past the end rather than padding, unlike asciiAt', () => {
    expect(hexAt(data, 2, 8)).toBe('a5ff');
    expect(hexAt(data, 99, 4)).toBe('');
    expect(asciiAt(data, 2, 4)).toHaveLength(4);
  });
});

describe('alignUp', () => {
  it('rounds up to the next multiple, leaving exact multiples alone', () => {
    expect(alignUp(0, 32)).toBe(0);
    expect(alignUp(1, 32)).toBe(32);
    expect(alignUp(32, 32)).toBe(32);
    expect(alignUp(33, 32)).toBe(64);
  });

  it('handles a non-power-of-two alignment, which the bitwise idiom cannot', () => {
    expect(alignUp(10, 3)).toBe(12);
    expect(alignUp(12, 3)).toBe(12);
  });

  // The whole reason this is `%` and not `(v + n - 1) & ~(n - 1)`: JS bitwise
  // operators truncate to 32-bit *signed*, so the idiom goes negative past
  // 2**31 — a real failure on a 6.9 GB archive, not a theoretical one.
  it('stays correct past 2**31, where the bitwise idiom goes negative', () => {
    // 6936719456 is the real DATA1.bin size that found this; it happens to be
    // 32-aligned already, so it exercises the exact-multiple path up there.
    expect(alignUp(6936719456, 32)).toBe(6936719456);
    expect(alignUp(6936719457, 32)).toBe(6936719488);
    expect(alignUp(2 ** 31 + 1, 32)).toBe(2 ** 31 + 32);
    // What the bitwise idiom does with the same inputs — the bug this replaces.
    expect((6936719457 + 31) & ~31).toBeLessThan(0);
  });

  it('agrees with the bitwise idiom everywhere that idiom is valid', () => {
    for (const align of [2, 4, 8, 16, 32, 128, 2048]) {
      for (const v of [0, 1, 7, 255, 4095, 65535, 1 << 20, (1 << 30) + 3]) {
        expect(alignUp(v, align)).toBe((v + (align - 1)) & ~(align - 1));
      }
    }
  });
});
