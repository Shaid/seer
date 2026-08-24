import { describe, it, expect } from 'vitest';
import { decodePlanar, planarByteLength, planarByteOffset, type PlanarConfig } from '../planar.js';
import { expandColorWord, expandPalette, greyscaleRamp } from '../palette.js';
import { indicesToRGBA } from '../rgba.js';

/**
 * Reference encoders, written independently of planar.ts's offset formula
 * (per-layout, longhand) so the tests aren't circular: a bug in
 * `planarByteOffset` cannot cancel out against the same bug here.
 */

function makeImage(width: number, height: number, planes: number): Uint8Array {
  // Deterministic, uses every index at least once when width*height >= 2^planes.
  const img = new Uint8Array(width * height);
  const levels = 1 << planes;
  for (let i = 0; i < img.length; i++) img[i] = (i * 7 + (i >> 4)) % levels;
  return img;
}

function setBit(buf: Uint8Array, byteOffset: number, x: number) {
  buf[byteOffset] |= 1 << (7 - (x & 7));
}

function encodePlaneMajor(
  img: Uint8Array,
  width: number,
  height: number,
  planes: number,
  rowBytes = width >> 3,
  planeStride = rowBytes * height,
): Uint8Array {
  const buf = new Uint8Array((planes - 1) * planeStride + height * rowBytes);
  for (let p = 0; p < planes; p++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if ((img[y * width + x] >> p) & 1) {
          setBit(buf, p * planeStride + y * rowBytes + (x >> 3), x);
        }
      }
    }
  }
  return buf;
}

function encodeRowInterleaved(
  img: Uint8Array,
  width: number,
  height: number,
  planes: number,
  rowBytes = width >> 3,
): Uint8Array {
  const buf = new Uint8Array(height * rowBytes * planes);
  for (let y = 0; y < height; y++) {
    for (let p = 0; p < planes; p++) {
      for (let x = 0; x < width; x++) {
        if ((img[y * width + x] >> p) & 1) {
          setBit(buf, y * rowBytes * planes + p * rowBytes + (x >> 3), x);
        }
      }
    }
  }
  return buf;
}

function encodeWordInterleaved(
  img: Uint8Array,
  width: number,
  height: number,
  planes: number,
  interleave = 2,
  rowBytes = width >> 3,
): Uint8Array {
  // Atari ST layout: within each row, `interleave`-byte units alternate
  // plane 0, plane 1, … `rowBytes` may exceed the tight `width >> 3` to
  // exercise row padding; the padding bytes are left zero.
  const buf = new Uint8Array(height * rowBytes * planes);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteX = x >> 3;
      const unitIndex = Math.floor(byteX / interleave);
      for (let p = 0; p < planes; p++) {
        if ((img[y * width + x] >> p) & 1) {
          const off =
            y * rowBytes * planes +
            unitIndex * planes * interleave +
            p * interleave +
            (byteX % interleave);
          setBit(buf, off, x);
        }
      }
    }
  }
  return buf;
}

