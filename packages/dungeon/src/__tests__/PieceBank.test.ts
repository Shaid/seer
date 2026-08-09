import { describe, expect, it } from 'vitest';
import { PieceBank } from '../raster/PieceBank.js';

// 2x2 RGBA atlas: opaque red, opaque red (same color, should share an
// index), opaque blue, and a transparent hole.
const rgba = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 10, 20, 30, 0]);

const atlas = { width: 2, height: 2, frames: [{ name: 'piece', x: 0, y: 0, w: 2, h: 2 }] };

describe('PieceBank.fromRGBA', () => {
  it('derives a local palette from the distinct opaque colors present', () => {
    const bank = PieceBank.fromRGBA(rgba, 2, 2, atlas);
    // Index 0 is reserved for background; red and blue are the only two distinct opaque colors, so the palette is [bg, red, blue].
    expect(bank.palette).toEqual([
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
    ]);
  });

  it('assigns the same index to repeated identical colors', () => {
    const bank = PieceBank.fromRGBA(rgba, 2, 2, atlas);
    expect(bank.index[0]).toBe(bank.index[1]);
  });

  it('derives the mask plane from alpha (0 = transparent, else opaque)', () => {
    const bank = PieceBank.fromRGBA(rgba, 2, 2, atlas);
    expect(Array.from(bank.mask)).toEqual([1, 1, 1, 0]);
  });

  it('maps a transparent source pixel to the reserved background index', () => {
    const bank = PieceBank.fromRGBA(rgba, 2, 2, atlas);
    expect(bank.index[3]).toBe(0);
  });

  it('exposes frame rects by name and rejects unknown frames', () => {
    const bank = PieceBank.fromRGBA(rgba, 2, 2, atlas);
    expect(bank.frame('piece')).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(bank.hasFrame('nope')).toBe(false);
    expect(() => bank.frame('nope')).toThrow(/unknown frame/);
  });

  it('rejects a pixel buffer of the wrong length', () => {
    expect(() => PieceBank.fromRGBA(new Uint8Array(4), 2, 2, atlas)).toThrow();
  });
});
