import { describe, it, expect } from 'vitest';
import { bresenhamLine, polygonEdges, scanlineFillPolygon } from '../raster.js';

/**
 * Golden values below were captured by running the pre-migration
 * originals' exact algorithm (Drakkhen's `vector.ts` private
 * `fillPolygonIndices`/`lineIndices`, byte-for-byte identical to
 * `map-render.ts`'s `fillPolygon`/`drawLine`) standalone against these
 * same inputs, before either copy was deleted in favour of this module —
 * not hand-derived. This pins the refactor to the original behaviour.
 */

function makeBuf(w: number, h: number) {
  const buf = new Uint8Array(w * h);
  const plot = (x: number, y: number) => {
    buf[y * w + x] = color;
  };
  let color = 0;
  return {
    buf,
    fill: (points: [number, number][], c: number) => {
      color = c;
      scanlineFillPolygon(points, w, h, plot);
    },
    line: (x0: number, y0: number, x1: number, y1: number, c: number) => {
      color = c;
      bresenhamLine(x0, y0, x1, y1, w, h, plot);
    },
  };
}

describe('scanlineFillPolygon', () => {
  it('fills a small scalene triangle matching the original algorithm exactly', () => {
    const w = 8;
    const h = 6;
    const { buf, fill } = makeBuf(w, h);
    fill(
      [
        [1, 1],
        [6, 2],
        [3, 5],
      ],
      7,
    );
    expect(Array.from(buf)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, //
      0, 0, 7, 7, 0, 0, 0, 0, //
      0, 0, 7, 7, 7, 7, 0, 0, //
      0, 0, 0, 7, 7, 0, 0, 0, //
      0, 0, 0, 7, 0, 0, 0, 0, //
      0, 0, 0, 0, 0, 0, 0, 0, //
    ]);
  });

  it('fills nothing when a horizontal edge leaves fewer than 3 usable edges', () => {
    // Two of the three points share a y coordinate, so that edge is
    // horizontal and dropped -- only 2 edges remain, below the `< 3`
    // threshold, so the fill bails out entirely. This is the original
    // algorithm's actual (if surprising) behaviour, preserved as-is.
    const w = 8;
    const h = 6;
    const { buf, fill } = makeBuf(w, h);
    fill(
      [
        [1, 1],
        [6, 1],
        [3, 5],
      ],
      7,
    );
    expect(Array.from(buf)).toEqual(new Array(w * h).fill(0));
  });

  it('drops horizontal edges from the edge list', () => {
    // A closed triangle with one horizontal side (y=1 to y=1) contributes
    // only its two non-horizontal edges.
    const edges = polygonEdges([
      [1, 1],
      [6, 1],
      [3, 5],
    ]);
    expect(edges).toHaveLength(2);
  });
});

describe('bresenhamLine', () => {
  it('draws a short line matching the original algorithm exactly', () => {
    const w = 10;
    const h = 10;
    const { buf, line } = makeBuf(w, h);
    line(1, 1, 7, 4, 3);
    expect(Array.from(buf)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
      0, 3, 3, 0, 0, 0, 0, 0, 0, 0, //
      0, 0, 0, 3, 3, 0, 0, 0, 0, 0, //
      0, 0, 0, 0, 0, 3, 3, 0, 0, 0, //
      0, 0, 0, 0, 0, 0, 0, 3, 0, 0, //
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
    ]);
  });

  it('clips a line whose endpoints fall outside the buffer', () => {
    const w = 6;
    const h = 6;
    const { buf, line } = makeBuf(w, h);
    line(-2, -2, 8, 8, 5);
    expect(Array.from(buf)).toEqual([
      5, 0, 0, 0, 0, 0, //
      0, 5, 0, 0, 0, 0, //
      0, 0, 5, 0, 0, 0, //
      0, 0, 0, 5, 0, 0, //
      0, 0, 0, 0, 5, 0, //
      0, 0, 0, 0, 0, 5, //
    ]);
  });
});