describe('decodePlanar', () => {
  const width = 32;
  const height = 5;
  const planes = 3;
  const img = makeImage(width, height, planes);

  it('round-trips plane-major', () => {
    const buf = encodePlaneMajor(img, width, height, planes);
    const cfg: PlanarConfig = { width, height, planes, layout: 'plane-major' };
    expect(decodePlanar(buf, cfg)).toEqual(img);
    expect(planarByteLength(cfg)).toBe(buf.length);
  });

  it('round-trips row-interleaved', () => {
    const buf = encodeRowInterleaved(img, width, height, planes);
    const cfg: PlanarConfig = { width, height, planes, layout: 'row-interleaved' };
    expect(decodePlanar(buf, cfg)).toEqual(img);
    expect(planarByteLength(cfg)).toBe(buf.length);
  });

  it('round-trips word-interleaved', () => {
    const buf = encodeWordInterleaved(img, width, height, planes);
    const cfg: PlanarConfig = { width, height, planes, layout: 'word-interleaved' };
    expect(decodePlanar(buf, cfg)).toEqual(img);
    expect(planarByteLength(cfg)).toBe(buf.length);
  });

  it('the three layouts produce different byte streams for the same image', () => {
    // Guards against a formula collapse where two layouts alias each other.
    const a = encodePlaneMajor(img, width, height, planes);
    const b = encodeRowInterleaved(img, width, height, planes);
    const c = encodeWordInterleaved(img, width, height, planes);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a).not.toEqual(c);
  });

  it('honours rowBytes padding', () => {
    const rowBytes = (width >> 3) + 4;
    const buf = encodeRowInterleaved(img, width, height, planes, rowBytes);
    expect(decodePlanar(buf, { width, height, planes, layout: 'row-interleaved', rowBytes })).toEqual(
      img,
    );
  });

  it('honours plane-major planeStride padding', () => {
    const rowBytes = width >> 3;
    const planeStride = rowBytes * height + 6;
    const buf = encodePlaneMajor(img, width, height, planes, rowBytes, planeStride);
    const cfg: PlanarConfig = { width, height, planes, layout: 'plane-major', planeStride };
    expect(decodePlanar(buf, cfg)).toEqual(img);
    expect(planarByteLength(cfg)).toBe(buf.length);
    // A tight decode of padded planes must NOT round-trip — this is the
    // planar-plane-padding-vs-tight-stride failure mode the option exists for.
    expect(decodePlanar(buf, { width, height, planes, layout: 'plane-major' })).not.toEqual(img);
  });

  it('honours a byte offset', () => {
    const pad = 17;
    const encoded = encodeRowInterleaved(img, width, height, planes);
    const buf = new Uint8Array(pad + encoded.length);
    buf.set(encoded, pad);
    expect(
      decodePlanar(buf, { width, height, planes, layout: 'row-interleaved', offset: pad }),
    ).toEqual(img);
  });

  it('reads past the end of data as zero bits instead of throwing', () => {
    const buf = encodeRowInterleaved(img, width, height, planes).subarray(0, 10);
    const out = decodePlanar(buf, { width, height, planes, layout: 'row-interleaved' });
    expect(out.length).toBe(width * height);
    // The tail rows, entirely past the truncated buffer, decode as index 0.
    expect(out.subarray(width * (height - 1)).every((v) => v === 0)).toBe(true);
  });

  it('honours a non-default word-interleaved interleave on an aligned config', () => {
    const interleave = 4;
    const buf = encodeWordInterleaved(img, width, height, planes, interleave);
    const cfg: PlanarConfig = { width, height, planes, layout: 'word-interleaved', interleave };
    expect(decodePlanar(buf, cfg)).toEqual(img);
    expect(planarByteLength(cfg)).toBe(buf.length);
  });

  it('honours an offset combined with word-interleaved rowBytes padding', () => {
    const pad = 5;
    const rowBytes = (width >> 3) + 2; // still a multiple of the default interleave (2)
    const padded = encodeWordInterleaved(img, width, height, planes, 2, rowBytes);
    const buf = new Uint8Array(pad + padded.length);
    buf.set(padded, pad);
    expect(
      decodePlanar(buf, {
        width,
        height,
        planes,
        layout: 'word-interleaved',
        offset: pad,
        rowBytes,
      }),
    ).toEqual(img);
  });

  it('throws a clear error for a misaligned word-interleaved config (rowBytes % interleave !== 0)', () => {
    // width=8 -> rowBytes=1, default interleave=2: 1 % 2 !== 0. Verified
    // aliasing example from the review: offset 4 would otherwise be read
    // by both (y=0, p=2) and (y=1, p=0).
    const cfg: PlanarConfig = { width: 8, height: 3, planes: 4, layout: 'word-interleaved' };
    expect(() => decodePlanar(new Uint8Array(32), cfg)).toThrow(/rowBytes/);
    expect(() => planarByteLength(cfg)).toThrow(/rowBytes/);
    expect(() => planarByteOffset(0, 1, 0, cfg)).toThrow(/rowBytes/);
  });

  it('planarByteLength is >= the max planarByteOffset over the whole valid range', () => {
    const configs: PlanarConfig[] = [
      { width: 32, height: 5, planes: 3, layout: 'plane-major' },
      { width: 32, height: 5, planes: 3, layout: 'row-interleaved' },
      { width: 32, height: 5, planes: 3, layout: 'word-interleaved' },
      { width: 32, height: 5, planes: 3, layout: 'word-interleaved', interleave: 4 },
      { width: 32, height: 5, planes: 3, layout: 'plane-major', rowBytes: 8, planeStride: 60 },
    ];
    for (const cfg of configs) {
      const len = planarByteLength(cfg);
      const bytesPerRow = cfg.width >> 3;
      let maxOffset = -1;
      for (let plane = 0; plane < cfg.planes; plane++) {
        for (let y = 0; y < cfg.height; y++) {
          for (let byteX = 0; byteX < bytesPerRow; byteX++) {
            maxOffset = Math.max(maxOffset, planarByteOffset(byteX, y, plane, cfg));
          }
        }
      }
      expect(len).toBeGreaterThan(maxOffset);
    }
  });
});

