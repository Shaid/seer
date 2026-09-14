import { describe, it, expect } from 'vitest';
import { encodeBC1, decodeBC1, encodeBC3, decodeBC2, decodeBC3, decodeBC4, decodeBC5, decodeBC7, decodeBC6H } from '../bc.js';

function solidRGBA(width: number, height: number, r: number, g: number, b: number, a: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return out;
}

describe('BC1 encode/decode round trip', () => {
  // Note: encodeBC1Block's bounding-box endpoint selection forces c0/c1 apart even for a
  // perfectly solid input (rMin===rMax triggers the "if (c0 === c1)" branch, which can leave
  // the two endpoints a few 565 steps apart) — see the encoder's own doc comment ("adequate
  // quality... not a maximum-quality encoder"). So round-tripping a solid color is only
  // guaranteed to come back *close*, not byte-identical; a gradient block (where a bounding
  // box is the actual right endpoint choice) is the more meaningful round-trip case.
  it('round-trips a mild gradient block close to the original colors', () => {
    // A shallow gradient (small range) keeps the 4-color BC1 palette's quantization error
    // small, unlike a full 0-255 sweep which would legitimately band a lot over 16 texels.
    const width = 4, height = 4;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = 100 + i * 2; rgba[i * 4 + 1] = 128; rgba[i * 4 + 2] = 200 - i * 2; rgba[i * 4 + 3] = 255;
    }
    const encoded = encodeBC1(rgba, width, height);
    const decoded = new Uint8Array(width * height * 4);
    decodeBC1(encoded, width, height, decoded);
    for (let i = 0; i < width * height * 4; i += 4) {
      expect(Math.abs(decoded[i]! - rgba[i]!)).toBeLessThanOrEqual(20);
      expect(decoded[i + 3]).toBe(255);
    }
  });

  it('produces one 8-byte block per 4x4 tile', () => {
    const encoded = encodeBC1(solidRGBA(8, 4, 1, 2, 3, 255), 8, 4);
    expect(encoded.length).toBe(2 * 1 * 8);
  });

  it('decodes a solid block to a single uniform, fully-opaque color', () => {
    const width = 8, height = 8;
    const rgba = solidRGBA(width, height, 100, 150, 200, 255);
    const encoded = encodeBC1(rgba, width, height);
    const decoded = new Uint8Array(width * height * 4);
    decodeBC1(encoded, width, height, decoded);
    const [r0, g0, b0, a0] = [decoded[0], decoded[1], decoded[2], decoded[3]];
    for (let i = 0; i < width * height; i++) {
      expect(decoded[i * 4]).toBe(r0);
      expect(decoded[i * 4 + 1]).toBe(g0);
      expect(decoded[i * 4 + 2]).toBe(b0);
      expect(decoded[i * 4 + 3]).toBe(a0);
    }
    expect(a0).toBe(255);
  });

  it('handles non-4-aligned dimensions by clamping sample reads to the last valid row/column', () => {
    // 5x5 needs 2x2 blocks (8x8 covered); this must not throw or read out of bounds.
    const width = 5, height = 5;
    const rgba = solidRGBA(width, height, 100, 150, 200, 255);
    const encoded = encodeBC1(rgba, width, height);
    expect(encoded.length).toBe(2 * 2 * 8);
    const decoded = new Uint8Array(width * height * 4);
    expect(() => decodeBC1(encoded, width, height, decoded)).not.toThrow();
  });
});

describe('BC3 encode/decode round trip', () => {
  it('round-trips a mild gradient block close to the original values (color path)', () => {
    const width = 4, height = 4;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = 0; rgba[i * 4 + 1] = 100 + i * 4; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = 255;
    }
    const encoded = encodeBC3(rgba, width, height);
    const decoded = new Uint8Array(width * height * 4);
    decodeBC3(encoded, width, height, decoded);
    for (let i = 0; i < width * height * 4; i += 4) {
      expect(Math.abs(decoded[i + 1]! - rgba[i + 1]!)).toBeLessThanOrEqual(20);
    }
  });

  it('produces 16 bytes per block (8 alpha + 8 color)', () => {
    const encoded = encodeBC3(solidRGBA(4, 4, 1, 2, 3, 4), 4, 4);
    expect(encoded.length).toBe(16);
  });
});

describe('decodeBC2 (4-bit alpha)', () => {
  it('decodes a hand-built block with a known alpha nibble pattern', () => {
    // Color block: c0=c1=white (0xFFFF), all color indices 0 -> pure white RGB.
    const block = new Uint8Array(16);
    // Alpha nibbles: 16 texels, 2 per byte (low nibble first). Use 0xF (full) for all.
    for (let i = 0; i < 8; i++) block[i] = 0xff;
    block[8] = 0xff; block[9] = 0xff; block[10] = 0; block[11] = 0; // c0=0xffff white
    block[12] = 0; block[13] = 0; block[14] = 0; block[15] = 0; // all color indices 0
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC2(block, 4, 4, out);
    for (let i = 0; i < 16; i++) {
      expect(out[i * 4 + 3]).toBe(255); // nibble 0xf * 17 = 255
    }
  });
});

describe('decodeBC4 (single channel)', () => {
  it('decodes a flat single-value block to a grayscale RGBA with alpha=255', () => {
    const block = new Uint8Array(8);
    block[0] = 100; block[1] = 100; // r0 === r1
    // indices all 0
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC4(block, 4, 4, out);
    for (let i = 0; i < 16; i++) {
      expect(out[i * 4]).toBe(100);
      expect(out[i * 4 + 1]).toBe(100);
      expect(out[i * 4 + 2]).toBe(100);
      expect(out[i * 4 + 3]).toBe(255);
    }
  });
});

