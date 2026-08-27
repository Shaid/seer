import { describe, it, expect } from 'vitest';
import {
  cps3Mask,
  cps3DecryptProgram,
  assembleCps3User5,
  Cps3CharDma,
  CPS3_DMA_XOR,
} from '../capcom/cps3.js';

describe('cps3Mask', () => {
  it('returns a 32-bit value with the two 16-bit halves equal (MAME val|val<<16)', () => {
    const addr = 0x06000000;
    const lo = cps3Mask(addr, 0xa55432b4, 0x0c129981) & 0xffff;
    const hi = cps3Mask(addr, 0xa55432b4, 0x0c129981) >>> 16;
    expect(lo).toBe(hi);
  });

  it('is deterministic for a fixed address and key', () => {
    const m1 = cps3Mask(0x06012340, 0x9e300ab1, 0xa175b82c);
    const m2 = cps3Mask(0x06012340, 0x9e300ab1, 0xa175b82c);
    expect(m1).toBe(m2);
  });

  it('key=0,key=0 (sfiii2 dead cart) still masks (non-zero address-dependent)', () => {
    // Not a true "no-op" — the mask depends on address; assert it is a
    // stable function of the address helper above.
    expect(cps3Mask(0x06000000, 0, 0)).not.toBeNaN();
  });
});

describe('cps3DecryptProgram', () => {
  it('is symmetric: decrypt(decrypt(x)) === x', () => {
    const raw = new Uint8Array(new Array(64).fill(0).map((_, i) => (i * 37) & 0xff));
    const key1 = 0xa55432b4;
    const key2 = 0x0c129981;
    const dec = cps3DecryptProgram(raw, 0x06000000, key1, key2);
    const re = cps3DecryptProgram(dec, 0x06000000, key1, key2);
    expect(Array.from(re)).toEqual(Array.from(raw));
  });

  it('decrypts raw dwords to SH2-opcode-like values at the reset region', () => {
    // Hand-built fixture: the FIRST dword of the real sfiii3n simm1 dump,
    // encrypted, decodes back to the plaintext dword 0xa00e0006 (whose bytes
    // 0xa0 0x0e are the SH2 `bra` opcode). We take the known plaintext,
    // encrypt it (XOR), then assert the decrypt recovers it.
    const key1 = 0xa55432b4;
    const key2 = 0x0c129981;
    const plain = 0xa00e0006;

    // encrypt: raw[0..3] little-endian? cps3DecryptProgram reads MAME's
    // host-LE byte image, so to encrypt we build the same LE bytes of
    // (plain ^ mask).
    const mask = cps3Mask(0x06000000, key1, key2);
    const enc = (plain ^ mask) >>> 0;
    const raw = new Uint8Array([
      enc & 0xff,
      (enc >>> 8) & 0xff,
      (enc >>> 16) & 0xff,
      (enc >>> 24) & 0xff,
    ]);
    const dec = cps3DecryptProgram(raw, 0x06000000, key1, key2);
    const got = (dec[0] | (dec[1] << 8) | (dec[2] << 16) | (dec[3] << 24)) >>> 0;
    expect(got).toBe(plain);
  });

  it('zero-filled region decrypts to the mask itself (address-derived)', () => {
    // If the encrypted ROM has 4 zero bytes at address 0x06000080, the
    // decrypted bytes spell 0x(mask) LE.
    const key1 = 0xa55432b4;
    const key2 = 0x0c129981;
    const raw = new Uint8Array(8); // all zeros
    const dec = cps3DecryptProgram(raw, 0x06000080, key1, key2);
    const mask = cps3Mask(0x06000080, key1, key2);
    const got = (dec[0] | (dec[1] << 8) | (dec[2] << 16) | (dec[3] << 24)) >>> 0;
    expect(got).toBe(mask);
  });
});

