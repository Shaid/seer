/**
 * Retail Nintendo Switch Ticket (`.tik`) parsing — just enough to get a
 * Rights-ID-crypto NCA (every DLC and BKTR update-patch NSP carries one)
 * decrypted without a pre-populated `title.keys`.
 *
 * Structure per switchbrew.org/wiki/Ticket: a variable-size signature block
 * whose length depends on `sig_type`, followed by a fixed-layout
 * ticket-data struct. The 16-byte "title key block" sits at
 * ticket-data + 0x40 and the Rights ID at ticket-data + 0x160.
 *
 * **The title key comes back RAW — do not AES-decrypt it here.** The
 * consumer (`hactool`'s `--titlekey=`, or any other NCA reader) performs
 * the final titlekek decryption itself, keyed off the *NCA header's* own
 * Master Key Revision field — which can, and in the wild does, disagree
 * with the ticket's own "master key revision" byte at ticket-data + 0x145.
 * Confirmed empirically while extracting Fire Emblem Warriors'
 * Fates/Awakening/Shadow Dragon DLC packs (2026-08-27): a ticket declaring
 * `master key revision = 0` decrypting content whose NCA header declares
 * `Master Key Revision: 0x2`. Pre-decrypting with `titlekek_00` and handing
 * the result on made the reader decrypt a second time and corrupt the
 * RomFS section; handing over the untouched ticket bytes works.
 *
 * Nothing in this module needs, reads or derives a console key — it is a
 * field read out of a file the user already has.
 */

import { dataViewOf, hexAt } from '@seer-project/core';

/** Signature-block and alignment-padding sizes, keyed by `sig_type`. */
const SIG_SIZES: Record<number, number> = {
  0x010000: 0x200,
  0x010001: 0x100,
  0x010002: 0x3c,
  0x010003: 0x200,
  0x010004: 0x100,
  0x010005: 0x3c,
  0x010006: 0x14,
};
const PAD_SIZES: Record<number, number> = {
  0x010000: 0x3c,
  0x010001: 0x3c,
  0x010002: 0x40,
  0x010003: 0x3c,
  0x010004: 0x3c,
  0x010005: 0x40,
  0x010006: 0x28,
};

export interface SwitchTicket {
  /** 16-byte Rights ID as lowercase hex — the NCA field this ticket answers. */
  rightsId: string;
  /** The 16-byte title key block as lowercase hex, still titlekek-encrypted. */
  rawTitlekeyHex: string;
}

/**
 * Read a ticket's Rights ID and its raw (still encrypted) title key block.
 * Throws on a signature type the layout table does not cover, since the
 * ticket-data offset would otherwise be a guess.
 */
export function parseTicket(tik: Uint8Array): SwitchTicket {
  if (tik.length < 4) throw new Error('ticket: too small');
  const sigType = dataViewOf(tik).getUint32(0, true);
  const sigSize = SIG_SIZES[sigType];
  const padSize = PAD_SIZES[sigType];
  if (sigSize === undefined || padSize === undefined) {
    throw new Error(`unknown ticket signature type 0x${sigType.toString(16)}`);
  }
  const ticketData = 4 + sigSize + padSize;
  return {
    rightsId: hexAt(tik, ticketData + 0x160, 0x10),
    rawTitlekeyHex: hexAt(tik, ticketData + 0x40, 0x10),
  };
}