describe('decodePlanar validation', () => {
  const validBase = { height: 4, planes: 2, layout: 'row-interleaved' as const };
  const data = new Uint8Array(64);

  it('rejects a negative width', () => {
    expect(() => decodePlanar(data, { ...validBase, width: -8 })).toThrow(/width/);
  });

  it('rejects a fractional width', () => {
    expect(() => decodePlanar(data, { ...validBase, width: 8.5 })).toThrow(/width/);
  });

  it('rejects a non-positive height', () => {
    expect(() => decodePlanar(data, { width: 8, planes: 2, layout: 'row-interleaved', height: 0 })).toThrow(
      /height/,
    );
  });

  it('rejects planes out of the documented 1-8 range', () => {
    expect(() => decodePlanar(data, { width: 8, height: 4, planes: 9, layout: 'row-interleaved' })).toThrow(
      /planes/,
    );
    expect(() => decodePlanar(data, { width: 8, height: 4, planes: 0, layout: 'row-interleaved' })).toThrow(
      /planes/,
    );
  });

  it('rejects a fractional planes value', () => {
    expect(() =>
      decodePlanar(data, { width: 8, height: 4, planes: 2.5, layout: 'row-interleaved' }),
    ).toThrow(/planes/);
  });
});

describe('palette', () => {
  it('expands amiga12 colour words nibble×17', () => {
    expect(expandColorWord(0x0fff, 'amiga12')).toEqual([255, 255, 255]);
    expect(expandColorWord(0x0a51, 'amiga12')).toEqual([170, 85, 17]);
    expect(expandColorWord(0x0000, 'amiga12')).toEqual([0, 0, 0]);
  });

  it('expands amiga24 longwords directly', () => {
    expect(expandColorWord(0x00c08040, 'amiga24')).toEqual([0xc0, 0x80, 0x40]);
  });

  it('expandPalette flattens to rgb triples', () => {
    expect(expandPalette([0x0f00, 0x00f0], 'amiga12')).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it('expandPalette flattens amiga24 longwords to rgb triples', () => {
    expect(expandPalette([0x00ff8000, 0x00001122], 'amiga24')).toEqual([255, 128, 0, 0, 0x11, 0x22]);
  });

  it('greyscaleRamp spans 0..255 over 2^planes levels', () => {
    const ramp = greyscaleRamp(2);
    expect(ramp).toEqual([0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255]);
  });

  it('greyscaleRamp rejects planes out of the 1-8 range', () => {
    // 1 << 31 overflows to a negative number in JS bitwise ops.
    expect(() => greyscaleRamp(31)).toThrow(/planes/);
    expect(() => greyscaleRamp(0)).toThrow(/planes/);
    expect(() => greyscaleRamp(9)).toThrow(/planes/);
  });
});

describe('indicesToRGBA', () => {
  const indices = Uint8Array.from([0, 1, 2]);
  const palette = [10, 11, 12, 20, 21, 22, 30, 31, 32];

  it('renders fully opaque by default (no implicit transparent index 0)', () => {
    const rgba = indicesToRGBA(indices, palette);
    expect([...rgba]).toEqual([10, 11, 12, 255, 20, 21, 22, 255, 30, 31, 32, 255]);
  });

  it('honours an explicit transparentIndex', () => {
    const rgba = indicesToRGBA(indices, palette, { transparentIndex: 1 });
    expect(rgba[3]).toBe(255);
    expect(rgba[7]).toBe(0);
    expect(rgba[11]).toBe(255);
  });

  it('a mask plane overrides transparentIndex', () => {
    const rgba = indicesToRGBA(indices, palette, {
      transparentIndex: 1,
      mask: Uint8Array.from([0, 1, 0]),
    });
    expect(rgba[3]).toBe(0);
    expect(rgba[7]).toBe(255);
    expect(rgba[11]).toBe(0);
  });

  it('indices past the palette end render black', () => {
    const rgba = indicesToRGBA(Uint8Array.from([5]), palette);
    expect([...rgba]).toEqual([0, 0, 0, 255]);
  });

  it('a mask shorter than indices renders the uncovered tail transparent', () => {
    // mask[i] is undefined past its end, which is falsy -> alpha 0.
    const rgba = indicesToRGBA(indices, palette, { mask: Uint8Array.from([1]) });
    expect(rgba[3]).toBe(255); // covered by mask
    expect(rgba[7]).toBe(0); // past mask end -> transparent
    expect(rgba[11]).toBe(0); // past mask end -> transparent
  });
});
