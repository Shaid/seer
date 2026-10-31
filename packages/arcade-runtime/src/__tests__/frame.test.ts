import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  createIndexedFrame,
  indexedToRgba,
  packPaletteTexture,
  paletteEntries,
  pixelAspectForDisplay,
} from '../frame.js';

const palette = new Uint8Array([
  10, 20, 30, 0, // 0: alpha 0 in palette RAM
  40, 50, 60, 255,
  70, 80, 90, 128,
]);

describe('indexedToRgba', () => {
  it('maps indices through the palette with alpha forced opaque', () => {
    const frame = { width: 2, height: 2, pixels: new Uint16Array([0, 1, 2, 1]) };
    expect(Array.from(indexedToRgba(frame, palette))).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 40, 50, 60, 255,
    ]);
  });

  it('keeps palette alpha on request', () => {
    const frame = { width: 1, height: 1, pixels: new Uint16Array([2]) };
    expect(Array.from(indexedToRgba(frame, palette, { keepAlpha: true }))).toEqual([70, 80, 90, 128]);
  });

  it('draws out-of-range indices as opaque black', () => {
    const frame = { width: 2, height: 1, pixels: new Uint16Array([3, 0xffff]) };
    expect(Array.from(indexedToRgba(frame, palette))).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });

  it('writes into a supplied buffer and rejects a short frame', () => {
    const out = new Uint8ClampedArray(8);
    const frame = { width: 2, height: 1, pixels: new Uint16Array([1, 1]) };
    expect(indexedToRgba(frame, palette, { out })).toBe(out);
    expect(() => indexedToRgba({ width: 4, height: 4, pixels: new Uint16Array(3) }, palette)).toThrow();
  });

  it('createIndexedFrame allocates width*height indices', () => {
    const f = createIndexedFrame(256, 224);
    expect(f.pixels.length).toBe(256 * 224);
  });
});

describe('packPaletteTexture', () => {
  it('lays entries out 256 per row with opaque padding', () => {
    const big = new Uint8Array(300 * 4).map((_, i) => i & 0xff);
    const packed = packPaletteTexture(big);
    expect(paletteEntries(big)).toBe(300);
    expect(packed.width).toBe(256);
    expect(packed.height).toBe(2);
    expect(packed.data.length).toBe(256 * 2 * 4);
    // Entry 257 lives at texel (1, 1).
    const o = (256 + 1) * 4;
    expect(Array.from(packed.data.subarray(o, o + 4))).toEqual([big[257 * 4], big[257 * 4 + 1], big[257 * 4 + 2], 255]);
    // Padding after the last entry.
    expect(Array.from(packed.data.subarray(300 * 4, 300 * 4 + 4))).toEqual([0, 0, 0, 255]);
  });

  it('agrees with indexedToRgba for every index', () => {
    const packed = packPaletteTexture(palette);
    const frame = { width: 4, height: 1, pixels: new Uint16Array([0, 1, 2, 200]) };
    const ref = indexedToRgba(frame, palette);
    for (let i = 0; i < 4; i++) {
      const idx = frame.pixels[i]!;
      expect(Array.from(packed.data.subarray(idx * 4, idx * 4 + 4))).toEqual(Array.from(ref.subarray(i * 4, i * 4 + 4)));
    }
  });

  it('reuses an output buffer of the right size', () => {
    const first = packPaletteTexture(palette);
    expect(packPaletteTexture(palette, first.data).data).toBe(first.data);
  });

  it('handles an empty palette', () => {
    const packed = packPaletteTexture(new Uint8Array(0));
    expect(packed.height).toBe(1);
  });
});

describe('computeLayout', () => {
  it('integer mode picks the largest whole scale and centres', () => {
    expect(computeLayout({ width: 256, height: 224, targetWidth: 1920, targetHeight: 1080 })).toEqual({
      x: 448,
      y: 92,
      width: 1024,
      height: 896,
    });
  });

  it('integer mode never goes below 1x', () => {
    const l = computeLayout({ width: 256, height: 224, targetWidth: 100, targetHeight: 100 });
    expect(l.width).toBe(256);
    expect(l.height).toBe(224);
  });

  it('integer mode applies pixel aspect horizontally', () => {
    const par = pixelAspectForDisplay(256, 224);
    expect(par).toBeCloseTo(7 / 6, 10);
    const l = computeLayout({ width: 256, height: 224, targetWidth: 1920, targetHeight: 1080, pixelAspect: par });
    expect(l.height).toBe(896);
    expect(l.width).toBe(Math.round(256 * (7 / 6) * 4));
    expect(l.width / l.height).toBeCloseTo(4 / 3, 2);
  });

  it('fit mode fills one axis exactly', () => {
    const l = computeLayout({ width: 256, height: 224, targetWidth: 1920, targetHeight: 1080, mode: 'fit' });
    expect(l.height).toBe(1080);
    expect(l.width).toBe(Math.round(256 * (1080 / 224)));
    expect(l.y).toBe(0);
  });

  it('fill mode stretches to the target', () => {
    expect(computeLayout({ width: 256, height: 224, targetWidth: 800, targetHeight: 600, mode: 'fill' })).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it('a vertical-monitor aspect makes pixels narrower', () => {
    expect(pixelAspectForDisplay(224, 256, 3 / 4)).toBeCloseTo((3 / 4) / (224 / 256), 10);
  });
});
