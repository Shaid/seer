import { describe, it, expect } from 'vitest';
import {
  BLKTIGER_BACKDROP_PEN,
  BLKTIGER_VISIBLE_Y0,
  BlktigerRenderer,
  BlktigerVideo,
  blktigerBgFrontTable,
  blktigerBgTileIndex,
  blktigerFrameToRgba,
  blktigerPaletteToRgba,
  decodeBlktigerPaletteEntry,
  type BlktigerBoardState,
  type BlktigerFrame,
  type BlktigerGfx,
  type BlktigerProms,
} from '../capcom/blktiger-video.js';

/**
 * Synthetic-data tests. The PROMs are rebuilt from the byte-exact structure
 * the kolbold notes give for the real chips (bd02: 32-byte bins 1,2,3,0..;
 * bd01: the comparator formula of DS §5.4), so the priority split exercised
 * here is the real one.
 */
function makeProms(): BlktigerProms {
  const bd02 = new Uint8Array(256);
  for (let a = 0; a < 256; a++) bd02[a] = [1, 2, 3][a >> 5] ?? 0;
  const bd01 = new Uint8Array(256);
  for (let a = 0; a < 256; a++) {
    const n = a & 0xf;
    const p = (a >> 4) & 3;
    if (a & 0x80) bd01[a] = 0xf;
    else if (!(a & 0x40)) bd01[a] = n === 0xf ? 0 : 2;
    else bd01[a] = n >= (16 - 4 * p) % 16 ? 9 : 2;
  }
  return { bd01, bd02 };
}

const SOLID_BASE = 0x10; // tiles 0x10..0x1f: solid pen (code & 15)
const GRADIENT = 0x20; // pixel (x,y) = pen x (x = 15 -> transparent column)
const CORNER = 0x21; // pen 1 at (0,0), else pen 15

function makeGfx(): BlktigerGfx {
  const tiles = new Uint8Array(2048 * 256).fill(15);
  const sprites = new Uint8Array(2048 * 256).fill(15);
  const chars = new Uint8Array(2048 * 64).fill(3);
  for (const g of [tiles, sprites]) {
    for (let pen = 0; pen < 16; pen++) g.fill(pen, (SOLID_BASE + pen) * 256, (SOLID_BASE + pen + 1) * 256);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) g[GRADIENT * 256 + y * 16 + x] = x;
    g[CORNER * 256] = 1;
  }
  // A bg tile above code 0x700 to check the attr code bits.
  tiles.fill(7, 0x712 * 256, 0x713 * 256);
  // Glyph 0x41: pens 0,1,2,3 in columns 0-1, 2-3, 4-5, 6-7. Glyph 0x541 (page 5): pen 2.
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) chars[0x41 * 64 + y * 8 + x] = x >> 1;
  chars.fill(2, 0x541 * 64, 0x542 * 64);
  return { chars, tiles, sprites };
}

const gfx = makeGfx();
const proms = makeProms();

function blankState(over: Partial<BlktigerBoardState> = {}): BlktigerBoardState {
  const bgRam = new Uint8Array(0x4000);
  // Every cell: tile code 0 = all pen 15 (transparent).
  return {
    bgRam,
    textRam: new Uint8Array(0x800),
    spriteRam: offscreenSprites(),
    paletteRam: new Uint8Array(0x800),
    scrollX: 0,
    scrollY: 0,
    screenLayout: 1,
    bgEnabled: true,
    spritesEnabled: true,
    textEnabled: true,
    ...over,
  };
}

/** Sprite RAM with every entry parked off the bottom (y = 0xf8 + 16 rows -> fully below line 239). */
function offscreenSprites(): Uint8Array {
  const ram = new Uint8Array(0x200);
  for (let n = 0; n < 128; n++) {
    ram[n * 4] = 0x00;
    ram[n * 4 + 2] = 0xf8;
  }
  return ram;
}

function setBg(s: BlktigerBoardState, col: number, row: number, code: number, group: number, flipX = false): void {
  const ti = blktigerBgTileIndex(col, row, s.screenLayout) * 2;
  s.bgRam[ti] = code & 0xff;
  s.bgRam[ti + 1] = ((code >> 8) & 7) | (group << 3) | (flipX ? 0x80 : 0);
}

