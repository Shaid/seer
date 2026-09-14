import { describe, expect, it } from 'vitest';
import { parseCtpk } from '../ctpk.js';

function u32le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
}

function u16le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

/** Build a minimal CTPK with one 8×8 L4 texture (format 10) of 32 bytes. */
function makeCtpk(textureData: Uint8Array): Uint8Array {
  const nameOff = 0x40;
  const name = new Uint8Array([...Buffer.from('test.tga'), 0]);
  const hashSecOff = nameOff + name.length + 3; // 4-aligned
  const infoSecOff = hashSecOff + 8;
  const texSecOff = Math.ceil((infoSecOff + 4) / 0x80) * 0x80;

  const buf = new Uint8Array(texSecOff + textureData.length);
  buf.set(u32le(0x4b505443), 0); // "CTPK"
  buf.set(u16le(1), 4); // version
  buf.set(u16le(1), 6); // texture count
  buf.set(u32le(texSecOff), 8); // texture section offset
  buf.set(u32le(textureData.length), 12); // texture section size
  buf.set(u32le(hashSecOff), 16); // hash section offset
  buf.set(u32le(infoSecOff), 20); // texture info section offset

  const entry = 0x20;
  buf.set(u32le(nameOff), entry); // path offset
  buf.set(u32le(textureData.length), entry + 4); // data size
  buf.set(u32le(0), entry + 8); // data offset
  buf.set(u32le(10), entry + 12); // L4
  buf.set(u16le(8), entry + 16); // width
  buf.set(u16le(8), entry + 18); // height
  buf[entry + 20] = 0; // mip level
  buf[entry + 21] = 2; // type
  buf.set(u32le(0), entry + 24); // bitmap size offset
  buf.set(u32le(0), entry + 28); // file time

  buf.set(name, nameOff);
  buf.set(u32le(0), hashSecOff); // hash
  buf.set(u32le(0), hashSecOff + 4); // index
  buf.set(u32le(0), infoSecOff); // info
  buf.set(textureData, texSecOff);
  return buf;
}

describe('CTPK', () => {
  it('parses header and texture entries', () => {
    const ct = parseCtpk(makeCtpk(new Uint8Array(32)));
    expect(ct.version).toBe(1);
    expect(ct.textures).toHaveLength(1);
    const t = ct.textures[0];
    expect(t.name).toBe('test.tga');
    expect(t.format).toBe(10);
    expect(t.width).toBe(8);
    expect(t.height).toBe(8);
    expect(t.dataOffset).toBe(0);
    expect(t.dataSize).toBe(32);
  });

  it('throws on a non-CTPK buffer', () => {
    expect(() => parseCtpk(new Uint8Array([1, 2, 3, 4]))).toThrow(/CTPK/);
  });
});
