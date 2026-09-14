import { describe, it, expect } from 'vitest';
import { unpackExepack, ExepackError } from '../exepack.js';

/**
 * A minimal, hand-derived EXEPACK-compressed MZ executable. Every field
 * below is derived directly from the documented EXEPACK format (see
 * `exepack.ts`'s header comment) and was verified against a known-good
 * reference decoder before being hardcoded here.
 *
 * Desired 16-byte decompressed image: 12 bytes of an incrementing "head"
 * (0x10..0x1B) followed by 4 bytes of a repeated fill (0xEE) — one
 * verbatim-head copy plus one run-length block, covering both EXEPACK
 * block-command types this decoder implements.
 *
 * Encoding derivation (block processed back-to-front, per `unpackExepack`):
 *   - `cmd = 0xB1` (op `0xB0` "run", bit0 set = last block)
 *   - `count = 4` (LE u16: low byte 0x04, high byte 0x00)
 *   - `fill = 0xEE`
 *   - remaining 12 bytes (0x10..0x1B) are the incompressible "verbatim
 *     head", copied as-is — `packed_body` is therefore 16 bytes total
 *     (12 head + 4 block-descriptor bytes), i.e. exactly 1 paragraph
 *     (`e_cs = 1`).
 *
 * Relocation table: 16 groups, each declaring 0 entries (32 zero bytes) —
 * `exepack_size = 0x112 (RELOC_TABLE_OFF) + 32 = 0x132`.
 */
function buildExepackFixture(): Uint8Array {
  const packed = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0xee, 0x04, 0x00, 0xb1,
  ];
  const exepackHeader = [
    0x00,
    0x00, // real_ip
    0x00,
    0x00, // real_cs
    0x00,
    0x00, // mem_start
    0x32,
    0x01, // exepack_size = 0x0132 (LE)
    0x00,
    0x00, // real_sp
    0x00,
    0x00, // real_ss
    0x01,
    0x00, // dest_len (paragraphs) = 1 -> 16 bytes
    0x52,
    0x42, // sig 'R','B' (LE bytes)
  ];
  const pad = new Array(0x112 - 16).fill(0); // up to RELOC_TABLE_OFF
  const relocTable = new Array(2 * 16).fill(0); // 16 groups, count=0 each

  const body = [...packed, ...exepackHeader, ...pad, ...relocTable];
  const hdrLen = 32;
  const eCblp = hdrLen + body.length;

  const mzHeader = new Array(hdrLen).fill(0);
  mzHeader[0] = 0x4d; // 'M'
  mzHeader[1] = 0x5a; // 'Z'
  const setU16 = (offset: number, value: number) => {
    mzHeader[offset] = value & 0xff;
    mzHeader[offset + 1] = (value >> 8) & 0xff;
  };
  setU16(2, eCblp); // e_cblp
  setU16(4, 1); // e_cp
  setU16(6, 0); // e_crlc
  setU16(8, 2); // e_cparhdr (2 * 16 = 32-byte header)
  setU16(10, 0); // minalloc
  setU16(12, 0); // maxalloc
  setU16(14, 0); // ss
  setU16(16, 0); // sp
  setU16(18, 0); // csum
  setU16(20, 16); // e_ip -- must be exactly 16 (EXEPACK header size)
  setU16(22, 1); // e_cs -- epk = e_cs * 16 = 16 = packed body length

  return Uint8Array.from([...mzHeader, ...body]);
}

describe('unpackExepack', () => {
  it('unpacks a minimal, hand-derived EXEPACK image to its real load image', () => {
    const fixture = buildExepackFixture();
    const { image, info } = unpackExepack(fixture);

    expect([...image]).toEqual([
      0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0xee, 0xee, 0xee,
      0xee,
    ]);
    expect(info.blocks).toBe(1);
    expect(info.ffPad).toBe(0);
    expect(info.headVerbatim).toBe(12);
    expect(info.destLenParagraphs).toBe(1);
    expect(info.exepackSize).toBe(0x132);
    expect(info.relocs).toEqual([]);
  });

  it('throws on a non-MZ input', () => {
    expect(() => unpackExepack(new Uint8Array([0, 0, 0, 0]))).toThrow(ExepackError);
  });

  it('throws when the RB signature is missing', () => {
    const fixture = buildExepackFixture();
    // Corrupt the signature word (last 2 bytes of the 16-byte exepack header, at body offset epk+14 = 16+14 = 30, file offset 32+30=62).
    fixture[62] = 0x00;
    fixture[63] = 0x00;
    expect(() => unpackExepack(fixture)).toThrow(/RB/);
  });
});