function setSprite(s: BlktigerBoardState, n: number, code: number, color: number, x: number, y: number, flipX = false): void {
  const xx = x & 0x1ff;
  s.spriteRam[n * 4] = code & 0xff;
  s.spriteRam[n * 4 + 1] = ((code >> 3) & 0xe0) | (xx & 0x100 ? 0x10 : 0) | (flipX ? 0x08 : 0) | (color & 7);
  s.spriteRam[n * 4 + 2] = y & 0xff;
  s.spriteRam[n * 4 + 3] = xx & 0xff;
}

const at = (f: BlktigerFrame, x: number, y: number) => f.pixels[y * f.width + x];

describe('blktiger video: layers and backdrop', () => {
  const r = new BlktigerRenderer(gfx, proms);

  it('an empty board (all bg pen 15, no sprites, text pen 3) is the backdrop pen 1023', () => {
    const f = r.render(blankState());
    expect(f.width).toBe(256);
    expect(f.height).toBe(224);
    expect(f.pixels.every((p) => p === BLKTIGER_BACKDROP_PEN)).toBe(true);
  });

  it('text over bg over sprite over backdrop, with each layer switched off in turn', () => {
    const s = blankState();
    // cell (0,1) covers screen rows 0..15 at scroll 0 (window starts at raster line 16)
    setBg(s, 0, 1, SOLID_BASE + 5, 0); // group 0: pen 5 in front of sprites
    setSprite(s, 0, SOLID_BASE + 9, 2, 0, BLKTIGER_VISIBLE_Y0);
    const ti = (BLKTIGER_VISIBLE_Y0 >> 3) * 32; // text row 2 = screen row 0
    s.textRam[ti] = 0x41;
    s.textRam[ti + 0x400] = 0x07; // page 0, colour 7
    let f = r.render(s);
    expect(at(f, 0, 0)).toBe(0x300 + 7 * 4 + 0); // text pen 0
    expect(at(f, 6, 0)).toBe(5); // text pen 3 transparent -> bg group 0 pen 5
    s.textEnabled = false;
    f = r.render(s);
    expect(at(f, 0, 0)).toBe(5);
    s.bgEnabled = false;
    f = r.render(s);
    expect(at(f, 0, 0)).toBe(0x200 + 2 * 16 + 9);
    s.spritesEnabled = false;
    f = r.render(s);
    expect(at(f, 0, 0)).toBe(BLKTIGER_BACKDROP_PEN);
  });

  it('text code takes page bits from attr 0xe0 and is not scrolled', () => {
    const s = blankState({ scrollX: 123, scrollY: 77 });
    const ti = ((BLKTIGER_VISIBLE_Y0 + 8) >> 3) * 32 + 3; // screen (24..31, 8..15)
    s.textRam[ti] = 0x41;
    s.textRam[ti + 0x400] = 0xa0 | 0x1f; // page 5 -> glyph 0x541, colour 31
    const f = r.render(s);
    expect(at(f, 24, 8)).toBe(0x300 + 31 * 4 + 2);
    expect(at(f, 31, 15)).toBe(0x300 + 31 * 4 + 2);
    expect(at(f, 23, 8)).toBe(BLKTIGER_BACKDROP_PEN);
  });
});

