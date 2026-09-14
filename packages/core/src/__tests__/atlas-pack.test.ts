import { describe, it, expect } from 'vitest';
import { shelfPack, packAtlasRgba } from '../atlas-pack.js';

describe('shelfPack', () => {
  it('places items left to right, wrapping to a new shelf when maxWidth would be exceeded', () => {
    const result = shelfPack(
      [
        { name: 'a', width: 10, height: 5 },
        { name: 'b', width: 10, height: 8 },
        { name: 'c', width: 10, height: 3 },
      ],
      25,
      1,
    );

    // a: x=0, b: x=11 (10+1 padding), c would need x=22..31 > 25, wraps
    expect(result.frames).toEqual([
      { name: 'a', x: 0, y: 0, w: 10, h: 5 },
      { name: 'b', x: 11, y: 0, w: 10, h: 8 },
      { name: 'c', x: 0, y: 9, w: 10, h: 3 }, // y = shelfHeight(8) + padding(1)
    ]);
    expect(result.width).toBe(21); // max(a+b row width) = 11 + 10
    expect(result.height).toBe(12); // 9 + 3
  });

  it('never wraps a shelf containing a single item, even if it exceeds maxWidth', () => {
    const result = shelfPack([{ name: 'big', width: 100, height: 10 }], 25);
    expect(result.frames).toEqual([{ name: 'big', x: 0, y: 0, w: 100, h: 10 }]);
    expect(result.width).toBe(100);
    expect(result.height).toBe(10);
  });

  it('returns an empty atlas for no items', () => {
    const result = shelfPack([], 25);
    expect(result.frames).toEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });
});

describe('packAtlasRgba', () => {
  it('blits each image into its packed frame position', () => {
    const red = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) red.set([255, 0, 0, 255], i * 4);
    const blue = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) blue.set([0, 0, 255, 255], i * 4);

    const atlas = packAtlasRgba(
      [
        { name: 'red', width: 2, height: 2, rgba: red },
        { name: 'blue', width: 2, height: 2, rgba: blue },
      ],
      100,
      0,
    );

    expect(atlas.frames).toEqual([
      { name: 'red', x: 0, y: 0, w: 2, h: 2 },
      { name: 'blue', x: 2, y: 0, w: 2, h: 2 },
    ]);
    expect(atlas.width).toBe(4);
    expect(atlas.height).toBe(2);

    // pixel (0,0) is red
    expect(Array.from(atlas.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    // pixel (2,0) is blue (start of the second image's first row)
    const px20 = (0 * atlas.width + 2) * 4;
    expect(Array.from(atlas.rgba.subarray(px20, px20 + 4))).toEqual([0, 0, 255, 255]);
  });
});