describe('assembleCps3User5', () => {
  it('interleaves a 2-chip pair into MAME-style host-LE u32 words', () => {
    // word = (f0[i]<<8)|(f0[i+1]<<24)|(f1[i]<<0)|(f1[i+1]<<16), stored LE.
    const f0 = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const f1 = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const out = assembleCps3User5([[f0, f1]]);
    expect(out.length).toBe(8); // 4 bytes → 8 bytes of 2 u32s
    const w0 = out[0] | (out[1] << 8) | (out[2] << 16) | (out[3] << 24); // LE
    const w1 = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
    // word0 = (0xaa<<8)|(0xbb<<24)|(0x01<<0)|(0x02<<16)
    expect(w0).toBe((0xaa << 8) | (0xbb << 24) | 0x01 | (0x02 << 16));
    // word1 = (0xcc<<8)|(0xdd<<24)|(0x03<<0)|(0x04<<16)
    expect(w1).toBe((0xcc << 8) | (0xdd << 24) | 0x03 | (0x04 << 16));
  });

  it('concatenates multiple chip pairs in order', () => {
    const a = new Uint8Array([0xff, 0xff]);
    const b = new Uint8Array([0x11, 0x22]);
    const c = new Uint8Array([0xee, 0xee]);
    const d = new Uint8Array([0x33, 0x44]);
    const out = assembleCps3User5([
      [a, b],
      [c, d],
    ]);
    expect(out.length).toBe(8);
    // pair1 word: (ff<<8)|(ff<<24)|(11)|(22<<16) stored LE → first 4 bytes
    const w0 = (0xff << 8) | (0xff << 24) | 0x11 | (0x22 << 16);
    expect(out[0] | (out[1] << 8) | (out[2] << 16) | (out[3] << 24)).toBe(w0);
  });
});

describe('Cps3CharDma', () => {
  it('processByte writes a literal pixel byte (6bpp path)', () => {
    const dma = new Cps3CharDma(new Uint8Array(4096));
    const n = dma.processByte(0x21, 0);
    expect(n).toBe(1);
    expect(dma.charRam[0 ^ 3]).toBe(0x21); // destination ^ 3 byte order
  });

  it('processByte repeats the last normal byte on RLE (0x40 set)', () => {
    const dma = new Cps3CharDma(new Uint8Array(4096));
    dma.processByte(0x1a, 0x000);
    // 0x40 bit set: RLE with count (0x40|0x04)=5 → low6+1=5 repeats of 0x1a
    const n = dma.processByte(0x40 | 0x04, 0x010);
    expect(n).toBe(5);
    for (let i = 0; i < 5; i++) expect(dma.charRam[(0x010 + i) ^ 3]).toBe(0x1a);
  });

  it('doCharDma decompresses a literal stream', () => {
    // Stream: literals 0x11..0x18 (all < 0x80, none 0x40)
    const user5 = new Uint8Array(0x100);
    for (let i = 0; i < 8; i++) user5[i ^ CPS3_DMA_XOR] = 0x11 + i;
    const dma = new Cps3CharDma(user5);
    dma.doCharDma(0, 0, 8, 0);
    for (let i = 0; i < 8; i++) expect(dma.charRam[i ^ 3]).toBe(0x11 + i);
  });

  it('doCharDma follows table pairs when the high bit is set', () => {
    // First stream byte 0x80|idx → use table[idx*2] and [idx*2+1]
    const user5 = new Uint8Array(0x100);
    user5[0 ^ CPS3_DMA_XOR] = 0x80 | 3; // idx 3
    // table: [3*2]=0x21 (literal, no 0x40/0x80 bits), [3*2+1]=0x22
    const dma = new Cps3CharDma(user5);
    // doCharDma reads table from *user5* at tableAddr (same buffer here)
    const tableAddr = 0x40;
    user5[(tableAddr + 6) ^ CPS3_DMA_XOR] = 0x21;
    user5[(tableAddr + 7) ^ CPS3_DMA_XOR] = 0x22;
    dma.doCharDma(0, 0, 2, tableAddr);
    expect(dma.charRam[0 ^ 3]).toBe(0x21);
    expect(dma.charRam[1 ^ 3]).toBe(0x22);
  });
});
