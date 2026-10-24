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

describe('block scatter/gather refactor: byte-identical decode output', () => {
  // `forEachBlock`/`scatterBlock`/`gatherBlock` replaced eight hand-written
  // copies of the same block-iteration + edge-clipping loop. These digests
  // were captured from the pre-refactor decoders (the 2026-10-25 48-bit-index
  // fix already applied) and must not move: they pin every format's output on
  // pseudo-random block data at six surface shapes, four of which are not a
  // multiple of 4 in one or both axes and so exercise the clipping path.
  const GOLDEN: Record<string, readonly string[]> = {
    BC1: ['600d9045', '6e1f7084', '7bb53a9e', '983d2b44', 'abb052fb', '6b8050f7'],
    BC2: ['156d77b4', 'ed7f8fb3', 'b3f8414d', 'ae438a2c', 'dc6b3bd6', 'a5efced2'],
    BC3: ['4ab69ac8', 'e61bce8a', 'dbd844c6', 'a2ede7a8', 'b2ab1e52', '473c99ac'],
    BC4: ['6764580c', 'f8eb18c6', '83882f35', '603c2a4b', '643f8c86', 'b8ee81d5'],
    BC5: ['8e661a36', 'ee25139f', '4dcf8624', '73becd5c', '71f952e4', '8931a96f'],
    BC6H: ['35598445', 'a0e0de05', 'bbfb2359', '1bef5297', 'b7238265', 'f3991765'],
    BC7: ['c17f6f53', 'f955af99', '633afdda', 'f50e8e2e', '0a0ac46c', 'ecefa5ec'],
  };
  const DIMS: readonly [number, number][] = [[4, 4], [8, 8], [5, 3], [13, 7], [16, 1], [1, 16]];
  const DECODERS: readonly [string, (d: Uint8Array, w: number, h: number, o: Uint8Array, outOff?: number) => void, number][] = [
    ['BC1', decodeBC1, 8], ['BC2', decodeBC2, 16], ['BC3', decodeBC3, 16], ['BC4', decodeBC4, 8],
    ['BC5', decodeBC5, 16], ['BC6H', decodeBC6H, 16], ['BC7', decodeBC7, 16],
  ];

  function bytes(seed: number, length: number): Uint8Array {
    let s = seed >>> 0;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = (s >>> 16) & 0xff; }
    return out;
  }
  function fnv1a(b: Uint8Array): string {
    let h = 0x811c9dc5;
    for (const v of b) { h ^= v; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  for (const [name, decode, bytesPerBlock] of DECODERS) {
    it(`${name} output is unchanged at every surface shape`, () => {
      const digests = DIMS.map(([w, h]) => {
        const blocks = Math.ceil(w / 4) * Math.ceil(h / 4);
        const out = new Uint8Array(w * h * 4);
        decode(bytes(0xc0ffee ^ (w * 131 + h), blocks * bytesPerBlock), w, h, out);
        return fnv1a(out);
      });
      expect(digests).toEqual(GOLDEN[name]);
    });
  }

  it('encodeBC1/encodeBC3 output is unchanged at every surface shape', () => {
    // `gatherBlock` replaced the two copies of the edge-clamping 16-texel
    // read; these digests are likewise from the pre-refactor encoders.
    const ENCODE_GOLDEN = {
      BC1: ['5f23b487', '746e8dde', '5a905bdc', 'f6e77fd6', 'b94a2b80', '5313b8ca'],
      BC3: ['2451a3ec', '65b68b5f', 'c9de79e8', '9179d545', '615e5d0c', 'b6ccddcd'],
    };
    for (const [name, encode] of [['BC1', encodeBC1], ['BC3', encodeBC3]] as const) {
      const digests = DIMS.map(([w, h]) => fnv1a(encode(bytes(0xbeef ^ (w * 977 + h), w * h * 4), w, h)));
      expect(digests, name).toEqual(ENCODE_GOLDEN[name]);
    }
  });

  it('writes nothing outside the requested surface (clipped blocks leave the tail alone)', () => {
    // 5x3 occupies 2x1 blocks = 8x4 texels; everything past index 5*3*4 in a
    // deliberately oversized output buffer must stay at its sentinel value.
    const w = 5, h = 3, pad = 64;
    for (const [name, decode, bytesPerBlock] of DECODERS) {
      const out = new Uint8Array(w * h * 4 + pad).fill(0xcd);
      decode(bytes(1, 2 * bytesPerBlock), w, h, out);
      expect(Array.from(out.subarray(w * h * 4)), name).toEqual(new Array(pad).fill(0xcd));
    }
  });

  it('honours outOff, packing consecutive surfaces back to back', () => {
    const w = 6, h = 6, surface = w * h * 4;
    for (const [name, decode, bytesPerBlock] of DECODERS) {
      const data = bytes(7, 4 * bytesPerBlock);
      const alone = new Uint8Array(surface);
      decode(data, w, h, alone);
      const offset = new Uint8Array(surface * 2).fill(0xab);
      decode(data, w, h, offset, surface);
      expect(Array.from(offset.subarray(surface)), name).toEqual(Array.from(alone));
      expect(Array.from(offset.subarray(0, surface)), name).toEqual(new Array(surface).fill(0xab));
    }
  });
});

describe('the 48-bit 3-bit-index field (BC3 alpha / BC4 / BC5)', () => {
  /**
   * Pack 16 3-bit indices into the 6-byte index field exactly as the format
   * specifies (texel 0 at bit 0), via BigInt so the packer itself can't share
   * a shift bug with the decoder under test.
   */
  function packIndices(indices: readonly number[]): Uint8Array {
    let bits = 0n;
    for (let i = 15; i >= 0; i--) bits = (bits << 3n) | BigInt(indices[i]!);
    const out = new Uint8Array(6);
    for (let i = 0; i < 6; i++) out[i] = Number((bits >> BigInt(i * 8)) & 0xffn);
    return out;
  }

  /**
   * Independent reference for one BC4-style channel: unpack the 6 index bytes
   * with BigInt (no 32-bit truncation possible) and apply the spec's 8- or
   * 6-value interpolation. BC3's alpha channel uses this identical math.
   */
  function refChannel(e0: number, e1: number, field: Uint8Array): number[] {
    let bits = 0n;
    for (let i = 0; i < 6; i++) bits |= BigInt(field[i]!) << BigInt(i * 8);
    const out: number[] = [];
    for (let p = 0; p < 16; p++) {
      const i = Number((bits >> BigInt(p * 3)) & 7n);
      out.push(e0 > e1
        ? (i === 0 ? e0 : i === 1 ? e1 : ((8 - i) * e0 + (i - 1) * e1) / 7 | 0)
        : (i === 0 ? e0 : i === 1 ? e1 : i === 6 ? 0 : i === 7 ? 255 : ((6 - i) * e0 + (i - 1) * e1) / 5 | 0));
    }
    return out;
  }

  /** Deterministic PRNG so a failure is reproducible from the seed alone. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s; };
  }

  // The regression case. Until 2026-10-25 every decoder accumulated this
  // field with `bits |= data[b+2+i] << (i*8)`, and JS masks shift counts to 5
  // bits, so bytes 4 and 5 wrapped back over bytes 0 and 1. With all-distinct
  // indices the old code returned 6,1,3,7,7,5,6,7,0,1,6,7,4,5,7,7 — i.e. it
  // corrupted texels 0, 2, 3, 4, 10, 11 and 14, not merely the high texels.
  const DISTINCT = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
  // endpoints 255/0 take the 8-value branch: idx 2..7 -> round((8-i)*255/7).
  const DISTINCT_255_0 = [255, 0, 218, 182, 145, 109, 72, 36, 255, 0, 218, 182, 145, 109, 72, 36];

  it('decodeBC4 reads all 16 indices of an all-distinct block (not just the low 11)', () => {
    const block = new Uint8Array(8);
    block[0] = 255; block[1] = 0;
    block.set(packIndices(DISTINCT), 2);
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC4(block, 4, 4, out);
    for (let p = 0; p < 16; p++) {
      expect(out[p * 4]).toBe(DISTINCT_255_0[p]);
      expect(out[p * 4 + 1]).toBe(DISTINCT_255_0[p]);
      expect(out[p * 4 + 2]).toBe(DISTINCT_255_0[p]);
      expect(out[p * 4 + 3]).toBe(255);
    }
  });

  it('decodeBC5 reads both channels independently across all 16 texels', () => {
    const reversed = [...DISTINCT].reverse();
    const block = new Uint8Array(16);
    block[0] = 255; block[1] = 0; block.set(packIndices(DISTINCT), 2);
    block[8] = 255; block[9] = 0; block.set(packIndices(reversed), 10);
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC5(block, 4, 4, out);
    const expectedG = [...DISTINCT_255_0].reverse();
    for (let p = 0; p < 16; p++) {
      expect(out[p * 4]).toBe(DISTINCT_255_0[p]);
      expect(out[p * 4 + 1]).toBe(expectedG[p]);
      expect(out[p * 4 + 2]).toBe(0);
      expect(out[p * 4 + 3]).toBe(255);
    }
  });

  it('decodeBC3 reads all 16 alpha indices of an all-distinct block', () => {
    const block = new Uint8Array(16);
    block[0] = 255; block[1] = 0; block.set(packIndices(DISTINCT), 2);
    block[8] = 0xff; block[9] = 0xff; // c0 = white, c1 = 0, all color indices 0
    const out = new Uint8Array(4 * 4 * 4);
    decodeBC3(block, 4, 4, out);
    for (let p = 0; p < 16; p++) expect(out[p * 4 + 3]).toBe(DISTINCT_255_0[p]);
  });

  it('matches a BigInt reference decode over random BC4/BC5/BC3 blocks', () => {
    const next = rng(0x5eed);
    const out = new Uint8Array(4 * 4 * 4);
    for (let trial = 0; trial < 400; trial++) {
      const e0 = next() & 0xff, e1 = next() & 0xff;
      const field = new Uint8Array(6);
      for (let i = 0; i < 6; i++) field[i] = next() & 0xff;
      const expected = refChannel(e0, e1, field);

      const bc4 = new Uint8Array(8);
      bc4[0] = e0; bc4[1] = e1; bc4.set(field, 2);
      decodeBC4(bc4, 4, 4, out);
      for (let p = 0; p < 16; p++) expect(out[p * 4]).toBe(expected[p]);

      // Second channel of BC5 — a different endpoint pair and field, to prove
      // the green sub-block is read from offset +10 and not aliased to red.
      const g0 = next() & 0xff, g1 = next() & 0xff;
      const gField = new Uint8Array(6);
      for (let i = 0; i < 6; i++) gField[i] = next() & 0xff;
      const expectedG = refChannel(g0, g1, gField);
      const bc5 = new Uint8Array(16);
      bc5[0] = e0; bc5[1] = e1; bc5.set(field, 2);
      bc5[8] = g0; bc5[9] = g1; bc5.set(gField, 10);
      decodeBC5(bc5, 4, 4, out);
      for (let p = 0; p < 16; p++) {
        expect(out[p * 4]).toBe(expected[p]);
        expect(out[p * 4 + 1]).toBe(expectedG[p]);
      }

      // BC3's alpha block has the same layout and interpolation as BC4's.
      const bc3 = new Uint8Array(16);
      bc3[0] = e0; bc3[1] = e1; bc3.set(field, 2);
      for (let i = 8; i < 16; i++) bc3[i] = next() & 0xff;
      decodeBC3(bc3, 4, 4, out);
      for (let p = 0; p < 16; p++) expect(out[p * 4 + 3]).toBe(expected[p]);
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
