/**
 * M4 — hotspot picking (`walker-plan.md` "Mouse interactivity"): a synthetic
 * view with a known hotspot at a known surface position, and click
 * coordinates that should and shouldn't hit it.
 */
import { describe, expect, it } from 'vitest';
import { pickHotspot } from '../view/Hotspot.js';
import { paintOrder, topmostFirst, comparePaintOrder } from '../view/order.js';
import { PieceBank } from '../raster/PieceBank.js';
import type { DrawItem } from '../view/DrawItem.js';
import type { PieceBankLookup } from '../raster/composite.js';

// A 4x4 opaque-red atlas with two named frames: "wall" (0,0,4,2) and "plaque" (0,2,2,2).
const rgba = new Uint8Array(4 * 4 * 4).fill(0);
for (let i = 0; i < 4 * 4; i++) {
  rgba[i * 4] = 255;
  rgba[i * 4 + 3] = 255;
}
const atlas = {
  width: 4,
  height: 4,
  frames: [
    { name: 'wall', x: 0, y: 0, w: 4, h: 2 },
    { name: 'plaque', x: 0, y: 2, w: 2, h: 2 },
  ],
};
const bank = PieceBank.fromRGBA(rgba, 4, 4, atlas);
const banks: PieceBankLookup = { b: bank };

function item(overrides: Partial<DrawItem>): DrawItem {
  return {
    kind: 'prop',
    depth: 0,
    lateral: 0,
    bank: 'b',
    frame: 'plaque',
    destX: 0,
    destY: 0,
    blend: 'replace',
    ...overrides,
  };
}

describe('pickHotspot', () => {
  it('hits a hotspot piece at a coordinate inside its destination rect', () => {
    const plaque = item({ destX: 50, destY: 10, hotspot: { code: 0x6a } });
    const hit = pickHotspot([plaque], banks, 0, 51, 11);
    expect(hit).not.toBeNull();
    expect(hit!.hotspot).toEqual({ code: 0x6a });
    expect(hit!.item).toBe(plaque);
  });

  it('misses just outside the destination rect (plaque frame is 2x2 at (50,10): (52,10) is one column past the right edge)', () => {
    const plaque = item({ destX: 50, destY: 10, hotspot: { code: 0x6a } });
    expect(pickHotspot([plaque], banks, 0, 52, 10)).toBeNull();
    expect(pickHotspot([plaque], banks, 0, 50, 12)).toBeNull();
    expect(pickHotspot([plaque], banks, 0, 49, 10)).toBeNull();
  });

  it('ignores an item with no hotspot even when the click lands inside its rect', () => {
    const plain = item({ destX: 50, destY: 10 }); // no hotspot
    expect(pickHotspot([plain], banks, 0, 51, 11)).toBeNull();
  });

  it('returns null against an empty item list', () => {
    expect(pickHotspot([], banks, 0, 0, 0)).toBeNull();
  });

  it('picks the topmost (prop-over-front, same depth) piece when two hotspot rects overlap', () => {
    // Same depth (so kind, not depth, breaks the tie — see view/order.ts):
    // a "wall" front-wall hotspot and a "plaque" prop hotspot fully inside
    // it, overlapping at (1,1). Props paint after (on top of) walls at
    // equal depth, so the plaque must win here.
    const wall = item({
      kind: 'front',
      depth: 0,
      destX: 0,
      destY: 0,
      frame: 'wall',
      hotspot: { code: 0x64 },
    });
    const plaque = item({
      kind: 'prop',
      depth: 0,
      destX: 0,
      destY: 0,
      frame: 'plaque',
      hotspot: { code: 0x6a },
    });
    const hit = pickHotspot([wall, plaque], banks, 0, 1, 1);
    expect(hit!.hotspot.code).toBe(0x6a);
  });

  it("falls through to a farther hotspot when the click misses the nearer one's rect but hits the farther one's", () => {
    const wall = item({
      kind: 'front',
      depth: 1,
      destX: 0,
      destY: 0,
      frame: 'wall',
      hotspot: { code: 0x64 },
    }); // 4x2 rect
    const plaque = item({
      kind: 'prop',
      depth: 0,
      destX: 0,
      destY: 0,
      frame: 'plaque',
      hotspot: { code: 0x6a },
    }); // 2x2 rect
    const hit = pickHotspot([wall, plaque], banks, 0, 3, 0); // inside wall's rect, outside plaque's
    expect(hit!.hotspot.code).toBe(0x64);
  });

  it('returns null when the referenced bank is unknown', () => {
    const orphan = item({ destX: 0, destY: 0, bank: 'missing', hotspot: { code: 1 } });
    expect(pickHotspot([orphan], banks, 0, 0, 0)).toBeNull();
  });
});

describe('view/order paint order (shared with compositeDrawList)', () => {
  it("sorts nearest depth first, farthest last (on top — Black Crypt's own nested-wall-frame convention, see raster/composite.ts's module doc comment)", () => {
    const near = item({ depth: 0 });
    const far = item({ depth: 2 });
    expect(paintOrder([near, far])).toEqual([near, far]);
  });

  it('at equal depth: side before front before prop', () => {
    const side = item({ kind: 'side', depth: 1 });
    const front = item({ kind: 'front', depth: 1 });
    const prop = item({ kind: 'prop', depth: 1 });
    expect(paintOrder([prop, front, side])).toEqual([side, front, prop]);
  });

  it('topmostFirst is exactly paintOrder reversed', () => {
    const items = [item({ depth: 0 }), item({ depth: 1 }), item({ depth: 2 })];
    expect(topmostFirst(items)).toEqual([...paintOrder(items)].reverse());
  });

  it('comparePaintOrder is a valid comparator (antisymmetric on distinct items)', () => {
    const a = item({ depth: 0, kind: 'front' });
    const b = item({ depth: 1, kind: 'side' });
    expect(Math.sign(comparePaintOrder(a, b))).toBe(-Math.sign(comparePaintOrder(b, a)));
  });
});
