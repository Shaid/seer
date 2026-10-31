import { describe, it, expect } from 'vitest';
import {
  parseTim,
  parseTimIndexed,
  resolveTexPageRef,
  texRefSourcePixel,
  renderTimRow,
  tryParseTim,
  scanTimImages,
  decodeTimToRGBA,
  decodeBGR555,
  bgr555ToRgba,
  type TexPageRef,
} from '../tim.js';

/** Build a minimal 8bpp+CLUT TIM: 2x1 pixels, 2-color palette. */
function buildTim8bppClut(): Uint8Array {
  const clutColors = [0x0000, 0x001f]; // index 0 = key-color black, index 1 = bright red (BGR555)
  const clutSize = 4 + 8 + clutColors.length * 2; // 16
  const pixels = [0, 1]; // 2 pixels, 1 byte/pixel (8bpp)
  const imgSize = 12 + pixels.length; // 14

  const buf = new Uint8Array(8 + clutSize + imgSize);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x10, true);
  view.setUint32(4, 0x09, true); // flag: mode=1 (8bpp), CLUT present

  let off = 8;
  view.setUint32(off, clutSize, true);
  view.setUint16(off + 4, 0, true);
  view.setUint16(off + 6, 0, true);
  view.setUint16(off + 8, clutColors.length, true);
  view.setUint16(off + 10, 1, true);
  clutColors.forEach((c, i) => view.setUint16(off + 12 + i * 2, c, true));
  off += clutSize;

  view.setUint32(off, imgSize, true);
  view.setUint16(off + 4, 0, true);
  view.setUint16(off + 6, 0, true);
  view.setUint16(off + 8, 1, true); // imgWRaw (halfwords) -> actual width 2
  view.setUint16(off + 10, 1, true);
  pixels.forEach((p, i) => (buf[off + 12 + i] = p));

  return buf;
}

describe('parseTim (bgr555ToRgba pipeline)', () => {
  it('parses an 8bpp+CLUT image, de-halfword-scaling the declared width', () => {
    const tim = parseTim(buildTim8bppClut());
    expect(tim).not.toBeNull();
    expect(tim!.bpp).toBe(8);
    expect(tim!.hasClut).toBe(true);
    expect(tim!.width).toBe(2);
    expect(tim!.height).toBe(1);
    expect(tim!.palette).toHaveLength(2);
    expect(tim!.palette![0]).toEqual({ r: 0, g: 0, b: 0, a: 0, stp: false });
    expect(tim!.palette![1]).toEqual({ r: 248, g: 0, b: 0, a: 255, stp: false }); // <<3 scaling: 31<<3=248
    expect(Array.from(tim!.rgba.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(tim!.rgba.subarray(4, 8))).toEqual([248, 0, 0, 255]);
  });

  it('rejects a buffer with the wrong magic', () => {
    const buf = new Uint8Array(16);
    buf[0] = 0x42;
    expect(parseTim(buf)).toBeNull();
  });

  it('rejects a buffer with a non-zero high flag word (not a real TIM)', () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x10, true);
    view.setUint32(4, 0x11223344, true);
    expect(parseTim(buf)).toBeNull();
  });
});

function buildIndexedTim8bpp(opts: {
  imgX: number;
  imgY: number;
  clutX: number;
  clutY: number;
  width: number;
  height: number;
}): Uint8Array {
  const clutW = 16;
  const clutH = 2;
  const clutSize = 12 + clutW * clutH * 2;
  const imgWRaw = opts.width / 2;
  const imgSize = 12 + imgWRaw * 2 * opts.height;
  const buf = new Uint8Array(8 + clutSize + imgSize);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x10, true);
  view.setUint32(4, 0x09, true);

  let off = 8;
  view.setUint32(off, clutSize, true);
  view.setUint16(off + 4, opts.clutX, true);
  view.setUint16(off + 6, opts.clutY, true);
  view.setUint16(off + 8, clutW, true);
  view.setUint16(off + 10, clutH, true);
  for (let row = 0; row < clutH; row++) {
    for (let i = 0; i < clutW; i++) {
      const c = i === 0 ? 0x0000 : (row + 1) & 0x7fff;
      view.setUint16(off + 12 + (row * clutW + i) * 2, c, true);
    }
  }
  off += clutSize;

  view.setUint32(off, imgSize, true);
  view.setUint16(off + 4, opts.imgX, true);
  view.setUint16(off + 6, opts.imgY, true);
  view.setUint16(off + 8, imgWRaw, true);
  view.setUint16(off + 10, opts.height, true);
  for (let y = 0; y < opts.height; y++) {
    for (let x = 0; x < opts.width; x++) {
      buf[off + 12 + y * opts.width + x] = x % clutW;
    }
  }
  return buf;
}

