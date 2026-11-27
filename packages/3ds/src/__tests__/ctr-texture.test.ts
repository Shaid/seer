import { describe, expect, it } from 'vitest';
import { decodeCtrTexture, ctrFormatName } from '../ctr-texture.js';

describe('CTR texture decode', () => {
  it('decodes an 8×8 L4 tile (low nibble first)', () => {
    // Single tile, byte 0xAB → pixels (0,0)=0xB=187 and (1,0)=0xA=170.
    const data = new Uint8Array(32);
    data[0] = 0xab;
    const rgba = decodeCtrTexture(10, 8, 8, data);
    expect(rgba[0]).toBe(0xb * 17);
    expect(rgba[1]).toBe(0xb * 17);
    expect(rgba[2]).toBe(0xb * 17);
    expect(rgba[3]).toBe(255);
    // (1,0) is the high nibble of byte 0.
    const o = (0 * 8 + 1) * 4;
    expect(rgba[o]).toBe(0xa * 17);
    expect(rgba[o + 3]).toBe(255);
  });

  it('widens 4-bit channels by replication: 15 -> 255 (RGBA4, LA4), not 240', () => {
    const d4 = new Uint8Array(2 * 8 * 8);
    d4[0] = 0x6f; // u16 little-endian 0xff6f
    d4[1] = 0xff;
    const rgba = decodeCtrTexture(4, 8, 8, d4); // value 0xff6f: r=15 g=15 b=6 a=15
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([255, 255, 6 * 17, 255]);
    const dl = new Uint8Array(8 * 8);
    dl[0] = 0xf9; // L=15 A=9
    const la = decodeCtrTexture(9, 8, 8, dl);
    expect([la[0], la[3]]).toEqual([255, 9 * 17]);
  });

  it('decodes an RGBA8 texture in the tiled layout', () => {
    const data = new Uint8Array(4 * 8 * 8);
    // Pixel (0,0) → tile k=0 (byte 0). Store ABGR: A=1,B=2,G=3,R=4.
    data[0] = 1;
    data[1] = 2;
    data[2] = 3;
    data[3] = 4;
    const rgba = decodeCtrTexture(0, 8, 8, data);
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([4, 3, 2, 1]);
  });

  it('maps CT SDK format ids to names', () => {
    expect(ctrFormatName(0)).toBe('rgba8');
    expect(ctrFormatName(12)).toBe('etc1');
    expect(ctrFormatName(13)).toBe('etc1a4');
    expect(ctrFormatName(99)).toBeUndefined();
  });
});
