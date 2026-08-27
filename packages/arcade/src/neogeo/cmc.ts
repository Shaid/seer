/**
 * NEO-CMC sprite ROM decryption (CMC42 / CMC50 chips).
 *
 * Port of MAME's `cmc_prot_device::decrypt()` + `gfx_decrypt()` +
 * chip-table selection (`cmc42_gfx_decrypt` / `cmc50_gfx_decrypt`) from
 * src/devices/bus/neogeo/prot_cmc.cpp. Operates IN PLACE on the merged
 * "cslot1:sprites" region exactly as MAME assembles it.
 *
 * Per-set usage (cart devices in bus/neogeo/{sma,pvc}.cpp):
 *   kof99    CMC42 extra_xor 0x00   garou/garouh CMC42 0x06
 *   svc      CMC50 extra_xor 0x57   kof2003      CMC50 0x9d
 *
 * NOTE: these sets' fix-layer tiles also come encrypted out of the sprite
 * banks (via MAME's `sfix_decrypt`, not ported here) — sprite atlases only.
 */

import {
  KOF99_TYPE0_T03,
  KOF99_TYPE0_T12,
  KOF99_TYPE1_T03,
  KOF99_TYPE1_T12,
  KOF99_ADDRESS_8_15_XOR1,
  KOF99_ADDRESS_8_15_XOR2,
  KOF99_ADDRESS_16_23_XOR1,
  KOF99_ADDRESS_16_23_XOR2,
  KOF99_ADDRESS_0_7_XOR,
  KOF2000_TYPE0_T03,
  KOF2000_TYPE0_T12,
  KOF2000_TYPE1_T03,
  KOF2000_TYPE1_T12,
  KOF2000_ADDRESS_8_15_XOR1,
  KOF2000_ADDRESS_8_15_XOR2,
  KOF2000_ADDRESS_16_23_XOR1,
  KOF2000_ADDRESS_16_23_XOR2,
  KOF2000_ADDRESS_0_7_XOR,
} from './cmc-tables.js';

interface CmcTables {
  type0_t03: readonly number[];
  type0_t12: readonly number[];
  type1_t03: readonly number[];
  type1_t12: readonly number[];
  address_8_15_xor1: readonly number[];
  address_8_15_xor2: readonly number[];
  address_16_23_xor1: readonly number[];
  address_16_23_xor2: readonly number[];
  address_0_7_xor: readonly number[];
}

const CMC42_TABLES: CmcTables = {
  type0_t03: KOF99_TYPE0_T03,
  type0_t12: KOF99_TYPE0_T12,
  type1_t03: KOF99_TYPE1_T03,
  type1_t12: KOF99_TYPE1_T12,
  address_8_15_xor1: KOF99_ADDRESS_8_15_XOR1,
  address_8_15_xor2: KOF99_ADDRESS_8_15_XOR2,
  address_16_23_xor1: KOF99_ADDRESS_16_23_XOR1,
  address_16_23_xor2: KOF99_ADDRESS_16_23_XOR2,
  address_0_7_xor: KOF99_ADDRESS_0_7_XOR,
};

const CMC50_TABLES: CmcTables = {
  type0_t03: KOF2000_TYPE0_T03,
  type0_t12: KOF2000_TYPE0_T12,
  type1_t03: KOF2000_TYPE1_T03,
  type1_t12: KOF2000_TYPE1_T12,
  address_8_15_xor1: KOF2000_ADDRESS_8_15_XOR1,
  address_8_15_xor2: KOF2000_ADDRESS_8_15_XOR2,
  address_16_23_xor1: KOF2000_ADDRESS_16_23_XOR1,
  address_16_23_xor2: KOF2000_ADDRESS_16_23_XOR2,
  address_0_7_xor: KOF2000_ADDRESS_0_7_XOR,
};

