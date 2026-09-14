import { describe, it, expect } from 'vitest';
import { decodeCgaBanked, decodePackedPixelLinear, indicesToRGBAWithTransparency } from '../packed-pixel.js';

describe('decodePackedPixelLinear', () => {
  it('unpacks 2bpp pixels MSB-first, 4 pixels/byte', () => {
    // byte 0b00_01_10_11 = 0x1b -> pixels [0,1,2,3]
    const data = new Uint8Array([0x1b]);
    const indices = decodePackedPixelLinear(data, 0, 4, 1, 2);
    expect([...indices]).toEqual([0, 1, 2, 3]);
  });

  it('unpacks 4bpp pixels MSB-first, 2 pixels/byte', () => {
    // byte 0xA5 -> high nibble 0xA, low nibble 0x5
    const data = new Uint8Array([0xa5]);
    const indices = decodePackedPixelLinear(data, 0, 2, 1, 4);
    expect([...indices]).toEqual([0xa, 0x5]);
  });

  it('decodes multiple rows using ceil(width/pixelsPerByte) row stride', () => {
    // width=5 at 2bpp -> ceil(5/4)=2 bytes/row
    // row0: 0b00_01_10_11 0b10_000000 -> [0,1,2,3,2]
    // row1: 0b11_10_01_00 0b01_000000 -> [3,2,1,0,1]
    const data = new Uint8Array([0x1b, 0x80, 0xe4, 0x40]);
    const indices = decodePackedPixelLinear(data, 0, 5, 2, 2);
    expect([...indices]).toEqual([0, 1, 2, 3, 2, 3, 2, 1, 0, 1]);
  });

  it('reads past the end of data as 0 rather than throwing', () => {
    const data = new Uint8Array([0x1b]);
    const indices = decodePackedPixelLinear(data, 0, 4, 2, 2);
    expect([...indices]).toEqual([0, 1, 2, 3, 0, 0, 0, 0]);
  });
});

describe('decodeCgaBanked', () => {
  it('interleaves even scanlines from bank 0 and odd from bank 1 (offset bankGap)', () => {
    // width=4 @ 2bpp -> 1 byte/row. 4 rows -> 2 rows/bank.
    // bank0 (even rows 0,2): 0x1b, 0xe4
    // bank1 (odd rows 1,3), at bankGap=8: 0x00, 0xff
    const data = new Uint8Array(16);
    data[0] = 0x1b; // row 0
    data[1] = 0xe4; // row 2
    data[8] = 0x00; // row 1
    data[9] = 0xff; // row 3
    const indices = decodeCgaBanked(data, 0, 4, 4, 2, 8);
    const row = (y: number) => [...indices.slice(y * 4, y * 4 + 4)];
    expect(row(0)).toEqual([0, 1, 2, 3]); // 0x1b
    expect(row(1)).toEqual([0, 0, 0, 0]); // 0x00
    expect(row(2)).toEqual([3, 2, 1, 0]); // 0xe4
    expect(row(3)).toEqual([3, 3, 3, 3]); // 0xff
  });
});

describe('indicesToRGBAWithTransparency', () => {
  const palette = [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
  ];

  it('maps each index through the palette and keys transparency off a chosen index', () => {
    const indices = new Uint8Array([0, 1, 2]);
    const rgba = indicesToRGBAWithTransparency(indices, palette, 2);
    expect([...rgba]).toEqual([
      0, 0, 0, 255, // index 0, opaque
      255, 0, 0, 255, // index 1, opaque
      0, 255, 0, 0, // index 2, transparent key
    ]);
  });

  it('defaults out-of-range indices to black rather than throwing', () => {
    const indices = new Uint8Array([9]);
    const rgba = indicesToRGBAWithTransparency(indices, palette, 15);
    expect([...rgba]).toEqual([0, 0, 0, 255]);
  });
});