describe('resolveTexPageRef / texRefSourcePixel / renderTimRow', () => {
  const tim = parseTimIndexed(
    buildIndexedTim8bpp({ imgX: 966, imgY: 256, clutX: 32, clutY: 500, width: 8, height: 4 }),
  )!;

  it('parses the fixture with the expected geometry', () => {
    expect(tim.bpp).toBe(8);
    expect(tim.width).toBe(8);
    expect(tim.height).toBe(4);
    expect(tim.x).toBe(966);
    expect(tim.clutH).toBe(2);
  });

  it('resolves a page selector against page-containment + CLUT-row-range, not a literal corner match', () => {
    const tex: TexPageRef = { uBase: 960, vBase: 256, colorMode: 1, clutX: 32, clutY: 501 };
    const resolved = resolveTexPageRef(tex, [tim]);
    expect(resolved).not.toBeNull();
    expect(resolved!.tim).toBe(tim);
    expect(resolved!.row).toBe(1);
  });

  it("rejects a selector whose CLUT row falls outside the TIM's own CLUT block", () => {
    const tex: TexPageRef = { uBase: 960, vBase: 256, colorMode: 1, clutX: 32, clutY: 502 };
    expect(resolveTexPageRef(tex, [tim])).toBeNull();
  });

  it('rejects a selector with the wrong colour mode (4bpp when the TIM is 8bpp)', () => {
    const tex: TexPageRef = { uBase: 960, vBase: 256, colorMode: 0, clutX: 32, clutY: 501 };
    expect(resolveTexPageRef(tex, [tim])).toBeNull();
  });

  it('computes the page-local source pixel, accounting for the TIM sitting off the page corner', () => {
    const tex: TexPageRef = { uBase: 960, vBase: 256, colorMode: 1, clutX: 32, clutY: 501 };
    expect(texRefSourcePixel(tex, 12, 0, tim)).toEqual({ sx: 0, sy: 0 });
    expect(texRefSourcePixel(tex, 15, 3, tim)).toEqual({ sx: 3, sy: 3 });
  });

  it('bakes one CLUT row into a standalone RGBA raster, index 0 transparent', () => {
    const row0 = renderTimRow(tim, 0);
    const row1 = renderTimRow(tim, 1);
    expect(row0).toHaveLength(tim.width * tim.height * 4);
    expect(Array.from(row0.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    const px = (buf: Uint8Array, x: number, y: number) =>
      Array.from(buf.subarray((y * tim.width + x) * 4, (y * tim.width + x) * 4 + 4));
    const c0 = px(row0, 1, 0);
    const c1 = px(row1, 1, 0);
    expect(c0[3]).toBe(255);
    expect(c0).not.toEqual(c1);
  });
});

// ---------------------------------------------------------------------------
// decodeBGR555 pipeline (tryParseTim/scanTimImages/decodeTimToRGBA).
// ---------------------------------------------------------------------------

function buildTim16(width: number, height: number, color555: number): Uint8Array {
  const headerLen = 12;
  const dataLen = width * height * 2;
  const buf = new Uint8Array(4 + 4 + headerLen + dataLen);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x10, true);
  view.setUint32(4, 0x2, true); // 16bpp, no CLUT
  view.setUint32(8, headerLen + dataLen, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint16(16, width, true);
  view.setUint16(18, height, true);
  for (let i = 0; i < width * height; i++) view.setUint16(20 + i * 2, color555, true);
  return buf;
}

function buildTim8(width: number, height: number, palette: number[], indices: number[]): Uint8Array {
  const clutW = palette.length;
  const clutLen = 12 + clutW * 2;
  const imgWHalfwords = width / 2;
  const buf = new Uint8Array(4 + 4 + clutLen + 12 + width * height);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x10, true);
  view.setUint32(4, 0x9, true);
  let pos = 8;
  view.setUint32(pos, clutLen, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, clutW, true);
  view.setUint16(pos + 10, 1, true);
  for (let i = 0; i < clutW; i++) view.setUint16(pos + 12 + i * 2, palette[i]!, true);
  pos += clutLen;
  view.setUint32(pos, 12 + width * height, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, imgWHalfwords, true);
  view.setUint16(pos + 10, height, true);
  for (let i = 0; i < indices.length; i++) buf[pos + 12 + i] = indices[i]!;
  return buf;
}

describe('decodeBGR555 / tryParseTim / decodeTimToRGBA', () => {
  it('decodeBGR555 treats pure black (0x0000) as transparent, scales channels to 0-255', () => {
    expect(decodeBGR555(0x0000)).toEqual([0, 0, 0, 0]);
    expect(decodeBGR555(0x001f)).toEqual([255, 0, 0, 255]); // *255/31 scaling: max red
    expect(decodeBGR555(0x7c00)).toEqual([0, 0, 255, 255]); // max blue
  });

  it('round-trips a synthetic 16bpp TIM record', () => {
    const buf = buildTim16(4, 3, 0x001f);
    const tim = tryParseTim(buf, 0);
    expect(tim).not.toBeNull();
    expect(tim!.width).toBe(4);
    expect(tim!.height).toBe(3);
    expect(tim!.end).toBe(buf.length);
    const rgba = decodeTimToRGBA(tim!);
    expect(rgba.length).toBe(4 * 3 * 4);
    for (let i = 0; i < 4 * 3; i++) {
      expect([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]]).toEqual([255, 0, 0, 255]);
    }
  });

  it('round-trips a synthetic 8bpp+CLUT TIM record and applies the palette', () => {
    const palette = [0x0000, 0x001f, 0x03e0, 0x7c00];
    const indices = [0, 1, 2, 3, 3, 2, 1, 0];
    const buf = buildTim8(8, 1, palette, indices);
    const tim = tryParseTim(buf, 0);
    expect(tim).not.toBeNull();
    expect(tim!.width).toBe(8);
    expect(tim!.clut?.w).toBe(4);
    const rgba = decodeTimToRGBA(tim!);
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 0, 0, 0]);
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([255, 0, 0, 255]);
    expect([rgba[8], rgba[9], rgba[10], rgba[11]]).toEqual([0, 255, 0, 255]);
    expect([rgba[12], rgba[13], rgba[14], rgba[15]]).toEqual([0, 0, 255, 255]);
  });

  it('rejects a buffer with the wrong magic', () => {
    expect(tryParseTim(new Uint8Array(32), 0)).toBeNull();
  });

  it('decodes a 24bpp record straight to opaque RGB', () => {
    const width = 2;
    const height = 1;
    const buf = new Uint8Array(8 + 12 + width * height * 3);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x10, true);
    view.setUint32(4, 0x3, true); // 24bpp, no CLUT
    view.setUint32(8, 12 + width * height * 3, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint16(16, 3, true); // imgW halfwords: 3 halfwords = 2 pixels at 24bpp
    view.setUint16(18, height, true);
    buf.set([10, 20, 30, 40, 50, 60], 20);
    const tim = tryParseTim(buf, 0)!;
    expect(tim.width).toBe(2);
    const rgba = decodeTimToRGBA(tim);
    expect(Array.from(rgba)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('scanTimImages finds back-to-back records with zero gap', () => {
    const a = buildTim16(2, 2, 0x1234);
    const b = buildTim16(3, 3, 0x5678);
    const combined = new Uint8Array(a.length + b.length);
    combined.set(a, 0);
    combined.set(b, a.length);
    const found = scanTimImages(combined);
    const starts = found.map((t) => t.start);
    expect(starts).toContain(0);
    expect(starts).toContain(a.length);
  });
});

describe('bgr555ToRgba STP bit', () => {
  it('exposes bit 15 as stp without changing the channels', () => {
    expect(bgr555ToRgba(0x801f, false)).toEqual({ r: 248, g: 0, b: 0, a: 255, stp: true });
    expect(bgr555ToRgba(0x001f, false).stp).toBe(false);
  });

  it('keeps key-colour transparency independent of stp', () => {
    expect(bgr555ToRgba(0x0000, true)).toEqual({ r: 0, g: 0, b: 0, a: 0, stp: false });
    expect(bgr555ToRgba(0x8000, true).a).toBe(255);
  });

  it('parseTimIndexed propagates each CLUT entry\'s STP bit into palette[i].stp', () => {
    const clutColors = [0x0000, 0x001f, 0x801f]; // key-colour, opaque red, STP-flagged red
    const clutSize = 4 + 8 + clutColors.length * 2;
    const pixels = [0, 1, 2];
    const imgSize = 12 + pixels.length;
    const buf = new Uint8Array(8 + clutSize + imgSize);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x10, true);
    view.setUint32(4, 0x09, true); // 8bpp + CLUT
    let off = 8;
    view.setUint32(off, clutSize, true);
    view.setUint16(off + 8, clutColors.length, true);
    view.setUint16(off + 10, 1, true);
    clutColors.forEach((c, i) => view.setUint16(off + 12 + i * 2, c, true));
    off += clutSize;
    view.setUint32(off, imgSize, true);
    view.setUint16(off + 8, 1, true); // imgWRaw halfwords -> width 3
    view.setUint16(off + 10, 1, true);
    pixels.forEach((p, i) => (buf[off + 12 + i] = p));

    const tim = parseTimIndexed(buf);
    expect(tim).not.toBeNull();
    expect(tim!.palette.map((c) => c.stp)).toEqual([false, false, true]);
  });
});
