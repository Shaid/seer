/**
 * Retail ticket parsing, against synthetic tickets built here.
 *
 * Every key byte in this file is invented. The point of the test is the
 * *offset arithmetic* — ticket-data starts after a signature block whose
 * length depends on `sig_type`, so getting the type table wrong reads two
 * plausible-looking 16-byte fields from the wrong place.
 */
import { describe, it, expect } from 'vitest';

import { parseTicket } from '../ticket.js';

/** Synthetic, not a real title key: 00 11 22 … ff. */
const FAKE_TITLEKEY = Uint8Array.from({ length: 16 }, (_, i) => i * 0x11);
const FAKE_TITLEKEY_HEX = '00112233445566778899aabbccddeeff';
/** Synthetic Rights ID: a made-up title id followed by key-generation 3. */
const FAKE_RIGHTS_ID = Uint8Array.from([
  0x01, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 3,
]);
const FAKE_RIGHTS_ID_HEX = '0100deadbeef00000000000000000003';

/** Signature-block + padding sizes for the three types exercised below. */
const LAYOUT: Record<number, [sig: number, pad: number]> = {
  0x010000: [0x200, 0x3c], // RSA-4096
  0x010004: [0x100, 0x3c], // RSA-2048, the one retail tickets actually use
  0x010006: [0x14, 0x28], // ECDSA
};

function buildTicket(sigType: number): Uint8Array {
  const [sigSize, padSize] = LAYOUT[sigType]!;
  const ticketData = 4 + sigSize + padSize;
  const tik = new Uint8Array(ticketData + 0x180);
  new DataView(tik.buffer).setUint32(0, sigType, true);
  // Fill the signature block with noise so a wrong offset reads garbage
  // rather than zeros, which would still look like a plausible key.
  for (let i = 4; i < ticketData; i++) tik[i] = (i * 31) & 0xff;
  tik.set(FAKE_TITLEKEY, ticketData + 0x40);
  tik[ticketData + 0x145] = 0; // ticket's own master-key revision
  tik.set(FAKE_RIGHTS_ID, ticketData + 0x160);
  return tik;
}

describe('parseTicket', () => {
  it.each(Object.keys(LAYOUT).map((k) => [`0x${Number(k).toString(16)}`, Number(k)] as const))(
    'finds ticket-data past the signature block for sig_type %s',
    (_label, sigType) => {
      expect(parseTicket(buildTicket(sigType))).toEqual({
        rightsId: FAKE_RIGHTS_ID_HEX,
        rawTitlekeyHex: FAKE_TITLEKEY_HEX,
      });
    },
  );

  it('returns the title key block untouched, not titlekek-decrypted', () => {
    // The contract the consumer depends on: these are the bytes that were
    // in the file, verbatim. Unwrapping here makes hactool unwrap twice.
    const tik = buildTicket(0x010004);
    const ticketData = 4 + 0x100 + 0x3c;
    const { rawTitlekeyHex } = parseTicket(tik);
    const stored = Array.from(tik.subarray(ticketData + 0x40, ticketData + 0x50))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(rawTitlekeyHex).toBe(stored);
  });

  it('refuses a signature type whose layout is unknown', () => {
    const tik = new Uint8Array(0x400);
    new DataView(tik.buffer).setUint32(0, 0x010009, true);
    expect(() => parseTicket(tik)).toThrow(/unknown ticket signature type 0x10009/);
  });

  it('refuses a buffer too short to hold a signature type', () => {
    expect(() => parseTicket(new Uint8Array(2))).toThrow(/too small/);
  });
});