describe('decodeBC5 (two-channel)', () => {
  it('decodes red and green from independent BC4 sub-blocks, blue always 0', () => {
    const block = new Uint8Array(16);
    block[0] = 50; block[1] = 50; // red r0===r1
    block[8] = 200; block[9] = 200; // green g0===g1
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC5(block, 4, 4, out);
    for (let i = 0; i < 16; i++) {
      expect(out[i * 4]).toBe(50);
      expect(out[i * 4 + 1]).toBe(200);
      expect(out[i * 4 + 2]).toBe(0);
      expect(out[i * 4 + 3]).toBe(255);
    }
  });
});

describe('decodeBC7', () => {
  /** Bit-packs a BC7 mode-6 block: mode select, then endpoints read *plane-by-plane*
   * (all R's across every endpoint, then all G's, then all B's, then all A's) — not
   * per-endpoint RGBA groups. See `decodeBC7Block`'s doc comment. */
  function buildMode6Block(r: [number, number], g: [number, number], b: [number, number], a: [number, number], pBits: [number, number]): Uint8Array {
    const bits: number[] = [];
    const pushBits = (value: number, count: number) => { for (let i = 0; i < count; i++) bits.push((value >> i) & 1); };
    pushBits(0b1000000, 7); // unary mode 6: six 0 bits then a 1 bit (LSB-first) -> mode=6
    pushBits(r[0], 7); pushBits(r[1], 7);
    pushBits(g[0], 7); pushBits(g[1], 7);
    pushBits(b[0], 7); pushBits(b[1], 7);
    pushBits(a[0], 7); pushBits(a[1], 7);
    pushBits(pBits[0], 1); pushBits(pBits[1], 1);
    // 16 texels, 4-bit indices; anchor texel 0 loses its top bit -> 3 bits for texel 0, 4 bits x 15.
    pushBits(0, 3);
    for (let i = 1; i < 16; i++) pushBits(0, 4);

    const data = new Uint8Array(16);
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) data[i >> 3] |= 1 << (i & 7);
    }
    return data;
  }

  it('decodes mode 6 (single subset, 7-bit RGBA + P-bit) to a known flat color', () => {
    // Both endpoints identical (127,0,0,127) with p-bit=1 on both -> unquantizes to
    // R=(127<<1|1)=255, G=(0<<1|1)=1, B=1, A=255 for every texel (all index bits are 0,
    // and identical endpoints make the interpolated result the same regardless of index).
    const data = buildMode6Block([127, 127], [0, 0], [0, 0], [127, 127], [1, 1]);
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC7(data, 4, 4, out);
    const [r0, g0, b0, a0] = [out[0], out[1], out[2], out[3]];
    for (let i = 1; i < 16; i++) {
      expect(out[i * 4]).toBe(r0);
      expect(out[i * 4 + 1]).toBe(g0);
      expect(out[i * 4 + 2]).toBe(b0);
      expect(out[i * 4 + 3]).toBe(a0);
    }
    expect(r0).toBe(255);
    expect(g0).toBe(1);
    expect(b0).toBe(1);
    expect(a0).toBe(255);
  });

  it('decodes distinct P-bits per endpoint (endpoint 0 vs endpoint 1 differ by their LSB)', () => {
    const data = buildMode6Block([100, 100], [50, 50], [10, 10], [255, 255], [0, 1]);
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC7(data, 4, 4, out);
    // Index bits are all 0 -> every texel samples endpoint 0 exactly (interp with index 0 returns c0 exactly).
    expect(out[0]).toBe(100 << 1); // p-bit 0 -> LSB 0
    expect(out[1]).toBe(50 << 1);
    expect(out[2]).toBe(10 << 1);
  });

  it('decodes a reserved mode (all zero bits) as transparent black', () => {
    const data = new Uint8Array(16); // all zero bits -> no set bit found in 8 unary positions -> mode 8 (reserved)
    const out = new Uint8Array(4 * 4 * 4).fill(255);
    decodeBC7(data, 4, 4, out);
    expect(Array.from(out)).toEqual(new Array(64).fill(0));
  });

  it('does not throw across a range of arbitrary block bytes for every mode selector', () => {
    const out = new Uint8Array(4 * 4 * 4);
    for (let mode = 0; mode < 8; mode++) {
      const data = new Uint8Array(16);
      data[0] = 1 << mode; // unary-select this mode, rest zero
      for (let seed = 0; seed < 4; seed++) {
        for (let i = 1; i < 16; i++) data[i] = (i * 37 + seed * 91) & 0xff;
        expect(() => decodeBC7(data, 4, 4, out)).not.toThrow();
        for (const v of out) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255); }
      }
    }
  });
});

describe('decodeBC6H (approximate grayscale)', () => {
  it('produces opaque grayscale output within [0,255]', () => {
    const block = new Uint8Array(16);
    block[0] = 0x00; block[1] = 0x3c; // some representative half-float bit pattern
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC6H(block, 4, 4, out);
    for (let i = 0; i < 16; i++) {
      expect(out[i * 4]).toBe(out[i * 4 + 1]);
      expect(out[i * 4 + 1]).toBe(out[i * 4 + 2]);
      expect(out[i * 4 + 3]).toBe(255);
      expect(out[i * 4]).toBeGreaterThanOrEqual(0);
      expect(out[i * 4]).toBeLessThanOrEqual(255);
    }
  });
});
