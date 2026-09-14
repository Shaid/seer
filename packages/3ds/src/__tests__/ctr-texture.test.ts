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