describe('blktiger video: bg tilemap', () => {
  const r = new BlktigerRenderer(gfx, proms);

  it('scan formulas place pages 8x4 (128x64) or 4x8 (64x128)', () => {
    expect(blktigerBgTileIndex(16, 0, 1)).toBe(0x100);
    expect(blktigerBgTileIndex(0, 16, 1)).toBe(0x800);
    expect(blktigerBgTileIndex(127, 63, 1)).toBe(0x1fff);
    expect(blktigerBgTileIndex(16, 0, 0)).toBe(0x100);
    expect(blktigerBgTileIndex(0, 16, 0)).toBe(0x400);
    expect(blktigerBgTileIndex(63, 127, 0)).toBe(0x1fff);
    // wraps
    expect(blktigerBgTileIndex(128, 64, 1)).toBe(0);
    expect(blktigerBgTileIndex(64, 128, 0)).toBe(0);
  });

  it('code bits 8-10 come from attr, colour from attr bits 3-6', () => {
    const s = blankState();
    setBg(s, 0, 1, 0x712, 13);
    const f = r.render(s);
    expect(at(f, 0, 0)).toBe(13 * 16 + 7);
  });

  it('scroll moves the map and the visible window starts at raster line 16', () => {
    const s = blankState({ scrollX: 40, scrollY: 80 });
    setBg(s, 2, 7, CORNER, 3); // pixel (32, 112) of the map
    const f = r.render(s);
    expect(f.pixels.every((p) => p === BLKTIGER_BACKDROP_PEN)).toBe(true); // x = -8: off screen
    s.scrollX = 30;
    const g = r.render(s);
    expect(at(g, 2, 112 - 80 - BLKTIGER_VISIBLE_Y0)).toBe(3 * 16 + 1);
    let n = 0;
    for (const p of g.pixels) if (p !== BLKTIGER_BACKDROP_PEN) n++;
    expect(n).toBe(1);
  });

  it('scroll wraps at 2048 x 1024 in the 8x4 layout', () => {
    const s = blankState({ scrollX: 2048 - 8, scrollY: 1024 - BLKTIGER_VISIBLE_Y0 - 8 });
    setBg(s, 127, 63, SOLID_BASE + 1, 0);
    setBg(s, 0, 0, SOLID_BASE + 2, 0);
    const f = r.render(s);
    expect(at(f, 7, 7)).toBe(1); // last cell of the map
    expect(at(f, 8, 8)).toBe(2); // first cell, after the wrap in both axes
    expect(at(f, 8, 7)).toBe(BLKTIGER_BACKDROP_PEN);
    // the 16-bit register wraps the same way
    const g = r.render({ ...s, scrollX: s.scrollX + 2048 * 3, scrollY: s.scrollY + 1024 * 5 });
    expect(g.pixels).toEqual(f.pixels);
  });

  it('scroll wraps at 1024 x 2048 in the 4x8 layout', () => {
    const s = blankState({ screenLayout: 0, scrollX: 1024 - 8, scrollY: 2048 - BLKTIGER_VISIBLE_Y0 - 8 });
    setBg(s, 63, 127, SOLID_BASE + 1, 0);
    setBg(s, 0, 0, SOLID_BASE + 2, 0);
    const f = r.render(s);
    expect(at(f, 7, 7)).toBe(1);
    expect(at(f, 8, 8)).toBe(2);
  });

  it('flip X mirrors the tile', () => {
    const s = blankState();
    setBg(s, 0, 1, GRADIENT, 1);
    setBg(s, 1, 1, GRADIENT, 1, true);
    const f = r.render(s);
    for (let x = 0; x < 15; x++) expect(at(f, x, 3)).toBe(16 + x);
    expect(at(f, 15, 3)).toBe(BLKTIGER_BACKDROP_PEN); // pen 15
    expect(at(f, 16, 3)).toBe(BLKTIGER_BACKDROP_PEN);
    for (let x = 1; x < 16; x++) expect(at(f, 16 + x, 3)).toBe(16 + 15 - x);
  });
});

