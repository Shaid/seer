import { describe, expect, it } from 'vitest';
import { IndexedSurface } from '../raster/IndexedSurface.ts';

describe('IndexedSurface', () => {
  it('clears to a given index (default 0)', () => {
    const s = new IndexedSurface(3, 2);
    s.clear(5);
    expect(Array.from(s.data)).toEqual([5, 5, 5, 5, 5, 5]);
  });

  it('replace blit overwrites destination pixels unconditionally', () => {
    const s = new IndexedSurface(4, 4);
    const src = { data: new Uint8Array([1, 2, 3, 4]), width: 2, height: 2 };
    s.blit(src, 0, 0, 2, 2, 1, 1, false, 'replace');
    // prettier-ignore
    expect(Array.from(s.data)).toEqual([
      0, 0, 0, 0,
      0, 1, 2, 0,
      0, 3, 4, 0,
      0, 0, 0, 0,
    ]);
  });

  it('mirrorX reverses column order within the copied rectangle exactly', () => {
    const s = new IndexedSurface(2, 1);
    const src = { data: new Uint8Array([1, 2, 3]), width: 3, height: 1 };
    s.blit(src, 0, 0, 2, 1, 0, 0, true, 'replace');
    // Unmirrored, columns 0..1 of the source (1,2) would land as [1,2].
    // Mirrored, the same 2-wide window reads back to front: [2,1].
    expect(Array.from(s.data)).toEqual([2, 1]);
  });

  it('mask blit only writes where the mask plane says opaque', () => {
    const s = new IndexedSurface(3, 1);
    s.clear(9);
    const src = {
      data: new Uint8Array([1, 2, 3]),
      mask: new Uint8Array([1, 0, 1]),
      width: 3,
      height: 1,
    };
    s.blit(src, 0, 0, 3, 1, 0, 0, false, 'mask');
    expect(Array.from(s.data)).toEqual([1, 9, 3]);
  });

  it('mask blit with no mask plane behaves like replace (everywhere opaque)', () => {
    const s = new IndexedSurface(3, 1);
    s.clear(9);
    const src = { data: new Uint8Array([1, 2, 3]), width: 3, height: 1 };
    s.blit(src, 0, 0, 3, 1, 0, 0, false, 'mask');
    expect(Array.from(s.data)).toEqual([1, 2, 3]);
  });

  it('or blit bitwise-ORs the destination index with the source', () => {
    const s = new IndexedSurface(2, 1);
    s.clear(0b0101);
    const src = { data: new Uint8Array([0b1010, 0b0011]), width: 2, height: 1 };
    s.blit(src, 0, 0, 2, 1, 0, 0, false, 'or');
    expect(Array.from(s.data)).toEqual([0b1111, 0b0111]);
  });

  it('clips a destination rectangle that runs off two edges', () => {
    const s = new IndexedSurface(2, 2);
    const src = { data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), width: 3, height: 3 };
    // Source is 3x3, dest offset (-1,-1): the source's row 0 and column 0
    // fall off the top/left edges of a 2x2 surface, leaving the bottom-right
    // 2x2 of the source (values 5,6,8,9) visible at surface (0,0)-(1,1).
    s.blit(src, 0, 0, 3, 3, -1, -1, false, 'replace');
    expect(Array.from(s.data)).toEqual([5, 6, 8, 9]);
  });

  it('clips a source rectangle that runs past the source buffer bounds', () => {
    const s = new IndexedSurface(4, 1);
    s.clear(9);
    const src = { data: new Uint8Array([1, 2]), width: 2, height: 1 };
    // Ask for a 4-wide read from a 2-wide source: columns 2,3 are out of the source and must be skipped, not read garbage.
    s.blit(src, 0, 0, 4, 1, 0, 0, false, 'replace');
    expect(Array.from(s.data)).toEqual([1, 2, 9, 9]);
  });
});