/** Direct port of cmc_prot_device::decrypt(). */
function decryptLane(
  tables: CmcTables,
  c0: number,
  c1: number,
  table0hi: readonly number[],
  table0lo: readonly number[],
  table1: readonly number[],
  base: number,
  invert: boolean,
): [number, number] {
  const tmp = table1[(base & 0xff) ^ tables.address_0_7_xor[(base >> 8) & 0xff]];
  const xor0 = (table0hi[(base >> 8) & 0xff] & 0xfe) | (tmp & 0x01);
  const xor1 = (tmp & 0xfe) | (table0lo[(base >> 8) & 0xff] & 0x01);

  return invert ? [c1 ^ xor0, c0 ^ xor1] : [c0 ^ xor0, c1 ^ xor1];
}

/** Decrypt the sprite region in place. `extraXor` is the per-game key byte. */
export function cmcGfxDecrypt(rom: Uint8Array, chip: 'cmc42' | 'cmc50', extraXor: number): void {
  const t = chip === 'cmc42' ? CMC42_TABLES : CMC50_TABLES;
  const romSize = rom.length;
  if (romSize % 4 !== 0)
    throw new Error(`cmcGfxDecrypt: region size ${romSize} not a multiple of 4`);

  // Data xor
  const buf = new Uint8Array(romSize);
  for (let rpos = 0; rpos < Math.floor(romSize / 4); rpos++) {
    const base4 = rpos * 4;
    const [r0, r3] = decryptLane(
      t,
      rom[base4],
      rom[base4 + 3],
      t.type0_t03,
      t.type0_t12,
      t.type1_t03,
      rpos,
      ((rpos >> 8) & 1) === 1,
    );
    buf[base4] = r0;
    buf[base4 + 3] = r3;
    const [r1, r2] = decryptLane(
      t,
      rom[base4 + 1],
      rom[base4 + 2],
      t.type0_t12,
      t.type0_t03,
      t.type1_t12,
      rpos,
      (((rpos >> 16) ^ t.address_16_23_xor2[(rpos >> 8) & 0xff]) & 1) === 1,
    );
    buf[base4 + 1] = r1;
    buf[base4 + 2] = r2;
  }

  // Address xor
  for (let rpos = 0; rpos < Math.floor(romSize / 4); rpos++) {
    let baser = rpos;

    baser ^= extraXor;

    baser ^= t.address_8_15_xor1[(baser >> 16) & 0xff] << 8;
    baser ^= t.address_8_15_xor2[baser & 0xff] << 8;
    baser ^= t.address_16_23_xor1[baser & 0xff] << 16;
    baser ^= t.address_16_23_xor2[(baser >> 8) & 0xff] << 16;
    baser ^= t.address_0_7_xor[(baser >> 8) & 0xff];

    // Clamp to the real rom size (the preisle2/kf2k3pcb special cases in
    // MAME don't apply to any set this project ships).
    baser &= Math.floor(romSize / 4) - 1;

    const dst = rpos * 4;
    const srcp = baser * 4;
    rom[dst] = buf[srcp];
    rom[dst + 1] = buf[srcp + 1];
    rom[dst + 2] = buf[srcp + 2];
    rom[dst + 3] = buf[srcp + 3];
  }
}

/**
 * NeoGeo fix-layer decryption for CMC-encrypted sets.
 *
 * Port of MAME's `cmc_prot_device::sfix_decrypt()`. The fix-layer data is
 * stored at the end of the encrypted sprite ROM; this extracts and decodes
 * it into the provided `fixed` buffer.
 *
 * @param rom   Full encrypted sprite ROM data (read-only source).
 * @param fixed Output buffer (typically last 8192 bytes of `rom`) — overwritten in place.
 */
export function sfixDecrypt(rom: Uint8Array, fixed: Uint8Array): void {
  const txSize = fixed.length;
  const srcStart = rom.length - txSize;
  for (let i = 0; i < txSize; i++) {
    fixed[i] = rom[srcStart + ((i & ~0x1f) + ((i & 7) << 2) + ((~i & 8) >> 2) + ((i & 0x10) >> 4))];
  }
}
