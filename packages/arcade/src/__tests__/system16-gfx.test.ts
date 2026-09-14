import { describe, it, expect } from 'vitest';
import {
  decodeSega16Tiles8x8,
  decodeSega16PaletteWord,
  decodeSega16Sprites4bpp,
  computeResistorWeights,
  combineWeights,
} from '../sega/system16-gfx.js';

describe('decodeSega16Tiles8x8', () => {
  it('decodes an all-zero region to an all-zero tile sheet', () => {
    const data = new Uint8Array(3 * 8); // 1 tile, 3 planes, 8 rows each
    const { indices, tileCount, tileWidth, tileHeight } = decodeSega16Tiles8x8(data, 3);
    expect(tileCount).toBe(1);
    expect(tileWidth).toBe(8);
    expect(tileHeight).toBe(8);
    expect(indices.length).toBe(64);
    expect(indices.every((p) => p === 0)).toBe(true);
  });

  it('combines plane bits LSB-first by plane index for a single pixel', () => {
    const planeSize = 8; // 1 tile per plane
    const data = new Uint8Array(3 * planeSize);
    // Row 0, leftmost pixel (col 0, MSB of the row byte) set in planes 0 and 2 only.
    data[0 * planeSize + 0] = 0x80; // plane 0, row 0
    data[1 * planeSize + 0] = 0x00; // plane 1, row 0
    data[2 * planeSize + 0] = 0x80; // plane 2, row 0
    const { indices } = decodeSega16Tiles8x8(data, 3);
    // pixel = bit0(plane0) | bit1(plane1)<<1 | bit2(plane2)<<2 = 1 | 0 | 4 = 5
    expect(indices[0]).toBe(5);
    expect(Array.from(indices).filter((p) => p !== 0)).toEqual([5]);
  });

  it('assembles multiple tiles per plane in tile-major order', () => {
    const planeSize = 16; // 2 tiles per plane
    const data = new Uint8Array(3 * planeSize);
    data[8] = 0x01; // plane 0, tile 1, row 0, rightmost pixel (col 7)
    const { indices, tileCount } = decodeSega16Tiles8x8(data, 3);
    expect(tileCount).toBe(2);
    expect(indices[0 * 64 + 7]).toBe(0); // tile 0 untouched
    expect(indices[1 * 64 + 7]).toBe(1); // tile 1, row 0, col 7
  });

  it('silently truncates a trailing partial tile, mirroring MAME behavior', () => {
    const data = new Uint8Array(3 * 8 + 5); // 1 full tile + 5 stray bytes
    const { tileCount } = decodeSega16Tiles8x8(data, 3);
    expect(tileCount).toBe(1);
  });
});

describe('decodeSega16PaletteWord', () => {
  it('decodes all-zero word to black', () => {
    expect(decodeSega16PaletteWord(0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('decodes full-brightness red (nibble + extra bit both set) to 255', () => {
    // R nibble = bits 3-0 = 0xF, R extra bit = bit 12.
    const word = 0x000f | 0x1000;
    const { r, g, b } = decodeSega16PaletteWord(word);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('isolates the green and blue nibbles+extra-bits independently of red', () => {
    // G nibble = bits 7-4, G extra bit = bit 13.
    const green = decodeSega16PaletteWord(0x00f0 | 0x2000);
    expect(green).toEqual({ r: 0, g: 255, b: 0 });
    // B nibble = bits 11-8, B extra bit = bit 14.
    const blue = decodeSega16PaletteWord(0x0f00 | 0x4000);
    expect(blue).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('the shadow/hilight select bit (15) does not affect the returned "normal" pen', () => {
    // $7FFF (all nibbles + extra bits set, bit15=0) and $FFFF (same, bit15=1)
    // both drive the same "normal" pen per sega_16bit_common_base::paletteram_w
    // (bit 15 only selects which SECOND, shadow/hilight pen gets used).
    expect(decodeSega16PaletteWord(0x7fff)).toEqual({ r: 255, g: 255, b: 255 });
    expect(decodeSega16PaletteWord(0xffff)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('matches the real ROM-confirmed mid-grey value $0888 -> (132,132,132)', () => {
    // From a Golden Axe (System 16B) ROM census: $0888 (24 occurrences)
    // decodes to 5-bit value 16 on all 3 channels. Under the real
    // resistor-DAC LUT (not a naive linear approximation) that's
    // round(131.50...) = 132, not the naively-linear 131.
    expect(decodeSega16PaletteWord(0x0888)).toEqual({ r: 132, g: 132, b: 132 });
  });
});

describe('computeResistorWeights / combineWeights (MAME resnet.cpp port)', () => {
  const NORMAL_PEN_RESISTANCES = [3900, 2000, 1000, 500, 250, 0];

  it('autoscales so all-bits-on sums to exactly maxval', () => {
    const weights = computeResistorWeights(0, 255, NORMAL_PEN_RESISTANCES);
    const allOn = combineWeights(weights, [1, 1, 1, 1, 1, 0]);
    expect(allOn).toBe(255);
  });

  it('all-bits-off sums to exactly minval', () => {
    const weights = computeResistorWeights(0, 255, NORMAL_PEN_RESISTANCES);
    const allOff = combineWeights(weights, [0, 0, 0, 0, 0, 0]);
    expect(allOff).toBe(0);
  });

  it('is genuinely non-linear vs. a naive 0-31 -> 0-255 scale at a known divergence point', () => {
    // 5-bit value 11 = 0b01011 (bits 0,1,3 set). Naive linear round(11/31*255) = 90;
    // the real binary-weighted-resistor DAC gives 91 -- a small but genuine,
    // non-linear-rounding difference.
    const weights = computeResistorWeights(0, 255, NORMAL_PEN_RESISTANCES);
    const bits = (v: number) => [v & 1, (v >> 1) & 1, (v >> 2) & 1, (v >> 3) & 1, (v >> 4) & 1, 0];
    const dacValue = combineWeights(weights, bits(11));
    const naiveLinear = Math.round((11 / 31) * 255);
    expect(dacValue).toBe(91);
    expect(naiveLinear).toBe(90);
    expect(dacValue).not.toBe(naiveLinear);
  });
});

describe('decodeSega16Sprites4bpp', () => {
  it('unpacks 4 pixels per big-endian word, MSB-first', () => {
    // word = 0xABCD -> pixels [0xA, 0xB, 0xC, 0xD]
    const data = new Uint8Array([0xab, 0xcd]);
    const pixels = decodeSega16Sprites4bpp(data);
    expect(Array.from(pixels)).toEqual([0xa, 0xb, 0xc, 0xd]);
  });

  it('decodes multiple words in order', () => {
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const pixels = decodeSega16Sprites4bpp(data);
    expect(Array.from(pixels)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('ignores a trailing odd byte', () => {
    const data = new Uint8Array([0x12, 0x34, 0xff]);
    const pixels = decodeSega16Sprites4bpp(data);
    expect(pixels.length).toBe(4);
    expect(Array.from(pixels)).toEqual([1, 2, 3, 4]);
  });

  it('decodes an all-zero region to all-zero (transparent) pixels', () => {
    const pixels = decodeSega16Sprites4bpp(new Uint8Array(8));
    expect(pixels.every((p) => p === 0)).toBe(true);
  });
});
