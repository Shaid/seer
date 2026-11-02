import { describe, it, expect } from 'vitest';
import {
  CPS2_BACKDROP_PEN,
  CPS2_SCREEN_HEIGHT,
  CPS2_SCREEN_WIDTH,
  CPS_A,
  CPS_B,
  Cps2GfxRegion,
  Cps2PackedGfx,
  Cps2Renderer,
  Cps2Video,
  cps2BaseWord,
  cps2FrameToRgba,
  cps2LayerPlan,
  cps2PaletteToRgba,
  cps2TilemapIndex,
  decodeCps2LayerControl,
  type Cps2Gfx,
} from '../capcom/cps2-video.js';
import { CPS1_LAYOUT_16X16, CPS1_LAYOUT_8X8_2, cps2ScrollBankMap, decodeTile } from '../capcom/gfx.js';
import { decodeCps1PaletteWord } from '../capcom/palette.js';

/**
 * Synthetic-data tests for the CPS2 board renderer. Physical tile codes are
 * built with the same `cps2ScrollBankMap` the renderer uses, so a raw code
 * `c` written to SCROLLn RAM selects synthetic tile `map(c)`.
 */
const SOLID = 0x10; // raw codes 0x10..0x1f: solid pen (code & 15)
const GRADIENT = 0x20; // pixel (x,y) = pen x % 16 (pen 15 = transparent column)
const CORNER = 0x21; // pen 1 at (0,0), else 15

function synthTile(raw: number, size: number): Uint8Array | null {
  const t = new Uint8Array(size * size).fill(15);
  if (raw >= SOLID && raw < SOLID + 16) t.fill(raw & 15);
  else if (raw === GRADIENT) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t[y * size + x] = x % 16;
  else if (raw === CORNER) t[0] = 1;
  else return null;
  return t;
}

/** Synthetic gfx: tilemap layers see raw codes through the CPS2 bank map; sprites use raw 16x16 codes directly. */
const gfx: Cps2Gfx = {
  tile8: (code, set) => {
    const t = synthTile(code - cps2ScrollBankMap(0, 'scroll1'), 8);
    if (t && code - cps2ScrollBankMap(0, 'scroll1') === GRADIENT && set === 1) t.fill(3); // set 1 = the other half
    return t;
  },
  tile16: (code) => synthTile(code >= 0x10000 ? code - cps2ScrollBankMap(0, 'scroll2') : code, 16),
  tile32: (code) => synthTile(code - cps2ScrollBankMap(0, 'scroll3'), 32),
};

const BASES = { scroll1: 0x9100, scroll2: 0x9140, scroll3: 0x9180, palette: 0x91c0, other: 0x9200 };

/** A board set up the way both games boot it (DS §3.5 base literals; videocontrol 0x0e; OBJ offsets 0x40/0x10). */
function board(layerControl = 0x12ce): Cps2Video {
  const v = new Cps2Video(gfx);
  const a = (r: number, val: number) => v.write16(0x804100 + 2 * r, val);
  a(CPS_A.SCROLL1_BASE, BASES.scroll1);
  a(CPS_A.SCROLL2_BASE, BASES.scroll2);
  a(CPS_A.SCROLL3_BASE, BASES.scroll3);
  a(CPS_A.OTHER_BASE, BASES.other);
  a(CPS_A.VIDEOCONTROL, 0x0e);
  v.write16(0x804166, layerControl);
  v.write16(0x804170, 0x3f);
  v.write16(0x400008, 0x40);
  v.write16(0x40000a, 0x10);
  v.write16(0x400004, 0x2355);
  // scroll registers so that tilemap (0,0) is the screen's top-left: X = -0x40, Y = -0x10
  for (const l of [0, 1, 2]) {
    a(CPS_A.SCROLL1_X + 2 * l, 0xffc0);
    a(CPS_A.SCROLL1_Y + 2 * l, 0xfff0);
  }
  // empty object list: entry 0 = end marker
  v.write16(0x708000 + 6, 0xff00);
  v.vblank();
  return v;
}

function tileAddr(layer: 1 | 2 | 3, col: number, row: number): number {
  const base = [0, BASES.scroll1, BASES.scroll2, BASES.scroll3][layer];
  return 0x900000 + cps2BaseWord(base, 0x4000) * 2 + cps2TilemapIndex(layer, col, row) * 4;
}

