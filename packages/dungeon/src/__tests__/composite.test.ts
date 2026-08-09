import { describe, expect, it } from 'vitest';
import { IndexedSurface } from '../raster/IndexedSurface.js';
import { PieceBank } from '../raster/PieceBank.js';
import { compositeSlotTable } from '../raster/composite.js';
import type { SlotTableFile } from '../schema/slots.js';

// A tiny synthetic bank with one overlapping-rectangle-friendly frame per
// "depth", each a solid color, so composite ordering is directly observable
// in the resulting index buffer.
function makeBank(): PieceBank {
  const w = 4;
  const h = 1;
  // Two solid-color 1x1 pixel "frames" sharing one 4x1 atlas row.
  const rgba = new Uint8Array([
    255,
    0,
    0,
    255, // frameA: red
    0,
    255,
    0,
    255, // frameB: green
    0,
    0,
    255,
    255, // frameC: blue
    255,
    255,
    0,
    255, // frameD: yellow
  ]);
  const atlas = {
    width: w,
    height: h,
    frames: [
      { name: 'A', x: 0, y: 0, w: 1, h: 1 },
      { name: 'B', x: 1, y: 0, w: 1, h: 1 },
      { name: 'C', x: 2, y: 0, w: 1, h: 1 },
      { name: 'D', x: 3, y: 0, w: 1, h: 1 },
    ],
  };
  return PieceBank.fromRGBA(rgba, w, h, atlas);
}

describe('compositeSlotTable', () => {
  it('draws staticSlots first, then slots in painter-back-to-front order (nearest depth first, farthest last/on top)', () => {
    const bank = makeBank();
    const surface = new IndexedSurface(1, 1);

    // front:0:1 (far) and front:0:0 (near) both draw to the same pixel;
    // a farther depth's front-wall face nests inside (and must be drawn
    // after, i.e. on top of) the nearer, larger depth's face — see the
    // composite.ts module doc comment.
    const table: SlotTableFile = {
      schemaVersion: 1,
      surface: { width: 1, height: 1 },
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      depthCount: 2,
      lateralOffsets: [0],
      frontWallMaxDepth: 1,
      banks: [{ id: 'bank', atlas: 'a', image: 'b' }],
      slots: {
        'front:0:1': {
          draws: [{ bank: 'bank', frame: 'A', destX: 0, destY: 0, blend: 'replace' }],
        }, // red, far
        'front:0:0': {
          draws: [{ bank: 'bank', frame: 'B', destX: 0, destY: 0, blend: 'replace' }],
        }, // green, near
      },
      ordering: 'painter-back-to-front',
    };

    compositeSlotTable(surface, { bank }, table);
    // red (far, index for A) must win over green (near) — the far frame is drawn last, on top.
    expect(surface.data[0]).toBe(bank.index[bank.frame('A').y * bank.width + bank.frame('A').x]);
  });

  it('draws side before front at the same depth', () => {
    const bank = makeBank();
    const surface = new IndexedSurface(1, 1);

    const table: SlotTableFile = {
      schemaVersion: 1,
      surface: { width: 1, height: 1 },
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      depthCount: 1,
      lateralOffsets: [0],
      frontWallMaxDepth: 1,
      banks: [{ id: 'bank', atlas: 'a', image: 'b' }],
      slots: {
        'side:L:0': { draws: [{ bank: 'bank', frame: 'C', destX: 0, destY: 0, blend: 'replace' }] }, // blue
        'front:0:0': {
          draws: [{ bank: 'bank', frame: 'D', destX: 0, destY: 0, blend: 'replace' }],
        }, // yellow
      },
      ordering: 'painter-back-to-front',
    };

    compositeSlotTable(surface, { bank }, table);
    // front (D, yellow) must be drawn after side (C, blue) at the same depth.
    expect(surface.data[0]).toBe(bank.index[bank.frame('D').y * bank.width + bank.frame('D').x]);
  });

  it('respects staticSlots as an unconditional background layer', () => {
    const bank = makeBank();
    const surface = new IndexedSurface(1, 1);
    const table: SlotTableFile = {
      schemaVersion: 1,
      surface: { width: 1, height: 1 },
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      depthCount: 1,
      lateralOffsets: [0],
      frontWallMaxDepth: 1,
      banks: [{ id: 'bank', atlas: 'a', image: 'b' }],
      staticSlots: [
        { draws: [{ bank: 'bank', frame: 'A', destX: 0, destY: 0, blend: 'replace' }] },
      ],
      slots: {},
    };
    compositeSlotTable(surface, { bank }, table);
    expect(surface.data[0]).toBe(bank.index[bank.frame('A').y * bank.width + bank.frame('A').x]);
  });

  it('throws on an unrecognised bank id', () => {
    const bank = makeBank();
    const surface = new IndexedSurface(1, 1);
    const table: SlotTableFile = {
      schemaVersion: 1,
      surface: { width: 1, height: 1 },
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      depthCount: 1,
      lateralOffsets: [0],
      frontWallMaxDepth: 1,
      banks: [{ id: 'bank', atlas: 'a', image: 'b' }],
      slots: {
        'front:0:0': {
          draws: [{ bank: 'nope', frame: 'A', destX: 0, destY: 0, blend: 'replace' }],
        },
      },
    };
    expect(() => compositeSlotTable(surface, { bank }, table)).toThrow(/unknown bank/);
  });
});
