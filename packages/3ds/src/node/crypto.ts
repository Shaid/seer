/**
 * 3DS NCCH decryption helpers (Node-only). Covers what's needed to unpack a
 * sealed CIA content partition: parse the ticket, derive the NCCH keys from
 * the Citra `aes_keys.txt` key slots + common key Y + seed, and decrypt
 * ExeFS/RomFS regions with AES-CTR.
 *
 * Key scheme (per citra's ncch_container.cpp and pyctr):
 *   - Title key  = AES-CBC-decrypt(ticket.encTitleKey, commonKeyY[ci], IV=titleId‖zeros)
 *   - primary    = keygen(keyslot 0x2C keyX, titleKey)
 *   - seeded key = SHA256(titleKey ‖ seed)[0:16]  (only when uses_seed)
 *   - secondary  = keygen(keyslot 0x2D keyX, seededKey)
 *   - CTR for a section (NCCH version 0/2): reversed partition ID (8 bytes)
 *     ‖ section magic (0x01 exheader / 0x02 exefs / 0x03 romfs) ‖ zeros.
 *
 * The common key Y values are the well-known retail set (matching pyctr).
 */
import { createDecipheriv, createHash } from 'node:crypto';

/** Retail common key Y values (index 0 = eShop, 1 = System). */
export const COMMON_KEY_Y: string[] = [
  'D07B337F9CA4385932A2E25723232EB9',
  '0C767230F0998F1C46828202FAACBE4C',
  'C475CB3AB8C788BB575E12A10907B8A4',
  'E486EEE3D0C09C902F6686D4C06F649F',
  'ED31BA9C04B067506C4497A35B7804FC',
  '5E66998AB4E8931606850FD7A16DD755',
];

const KEYGEN_CONSTANT = 0x1ff9e9aac5fe0408024591dc5d52768an;

export interface AesKeySlot {
  x?: Buffer;
  y?: Buffer;
  n?: Buffer;
}

/** Parse a Citra-format `aes_keys.txt` (lines like `slot0x2CKeyX=HEX`). */
export function parseAesKeys(text: string): Map<number, AesKeySlot> {
  const slots = new Map<number, AesKeySlot>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const m = /^slot0x([0-9a-fA-F]+)Key([XYN])=([0-9a-fA-F]{32})$/.exec(line);
    if (!m) continue;
    const slot = parseInt(m[1]!, 16);
    const kind = m[2]! as 'X' | 'Y' | 'N';
    const value = Buffer.from(m[3]!, 'hex');
    const entry = slots.get(slot) ?? {};
    entry[kind.toLowerCase() as 'x' | 'y' | 'n'] = value;
    slots.set(slot, entry);
  }
  return slots;
}

function rol64(value: bigint, bits: number): bigint {
  return ((value << BigInt(bits)) | (value >> BigInt(128 - bits))) & ((1n << 128n) - 1n);
}

/** 3DS keyslot key generation: `ROL(ROL(KeyX, 2) XOR KeyY + CONST, 87)`. */
export function keygenNormal(keyX: Buffer, keyY: Buffer): Buffer {
  const a = BigInt('0x' + keyX.toString('hex'));
  const b = BigInt('0x' + keyY.toString('hex'));
  const out = rol64((rol64(a, 2) ^ b) + KEYGEN_CONSTANT, 87);
  const hex = out.toString(16).padStart(32, '0');
  return Buffer.from(hex, 'hex');
}

export interface TicketInfo {
  encTitleKey: Buffer;
  titleId: Buffer;
  commonKeyIndex: number;
}

/** Parse a ticket: title key at 0x1BF, title id at 0x1DC, common key index at 0x1F1. */
export function parseTicket(ticket: Uint8Array): TicketInfo {
  if (ticket.length < 0x2ac) throw new Error('Ticket too short');
  return {
    encTitleKey: Buffer.from(ticket.subarray(0x1bf, 0x1cf)),
    titleId: Buffer.from(ticket.subarray(0x1dc, 0x1e4)),
    commonKeyIndex: ticket[0x1f1]!,
  };
}

/** Decrypt the title key: AES-CBC(keygen(commonKeyX, commonKeyY[ci]), IV=titleId‖zeros), no padding. */
export function decryptTitleKey(ticket: TicketInfo, commonKeyX: Buffer = Buffer.alloc(16)): Buffer {
  const key = keygenNormal(
    commonKeyX,
    Buffer.from(COMMON_KEY_Y[ticket.commonKeyIndex] ?? COMMON_KEY_Y[0]!, 'hex'),
  );
  const iv = Buffer.concat([ticket.titleId, Buffer.alloc(8)]);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const dec = Buffer.concat([decipher.update(ticket.encTitleKey), decipher.final()]);
  return dec.subarray(0, 16);
}

/** AES-CBC decrypt (no padding). `iv` is the initial block; chaining uses the previous ciphertext block. */
export function cbcDecrypt(key: Buffer, iv: Uint8Array, data: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** `SHA256(keyY ‖ seed)[0:16]` — the seeded KeyY used for secondary-crypto titles. */
export function seedKeyY(keyY: Uint8Array, seed: Uint8Array): Buffer {
  return createHash('sha256').update(keyY).update(seed).digest().subarray(0, 16);
}

/** AES-CTR decrypt `data` with `key`, counter starting at `counter` (16 bytes, big-endian). */
export function ctrDecrypt(key: Buffer, counter: Buffer, data: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-128-ctr', key, counter);
  return Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]);
}

/** Increment a 16-byte big-endian counter by `n` (handles the 128-bit counter). */
export function addToCounter(counter: Buffer, n: number): Buffer {
  // AES-CTR counters are 128-bit and wrap. Without the mask an overflow would
  // produce 33 hex digits, which padStart leaves alone and Buffer.from then
  // truncates from the wrong end, silently yielding a bogus counter.
  const mask = (1n << 128n) - 1n;
  const value = (BigInt('0x' + counter.toString('hex')) + BigInt(n)) & mask;
  return Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
}

/** Build the 16-byte section counter: reversed partition id ‖ magic ‖ zeros. */
export function sectionCounter(partitionId: Buffer, magic: number): Buffer {
  const reversed = Buffer.from(partitionId).reverse();
  return Buffer.concat([reversed, Buffer.from([magic]), Buffer.alloc(7)]);
}