function putTile(v: Cps2Video, layer: 1 | 2 | 3, col: number, row: number, code: number, attr: number): void {
  const a = tileAddr(layer, col, row);
  v.write16(a, code);
  v.write16(a + 2, attr);
}

function pix(v: Cps2Video, x: number, y: number): number {
  return v.render().pixels[y * CPS2_SCREEN_WIDTH + x];
}

/** Palette index of SCROLLn bank b pen p. */
const pal = (layer: number, bank: number, pen: number) => (0x20 * layer + bank) * 16 + pen;

describe('layer control word (DS §6.15.7)', () => {
  it('decodes the boot / stage values: 0x12ce = scroll3, scroll2, sprites, scroll1; 0x1c8e puts scroll3 over the sprites', () => {
    expect(decodeCps2LayerControl(0x12ce)).toEqual({ order: [3, 2, 0, 1], scroll1: true, scroll2: true, scroll3: true });
    expect(decodeCps2LayerControl(0x138e).order).toEqual([2, 3, 0, 1]);
    expect(decodeCps2LayerControl(0x1c8e).order).toEqual([2, 0, 3, 1]);
    expect(decodeCps2LayerControl(0x12c6)).toMatchObject({ scroll1: true, scroll2: true, scroll3: false });
  });

  it('priority plan for 0x12ce with OBJ_PRI 0x2355: sprite priority 4 sits over scroll3/scroll2 and under scroll1', () => {
    const { layers, primasks } = cps2LayerPlan(0x12ce, 0x2355);
    expect(layers).toEqual([3, 2, 1]);
    // coverage values: 1 = scroll3 opaque, 2 = scroll2, 4 = scroll1 (combinations OR'd)
    const hidden = (prio: number, cov: number) => ((primasks[prio] >>> cov) & 1) === 1;
    expect(hidden(4, 1)).toBe(false);
    expect(hidden(4, 2)).toBe(false);
    expect(hidden(4, 4)).toBe(true);
    expect(hidden(4, 0)).toBe(false);
    expect(hidden(1, 1)).toBe(true); // low priority: behind every layer
    expect(hidden(1, 0)).toBe(false);
    expect(hidden(7, 4)).toBe(false); // top priority: in front of everything
    expect(primasks[0]).toBe(0xff); // priority 0 is never visible (MAME)
  });
});