describe('blktiger video: bg-vs-sprite priority (bd02 -> bd01)', () => {
  const r = new BlktigerRenderer(gfx, proms);

  it('front table equals the MAME split_table + front-half transmasks', () => {
    const split = [3, 3, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const masks = [0xffff, 0xfff0, 0xff00, 0xf000];
    const t = blktigerBgFrontTable(proms);
    for (let g = 0; g < 16; g++) for (let pen = 0; pen < 15; pen++) expect(t[g * 16 + pen], `g${g} p${pen}`).toBe((masks[split[g]] >> pen) & 1 ? 0 : 1);
  });

  it.each([
    [0, 11, true],
    [0, 12, false],
    [2, 7, true],
    [2, 8, false],
    [4, 3, true],
    [4, 4, false],
    [6, 0, false],
    [15, 14, false],
  ])('group %i pen %i in front of sprites: %s', (group, pen, front) => {
    const s = blankState();
    setBg(s, 0, 1, SOLID_BASE + pen, group);
    setSprite(s, 0, SOLID_BASE + 9, 1, 0, BLKTIGER_VISIBLE_Y0);
    const f = r.render(s);
    expect(at(f, 4, 4)).toBe(front ? group * 16 + pen : 0x200 + 16 + 9);
    // without a sprite, a behind pixel still shows over the backdrop
    s.spriteRam = offscreenSprites();
    expect(at(r.render(s), 4, 4)).toBe(group * 16 + pen);
  });

  it('a transparent sprite pixel shows the behind bg; bg pen 15 shows the sprite', () => {
    const s = blankState();
    setBg(s, 0, 1, SOLID_BASE + 12, 0); // behind
    setSprite(s, 0, CORNER, 3, 0, BLKTIGER_VISIBLE_Y0);
    setBg(s, 2, 1, SOLID_BASE + 15, 0); // transparent bg
    setSprite(s, 1, SOLID_BASE + 4, 3, 32, BLKTIGER_VISIBLE_Y0);
    const f = r.render(s);
    expect(at(f, 0, 0)).toBe(0x200 + 3 * 16 + 1);
    expect(at(f, 1, 0)).toBe(12);
    expect(at(f, 33, 1)).toBe(0x200 + 3 * 16 + 4);
  });

  it('rejects short PROMs', () => {
    expect(() => blktigerBgFrontTable({ bd01: new Uint8Array(16), bd02: proms.bd02 })).toThrow();
  });
});

describe('blktiger video: sprites', () => {
  const r = new BlktigerRenderer(gfx, proms);
  const spriteOnly = () => blankState({ bgEnabled: false });

  it('entry 0 is drawn on top of later entries', () => {
    const s = spriteOnly();
    setSprite(s, 0, SOLID_BASE + 1, 0, 10, 50);
    setSprite(s, 5, SOLID_BASE + 2, 0, 18, 50);
    const f = r.render(s);
    const y = 50 - BLKTIGER_VISIBLE_Y0;
    expect(at(f, 17, y)).toBe(0x201);
    expect(at(f, 18, y)).toBe(0x201);
    expect(at(f, 26, y)).toBe(0x202);
  });

  it('code bits 8-10 from attr 0xe0, colour attr & 7, flip X attr & 8', () => {
    const s = spriteOnly();
    const sprites = gfx.sprites.slice();
    sprites.fill(6, 0x6a0 * 256, 0x6a1 * 256);
    const r2 = new BlktigerRenderer({ ...gfx, sprites }, proms);
    setSprite(s, 0, 0x6a0, 5, 0, 40);
    setSprite(s, 1, GRADIENT, 7, 100, 40);
    setSprite(s, 2, GRADIENT, 7, 140, 40, true);
    const f = r2.render(s);
    const y = 40 - BLKTIGER_VISIBLE_Y0;
    expect(at(f, 0, y)).toBe(0x200 + 5 * 16 + 6);
    expect(at(f, 103, y)).toBe(0x200 + 7 * 16 + 3);
    expect(at(f, 140, y)).toBe(BLKTIGER_BACKDROP_PEN); // flipped pen 15 column
    expect(at(f, 141, y)).toBe(0x200 + 7 * 16 + 14);
    expect(at(f, 155, y)).toBe(0x200 + 7 * 16 + 0);
  });

  it('attr bit 4 makes X negative; sprites clip at every edge and never wrap', () => {
    const s = spriteOnly();
    setSprite(s, 0, SOLID_BASE + 1, 0, -6, 60); // x = 0xfa - 0x100
    setSprite(s, 1, SOLID_BASE + 2, 0, 250, 80); // 6 columns visible on the right
    setSprite(s, 2, SOLID_BASE + 3, 0, 100, BLKTIGER_VISIBLE_Y0 - 10); // 6 rows visible at the top
    setSprite(s, 3, SOLID_BASE + 4, 0, 140, BLKTIGER_VISIBLE_Y0 + 224 - 4); // 4 rows visible at the bottom
    const f = r.render(s);
    const count = (pen: number) => f.pixels.filter((p) => p === pen).length;
    expect(count(0x201)).toBe(10 * 16);
    expect(at(f, 9, 60 - BLKTIGER_VISIBLE_Y0)).toBe(0x201);
    expect(at(f, 10, 60 - BLKTIGER_VISIBLE_Y0)).toBe(BLKTIGER_BACKDROP_PEN);
    expect(count(0x202)).toBe(6 * 16);
    expect(count(0x203)).toBe(16 * 6);
    expect(at(f, 100, 5)).toBe(0x203);
    expect(count(0x204)).toBe(16 * 4);
    expect(at(f, 140, 223)).toBe(0x204);
  });

  it('BlktigerVideo draws the sprite list latched at vblank, not live sprite RAM', () => {
    const v = new BlktigerVideo(gfx, proms);
    v.bgEnabled = false;
    v.spriteRam.set(offscreenSprites());
    v.vblank();
    const write = (n: number, bytes: number[]) => bytes.forEach((b, i) => v.writeMemory(0xfe00 + n * 4 + i, b));
    write(0, [SOLID_BASE + 1, 0, 50, 20]);
    expect(at(v.render(), 20, 50 - BLKTIGER_VISIBLE_Y0)).toBe(BLKTIGER_BACKDROP_PEN);
    v.vblank();
    expect(at(v.render(), 20, 50 - BLKTIGER_VISIBLE_Y0)).toBe(0x201);
  });
});

describe('blktiger video: board registers and palette', () => {
  it('memory writes reach bg RAM through the selected bank; ports set scroll, layout and enables', () => {
    const v = new BlktigerVideo(gfx, proms);
    expect(v.writePort(0x0d, 2)).toBe(true);
    v.writeMemory(0xc010, 0x34);
    v.writeMemory(0xc011, 0x55);
    expect(v.bgRam[0x2010]).toBe(0x34);
    expect(v.bgRam[0x2011]).toBe(0x55);
    v.writePort(0x08, 0x34);
    v.writePort(0x09, 0x12);
    v.writePort(0x0a, 0x78);
    v.writePort(0x0b, 0x05);
    expect([v.scrollX, v.scrollY]).toEqual([0x1234, 0x0578]);
    v.writePort(0x0e, 1);
    expect(v.screenLayout).toBe(1);
    v.writePort(0x0c, 0x06);
    expect([v.bgEnabled, v.spritesEnabled]).toEqual([false, false]);
    v.writePort(0x0c, 0x00);
    expect([v.bgEnabled, v.spritesEnabled]).toEqual([true, true]);
    v.writePort(0x04, 0x80);
    expect(v.textEnabled).toBe(false);
    expect(v.writePort(0x00, 1)).toBe(false);
    expect(v.writeMemory(0xe000, 1)).toBe(false);
    v.writeMemory(0xd805, 0x5a);
    v.writeMemory(0xdc05, 0xf3);
    expect(Array.from(v.paletteRgba().subarray(20, 24))).toEqual([0x55, 0xaa, 0x33, 255]);
  });

  it('palette entry = lo high nibble R, lo low nibble G, hi low nibble B, nibble-replicated', () => {
    expect(decodeBlktigerPaletteEntry(0x00, 0x00)).toEqual([0, 0, 0]);
    expect(decodeBlktigerPaletteEntry(0xff, 0x0f)).toEqual([255, 255, 255]);
    expect(decodeBlktigerPaletteEntry(0x10, 0xf0)).toEqual([0x11, 0, 0]);
    const ram = new Uint8Array(0x800);
    ram[0x3ff] = 0x21;
    ram[0x7ff] = 0x03;
    const rgba = blktigerPaletteToRgba(ram);
    expect(Array.from(rgba.subarray(0x3ff * 4))).toEqual([0x22, 0x11, 0x33, 255]);
    const f: BlktigerFrame = { width: 1, height: 1, pixels: Uint16Array.of(0x3ff) };
    expect(Array.from(blktigerFrameToRgba(f, rgba))).toEqual([0x22, 0x11, 0x33, 255]);
  });

  it('rejects undersized graphics', () => {
    expect(() => new BlktigerRenderer({ ...gfx, tiles: new Uint8Array(256) }, proms)).toThrow();
  });
});
