import { describe, it, expect } from 'vitest';
import { cmcGfxDecrypt } from '../neogeo/cmc.js';
import {
  KOF99_ADDRESS_0_7_XOR,
  KOF2000_TYPE0_T03,
  KOF99_TYPE0_T03,
  KOF99_TYPE0_T12,
  KOF99_TYPE1_T03,
} from '../neogeo/cmc-tables.js';

describe('cmc tables', () => {
  it('extracted tables have the expected spot values', () => {
    // First entries as they appear in prot_cmc.cpp
    expect(KOF99_ADDRESS_0_7_XOR[0]).toBe(0x74);
    expect(KOF99_ADDRESS_0_7_XOR[1]).toBe(0xad);
    expect(KOF2000_TYPE0_T03).toHaveLength(256);
  });
});

describe('cmcGfxDecrypt', () => {
  it('is deterministic and key-sensitive (no inverse available, so pin both properties)', () => {
    let seed = 12345;
    const make = (): Uint8Array =>
      Uint8Array.from({ length: 4096 }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed & 0xff;
      });
    const a = make();
    const b = Uint8Array.from(a);
    cmcGfxDecrypt(a, 'cmc42', 0x00);
    cmcGfxDecrypt(b, 'cmc42', 0x00);
    expect([...b]).toEqual([...a]);

    const c = Uint8Array.from(make());
    cmcGfxDecrypt(c, 'cmc42', 0x06); // garou's key: must differ from kof99's
    expect([...c]).not.toEqual([...a]);
  });

  it('rejects region sizes that are not a multiple of 4', () => {
    expect(() => cmcGfxDecrypt(new Uint8Array(10), 'cmc50', 0x57)).toThrow(/multiple of 4/);
  });

  it('computes group-0 lanes exactly per the ported decrypt() formula', () => {
    // Group 0: rpos=0 -> base=0, invert=false. Pins the lane math so a
    // refactor can't silently flip an index/xor.
    const rom = new Uint8Array(4);
    rom[0] = 0xab;
    rom[3] = 0xcd;
    const tmp = KOF99_TYPE1_T03[(0 & 0xff) ^ KOF99_ADDRESS_0_7_XOR[0]];
    const expectedR0 = 0xab ^ ((KOF99_TYPE0_T03[0] & 0xfe) | (tmp & 0x01));
    const expectedR3 = 0xcd ^ ((tmp & 0xfe) | (KOF99_TYPE0_T12[0] & 0x01));
    cmcGfxDecrypt(rom, 'cmc42', 0x00);
    expect(rom[0]).toBe(expectedR0);
    expect(rom[3]).toBe(expectedR3);
  });
});