describe('tilemap layers', () => {
  it('draws in layer-control order: the front layer wins, pen 15 shows through, black where nothing is opaque', () => {
    const v = board(0x12ce);
    putTile(v, 3, 0, 0, SOLID + 3, 0x02); // 32x32 at screen (0..31, 0..31)
    putTile(v, 2, 0, 0, GRADIENT, 0x01); // 16x16 at (0..15, 0..15): column 15 transparent
    expect(pix(v, 4, 4)).toBe(pal(2, 1, 4));
    expect(pix(v, 15, 4)).toBe(pal(3, 2, 3)); // scroll2 pen 15 -> scroll3 behind
    expect(pix(v, 20, 20)).toBe(pal(3, 2, 3));
    expect(pix(v, 40, 40)).toBe(CPS2_BACKDROP_PEN);
    v.write16(0x804166, 0x138e); // scroll2 behind scroll3
    expect(pix(v, 4, 4)).toBe(pal(3, 2, 3));
  });

  it('enable bits 1/2/3 and the render mask switch layers off', () => {
    const v = board(0x12ce);
    putTile(v, 3, 0, 0, SOLID + 3, 0);
    putTile(v, 2, 0, 0, SOLID + 5, 0);
    v.write16(0x804166, 0x12ca); // scroll2 off
    expect(pix(v, 1, 1)).toBe(pal(3, 0, 3));
    v.write16(0x804166, 0x12ce);
    v.renderMask.scroll3 = false;
    v.renderMask.scroll2 = false;
    expect(pix(v, 1, 1)).toBe(CPS2_BACKDROP_PEN);
  });

  it('scroll registers: screen (0,0) = tilemap (scrollX + 0x40, scrollY + 0x10), wrapping at the map size', () => {
    const v = board();
    putTile(v, 2, 5, 3, CORNER, 0x07);
    v.write16(0x804110, 5 * 16 - 0x40 - 10); // tile col 5 starts at screen x 10
    v.write16(0x804112, 3 * 16 - 0x10 - 20); // tile row 3 starts at screen y 20
    expect(pix(v, 10, 20)).toBe(pal(2, 7, 1));
    expect(pix(v, 11, 20)).toBe(CPS2_BACKDROP_PEN);
    // wrap: tilemap x 1024 + 5*16 is the same tile
    v.write16(0x804110, (5 * 16 + 1024 - 0x40 - 10) & 0xffff);
    expect(pix(v, 10, 20)).toBe(pal(2, 7, 1));
    // a 1-pixel scroll error moves it (null control)
    v.write16(0x804110, 5 * 16 - 0x40 - 11);
    expect(pix(v, 10, 20)).toBe(CPS2_BACKDROP_PEN);
  });

  it('attr bit 5 flips X, bit 6 flips Y (16x16 and 32x32)', () => {
    const v = board();
    putTile(v, 2, 0, 0, CORNER, 0x20);
    expect(pix(v, 15, 0)).toBe(pal(2, 0, 1));
    putTile(v, 2, 0, 0, CORNER, 0x40);
    expect(pix(v, 0, 15)).toBe(pal(2, 0, 1));
    putTile(v, 2, 0, 0, CORNER, 0x60);
    expect(pix(v, 15, 15)).toBe(pal(2, 0, 1));
    putTile(v, 2, 0, 0, 0, 0);
    putTile(v, 3, 1, 1, CORNER, 0x60);
    expect(pix(v, 63, 63)).toBe(pal(3, 0, 1));
  });

  it('SCROLL1 8x8 tiles pick the gfx set by column parity', () => {
    const v = board();
    putTile(v, 1, 0, 0, GRADIENT, 0x03);
    putTile(v, 1, 1, 0, GRADIENT, 0x03);
    expect(pix(v, 2, 0)).toBe(pal(1, 3, 2)); // even column: set 0 (gradient)
    expect(pix(v, 8 + 2, 0)).toBe(pal(1, 3, 3)); // odd column: set 1 (synthetic: solid 3)
  });

  it('SCROLL2 row scroll (VIDEOCONTROL bit 0) shifts single lines by the OTHER_BASE table', () => {
    const v = board();
    putTile(v, 2, 0, 0, CORNER, 0);
    const other = 0x900000 + cps2BaseWord(BASES.other, 0x800) * 2;
    v.write16(0x804122, 0x0f);
    v.write16(other + 2 * 16, (-3) & 0xffff); // raster line 16 = screen line 0: shift by -3
    expect(pix(v, 3, 0)).toBe(pal(2, 0, 1));
    v.write16(0x804122, 0x0e);
    expect(pix(v, 0, 0)).toBe(pal(2, 0, 1));
  });
});

describe('palette', () => {
  it('a PALETTE_BASE write uploads the enabled shadow pages; the brightness nibble scales the colour', () => {
    const v = board();
    const base = 0x900000 + cps2BaseWord(BASES.palette, 0x400) * 2;
    v.write16(base + 2 * (0x400 + 5), 0xff00); // SCROLL2 page, entry 5: bright red
    v.write16(base + 2 * (0x400 + 6), 0x0f00); // same red at brightness 0
    expect(v.palette[0x405]).toBe(0);
    v.write16(0x80410a, BASES.palette);
    expect(v.palette[0x405]).toBe(0xff00);
    const rgba = v.paletteRgba();
    expect([...rgba.subarray(0x405 * 4, 0x405 * 4 + 4)]).toEqual([255, 0, 0, 255]);
    const dim = decodeCps1PaletteWord(0x0f00);
    expect(rgba[0x406 * 4]).toBe(dim.r);
    expect(dim.r).toBe(Math.round((255 * 15) / 45)); // brightness 0 = 1/3
    expect([...rgba.subarray(CPS2_BACKDROP_PEN * 4, CPS2_BACKDROP_PEN * 4 + 4)]).toEqual([0, 0, 0, 255]);
  });

  it('palette control: a disabled page is not copied; once a page was copied, skipped pages still consume their source', () => {
    const v = board();
    const base = 0x900000 + cps2BaseWord(BASES.palette, 0x400) * 2;
    for (let p = 0; p < 6; p++) v.write16(base + 2 * 0x200 * p, 0xf000 + p + 1);
    v.write16(0x804170, 0x3d); // page 1 off
    v.write16(0x80410a, BASES.palette);
    expect([v.palette[0], v.palette[0x200], v.palette[0x400]]).toEqual([0xf001, 0, 0xf003]);
    const w = new Cps2Video(gfx);
    w.writeWords(0x900000 + cps2BaseWord(BASES.palette, 0x400) * 2, [0xf00a]);
    w.write16(0x804170, 0x3e); // page 0 off before anything was copied: page 1 takes the first source page
    w.write16(0x80410a, BASES.palette);
    expect(w.palette[0x200]).toBe(0xf00a);
  });

  it('frame -> RGBA through the palette', () => {
    const v = board();
    putTile(v, 2, 0, 0, SOLID + 2, 0);
    const base = 0x900000 + cps2BaseWord(BASES.palette, 0x400) * 2;
    v.write16(base + 2 * 0x402, 0xf0f0);
    v.write16(0x80410a, BASES.palette);
    const rgba = cps2FrameToRgba(v.render(), cps2PaletteToRgba(v.palette));
    expect([...rgba.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    expect([...rgba.subarray(100 * 4 * CPS2_SCREEN_WIDTH, 100 * 4 * CPS2_SCREEN_WIDTH + 4)]).toEqual([0, 0, 0, 255]);
  });
});

describe('CPS2 objects', () => {
  /** Object `n` in the back buffer (0x708000 with bank 0), then swap banks and latch, as the games' double buffer does. */
  function objects(v: Cps2Video, list: number[][]): void {
    list.forEach((o, n) => o.forEach((w, k) => v.write16(0x708000 + n * 8 + k * 2, w)));
    v.write16(0x8040e0, v.objRamBank ^ 1);
    v.vblank();
  }

  it('position (X - 64 + OBJ offsets), colour bank from page 0, flips, clipping', () => {
    const v = board();
    objects(v, [
      [0x8000 | (64 + 10), 16 + 20, CORNER, 0x0003],
      [0x8000 | (64 + 100), 16 + 20, CORNER, 0x0063],
      [0x8000 | 60, 16, SOLID + 1, 0x0001], // 4 px off the left edge
      [0, 0x8000, 0, 0],
    ]);
    expect(pix(v, 10, 20)).toBe(3 * 16 + 1);
    expect(pix(v, 115, 35)).toBe(3 * 16 + 1);
    expect(pix(v, 0, 0)).toBe(16 + 1);
    expect(pix(v, 12, 0)).toBe(CPS2_BACKDROP_PEN);
  });

  it('end of list: Y >= 0x8000 or attr >= 0xff00 stops the list; an empty list draws nothing', () => {
    expect(Cps2Renderer.lastObjectWord(new Uint16Array(0x1000))).toBe(0x1000 - 4);
    const l = new Uint16Array(0x1000);
    l[8 + 3] = 0xff00;
    expect(Cps2Renderer.lastObjectWord(l)).toBe(4);
    l[4 + 1] = 0x8000;
    expect(Cps2Renderer.lastObjectWord(l)).toBe(0);
    const v = board();
    objects(v, [
      [0x8000 | 64, 16, SOLID + 1, 0],
      [0x8000 | 64, 16, SOLID + 2, 0xff00],
      [0x8000 | 64, 16, SOLID + 3, 0],
    ]);
    expect(pix(v, 0, 0)).toBe(1);
  });

  it('the last list entry is frontmost (MAME draws backwards and each sprite masks the later ones)', () => {
    const v = board();
    objects(v, [
      [0x8000 | 64, 16, SOLID + 1, 0],
      [0x8000 | 64, 16, SOLID + 2, 0],
      [0, 0x8000, 0, 0],
    ]);
    expect(pix(v, 0, 0)).toBe(2);
  });

  it('block sprites walk codes +1 across and +0x10 down; flip X reverses the walk', () => {
    const tiles: number[] = [];
    const pens: number[] = [];
    for (const c of [0x100, 0x101, 0x110, 0x111]) {
      tiles.push(c);
      pens.push(...new Array(256).fill(c & 0xf ? 2 : 1).map((p, i) => (c >= 0x110 && i === 0 ? 5 : p)));
    }
    const packed = new Cps2PackedGfx({ tile16: { codes: tiles, pens: Uint8Array.from(pens) } });
    const v = new Cps2Video(packed);
    v.write16(0x804166, 0x12ce);
    v.write16(0x400008, 0x40);
    v.write16(0x40000a, 0x10);
    v.write16(0x400004, 0x2355);
    objects(v, [[0x8000 | 64, 16, 0x100, 0x1100], [0, 0x8000, 0, 0]]);
    let f = v.render().pixels;
    const at = (x: number, y: number) => f[y * CPS2_SCREEN_WIDTH + x];
    expect([at(0, 0), at(16, 0), at(0, 16), at(17, 17)]).toEqual([1, 2, 5, 2]);
    objects(v, [[0x8000 | 64, 16, 0x100, 0x1120], [0, 0x8000, 0, 0]]);
    f = v.render().pixels;
    expect([at(0, 0), at(16, 0), at(31, 16)]).toEqual([2, 1, 5]);
  });

  it('Y bits 13-14 extend the tile code by 0x10000 / 0x20000 (DS §3.8 bank flag)', () => {
    const seen: number[] = [];
    const probe = new Cps2Video({ ...gfx, tile16: (c) => (seen.push(c), null) });
    probe.write16(0x708000, 0x8040);
    probe.write16(0x708002, 0x4010);
    probe.write16(0x708004, 0x1234);
    probe.write16(0x708008 + 2, 0x8000);
    probe.write16(0x8040e0, 1);
    probe.vblank();
    probe.render();
    expect(seen).toEqual([0x21234]);
  });

  it('sprite vs tilemap priority (OBJ_PRI 0x2355, layer 0x12ce): priority 4 over scroll2, under scroll1; priority 1 under all', () => {
    const v = board();
    putTile(v, 2, 0, 0, SOLID + 6, 0);
    putTile(v, 1, 0, 0, SOLID + 7, 0); // scroll1 covers only (0..7, 0..7)
    objects(v, [[0x8000 | 64, 16, SOLID + 9, 0], [0, 0x8000, 0, 0]]); // X bit 15 -> priority 4 (ddtod's builder)
    expect(pix(v, 10, 10)).toBe(9);
    expect(pix(v, 2, 2)).toBe(pal(1, 0, 7));
    objects(v, [[0x2000 | 64, 16, SOLID + 9, 0], [0, 0x8000, 0, 0]]); // priority 1
    expect(pix(v, 10, 10)).toBe(pal(2, 0, 6));
    expect(pix(v, 20, 20)).toBe(CPS2_BACKDROP_PEN);
  });

  it('the hardware draws the bank selected at vblank, not the one being written', () => {
    const v = board();
    v.write16(0x708000, 0x8000 | 64);
    v.write16(0x708002, 16);
    v.write16(0x708004, SOLID + 1);
    v.write16(0x708006, 0);
    v.write16(0x70800a, 0x8000);
    v.vblank(); // bank 0: displayed = objram1, our writes went to objram2
    expect(pix(v, 0, 0)).toBe(CPS2_BACKDROP_PEN);
    v.write16(0x8040e0, 1);
    v.vblank();
    expect(pix(v, 0, 0)).toBe(1);
  });
});

describe('gfx sources', () => {
  it('Cps2GfxRegion decodes with the CPS1 layouts; out-of-region codes are null', () => {
    const region = new Uint8Array(0x400);
    for (let i = 0; i < region.length; i++) region[i] = (i * 37) & 0xff;
    const g = new Cps2GfxRegion(region);
    expect(g.tile16(3)).toEqual(decodeTile(region, CPS1_LAYOUT_16X16, 3));
    expect(g.tile8(5, 1)).toEqual(decodeTile(region, CPS1_LAYOUT_8X8_2, 5));
    expect(g.tile16(8)).toBeNull();
    expect(g.tile32(2)).toBeNull();
  });

  it('Cps2PackedGfx keys 8x8 tiles by code*2+set and rejects short pen arrays', () => {
    const g = new Cps2PackedGfx({ tile8: { codes: [10 * 2 + 1], pens: new Uint8Array(64).fill(4) } });
    expect(g.tile8(10, 1)?.[0]).toBe(4);
    expect(g.tile8(10, 0)).toBeNull();
    expect(() => new Cps2PackedGfx({ tile32: { codes: [1], pens: new Uint8Array(10) } })).toThrow();
  });

  it('frame size is 384x224', () => {
    const f = board().render();
    expect([f.width, f.height, f.pixels.length]).toEqual([CPS2_SCREEN_WIDTH, CPS2_SCREEN_HEIGHT, CPS2_SCREEN_WIDTH * CPS2_SCREEN_HEIGHT]);
    expect(CPS_B.LAYER_CONTROL).toBe(0x13);
  });
});
