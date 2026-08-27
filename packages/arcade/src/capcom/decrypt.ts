/**
 * Capcom Play System 2 (CPS2) 68000 opcode decryption.
 *
 * CPS2 boards encrypt 68000 *opcode* fetches (not data reads) with a
 * per-game 64-bit key, using two 4-round Feistel networks keyed off both
 * the ciphertext word and the low 16 bits of the address. The algorithm
 * was broken by Andreas Naive/Nicola Salmoria and has been public/shipped
 * in MAME's driver source for years; this is a straight port of radare2's
 * own implementation (`libr/muta/p/muta_cps2.c`, itself a port of MAME's),
 * with the s-box/permutation tables mechanically extracted (not
 * hand-transcribed — see `decrypt-tables.ts`'s header comment) to avoid
 * transcription errors in ~1500 constants.
 *
 * Two key formats are supported, matching what real CPS2 hardware/dumps
 * provide:
 *  - `keyBytes.length === 8`: the historical MAME-hardcoded raw 64-bit key
 *    (2x big-endian u32).
 *  - `keyBytes.length === 20`: the raw 160-bit battery-backed key-custom
 *    dump (what a `<game>.key` file in a MAME romset holds) — this is the
 *    format `ddsom.key` uses. It is bit-descrambled into the 64-bit key
 *    (plus the encrypted address range) via the same `bit = (317 - b) %
 *    160` permutation radare2 and MAME's own driver use.
 *
 * Confidence: **confirmed**. The cipher/tables are a mechanically-extracted
 * port verified byte-for-byte identical to radare2's own `cps2` muta
 * plugin's output (`r2 -c "woD cps2 <key>"`) on the same input. The key/
 * range decode matches `historic-mame`'s independently-sourced hardcoded
 * per-game key table exactly (master key, watchdog instruction, and
 * encrypted-range size all agree). And decrypting ddsom's real ROM with it
 * produces a plausible 68000 reset vector plus 60+ consecutive valid,
 * coherent instructions at the entry point — see
 * `docs/ddsom/cps2/data-structure.md` § "68000 program encryption" for the
 * full evidence chain.
 */
import {
  fn1GroupA,
  fn1GroupB,
  fn2GroupA,
  fn2GroupB,
  fn1Boxes,
  fn2Boxes,
  expand1stKeyBits,
  expand2ndKeyBits,
  expandSubkeyBits,
  type SBox,
} from './decrypt-tables.js';

function bit(x: number, n: number): number {
  return (x >>> n) & 1;
}

interface OptimisedSBox {
  inputLookup: Uint8Array; // 256 entries, 6-bit lookup value per possible input byte
  output: Uint8Array; // 64 entries, sparse output byte (bits at outputs[0]/outputs[1] only)
}

function optimiseSBox(box: SBox): OptimisedSBox {
  const inputLookup = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let res = 0;
    for (let j = 0; j < 6; j++) {
      const inputBit = box.inputs[j];
      if (inputBit !== -1) res |= bit(i, inputBit) << j;
    }
    inputLookup[i] = res;
  }
  const output = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const o = box.table[i];
    let out = 0;
    if (o & 1) out |= 1 << box.outputs[0];
    if (o & 2) out |= 1 << box.outputs[1];
    output[i] = out;
  }
  return { inputLookup, output };
}

function optimiseBoxRound(boxes: SBox[]): OptimisedSBox[] {
  return boxes.map(optimiseSBox);
}

// Precomputed once at module load: [round][box] for each FN, 4 rounds x 4 boxes.
const FN1_OPT: OptimisedSBox[][] = fn1Boxes.map(optimiseBoxRound);
const FN2_OPT: OptimisedSBox[][] = fn2Boxes.map(optimiseBoxRound);

function fn(input: number, boxes: OptimisedSBox[], key: number): number {
  return (
    boxes[0].output[boxes[0].inputLookup[input] ^ ((key >>> 0) & 0x3f)] |
    boxes[1].output[boxes[1].inputLookup[input] ^ ((key >>> 6) & 0x3f)] |
    boxes[2].output[boxes[2].inputLookup[input] ^ ((key >>> 12) & 0x3f)] |
    boxes[3].output[boxes[3].inputLookup[input] ^ ((key >>> 18) & 0x3f)]
  );
}

function bitswap8(val: number, order: number[]): number {
  // order[k] = source bit index (of val) that becomes destination bit k.
  let out = 0;
  for (let k = 0; k < 8; k++) out |= bit(val, order[k]) << k;
  return out;
}

function feistel(
  val: number,
  bitsA: number[],
  bitsB: number[],
  roundBoxes: OptimisedSBox[][], // 4 rounds, applied in array order
  keys: [number, number, number, number],
): number {
  let l = bitswap8(val, bitsB);
  let r = bitswap8(val, bitsA);

  l ^= fn(r, roundBoxes[0], keys[0]);
  r ^= fn(l, roundBoxes[1], keys[1]);
  l ^= fn(r, roundBoxes[2], keys[2]);
  r ^= fn(l, roundBoxes[3], keys[3]);

  let out = 0;
  for (let k = 0; k < 8; k++) {
    out |= ((l >>> k) & 1) << bitsA[k];
    out |= ((r >>> k) & 1) << bitsB[k];
  }
  return out;
}

/** Expand a 96-bit key from a 64-bit source using a fixed bit-selection table (shared shape for both the 1st- and 2nd-FN key schedules). */
function expandKey96(srcKey: [number, number], bits: number[]): [number, number, number, number] {
  const dst: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 96; i++) {
    const b = bits[i];
    const word = srcKey[Math.floor(b / 32)];
    dst[Math.floor(i / 24)] |= bit(word, b % 32) << (i % 24);
  }
  return dst;
}

function expandSubkey(seed: number): [number, number] {
  const subkey: [number, number] = [0, 0];
  for (let i = 0; i < 64; i++) {
    const b = expandSubkeyBits[i];
    subkey[Math.floor(i / 32)] |= bit(seed, b) << (i % 32);
  }
  return subkey;
}

export interface Cps2KeyInfo {
  masterKey: [number, number];
  /** Encrypted-range bounds in bytes, matching MAME's `init_cps2crypt()` (`src/mame/capcom/cps2.cpp`). Opcode fetches outside [lower, upper) are not decrypted. */
  lower: number;
  upper: number;
  /** The 3-word 68000 watchdog-trigger instruction the game must execute periodically to keep decryption enabled, MSB-first (decoded[6], decoded[5], decoded[4]). Documentary/cross-check value only — not needed to decrypt. */
  watchdogInstructionWords: [number, number, number];
  /** Raw 10x u16 decode of the key file, in case a future game's slot 7/8 fields matter. */
  raw: Uint16Array;
}

/**
 * Decode the 20-byte battery-backed CPS2 key-custom dump (a `<game>.key`
 * ROM region) into the master key and encrypted-address-range bounds, per
 * radare2's `set_key()` (`keylen == 20` case) *and* MAME's own
 * `cps2_state::init_cps2crypt()` (`src/mame/capcom/cps2.cpp`) — both use
 * the identical `bit = (317 - b) % 160` bit-descrambling formula.
 *
 * Confirmed byte-exact against `historic-mame`'s hardcoded per-game key
 * table (`src/mame/machine/cps2crpt.c`): for ddsom this decodes to
 * masterKey `[0x87889abc, 0xd81f5f63]`, watchdog instruction
 * `0C81 1966 0419` ("cmpi.l #$19660419,D1"), and upper `0x100000` — all
 * three independently match the historic table's
 * `{ "ddsom", { 0x87889abc,0xd81f5f63 }, 0x100000 }` comment/entry exactly.
 * See docs/ddsom/cps2/data-structure.md § "68000 program encryption".
 */
export function decodeCps2Key20(key: Uint8Array): Cps2KeyInfo {
  if (key.length !== 20) throw new Error(`Expected a 20-byte CPS2 key, got ${key.length}`);
  const decoded = new Uint16Array(10);
  for (let b = 0; b < 10 * 16; b++) {
    const srcBit = (317 - b) % 160;
    if ((key[Math.floor(srcBit / 8)] >> ((srcBit ^ 7) % 8)) & 1) {
      decoded[Math.floor(b / 16)] |= 0x8000 >> (b % 16);
    }
  }
  const masterKey: [number, number] = [
    (decoded[0] << 16) | decoded[1],
    (decoded[2] << 16) | decoded[3],
  ];

  let lower: number;
  let upper: number;
  if (decoded[9] === 0xffff) {
    // Dead board: the only "encrypted" range is FF0000-FFFFFF (doesn't start at 0).
    lower = 0xff0000;
    upper = 0xffffff;
  } else {
    lower = 0;
    upper = (((~decoded[9] & 0x3ff) << 14) | 0x3fff) + 1;
  }

  return {
    masterKey,
    lower,
    upper,
    watchdogInstructionWords: [decoded[6], decoded[5], decoded[4]],
    raw: decoded,
  };
}

/** Decode the historical 8-byte hardcoded MAME key format (2x big-endian u32). */
export function decodeCps2Key8(key: Uint8Array): [number, number] {
  if (key.length !== 8) throw new Error(`Expected an 8-byte CPS2 key, got ${key.length}`);
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  return [view.getUint32(0, false), view.getUint32(4, false)];
}

/**
 * Decrypt a CPS2 "maincpu" opcode region.
 *
 * **`rom` must be the RAW, un-byteswapped ROM-chip dump bytes** (the
 * program ROM files concatenated in ROM_LOAD order, with *no*
 * ROM_LOAD16_WORD_SWAP applied) — NOT MAME's own swapped "maincpu" memory
 * region. This is non-obvious and worth spelling out: MAME's real
 * `cps2_decrypt()` (`src/mame/capcom/cps2.cpp`) is handed
 * `memregion("maincpu")->base()` cast to `uint16_t*` — i.e. it reads each
 * source word via a *native* (host, little-endian on x86) 16-bit load from
 * a region whose bytes were stored in big-endian order by the
 * ROM_LOAD16_WORD_SWAP loader. Reading big-endian-stored bytes through a
 * little-endian load reverses them — which exactly cancels the loader's
 * own swap back out, leaving the original, un-swapped dump byte order as
 * what the cipher actually consumes. Confirmed empirically: decrypting the
 * swapped region yields a nonsense reset vector (`SP=0xfc601869`, top byte
 * far outside the 24-bit address space); decrypting the *raw* concatenation
 * yields `SP=0x00ff0e66, PC=0x00000350` — a plausible work-RAM stack
 * pointer and ROM entry point — and disassembling at that PC produces 60+
 * consecutive valid, coherent 68000 instructions (hardware register init,
 * a RAM-clear loop, `cmpi.l #$19660419,d1` — the exact watchdog
 * instruction independently decoded from the key file — subroutine calls).
 * See docs/ddsom/cps2/data-structure.md § "68000 program encryption".
 *
 * The *output* of this function, and the "maincpu" data-space region built
 * via `rom-regions.ts`'s `swapWordBytes()`/`loadWordSwapped()`, are two
 * different logical views of the same ROM: opcode fetches within
 * `[lower, upper)` see this function's decrypted output; ordinary data
 * reads (and opcode fetches at/past `upper`) see the byteswapped region.
 * Exception *vector table* reads are a further special case — see the doc.
 *
 * Returns a same-length buffer holding the decrypted opcode stream, with
 * bytes at/past `upperLimit` copied through byte-swapped (matching the
 * data-space region) rather than decrypted, per the reference algorithm.
 * `upperLimit` is the encrypted range's end (exclusive, in bytes) — CPS2's
 * encryption does not necessarily cover the whole ROM (see
 * `decodeCps2Key20()`'s `upper`).
 */
export function cps2Decrypt(
  rom: Uint8Array,
  masterKey: [number, number],
  upperLimit: number,
): Uint8Array {
  const length = rom.length;
  const dec = new Uint8Array(length);
  const srcView = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const dstView = new DataView(dec.buffer, dec.byteOffset, dec.byteLength);

  const key1Base = expandKey96(masterKey, expand1stKeyBits);
  const key1: [number, number, number, number] = [...key1Base];
  key1[0] ^= bit(key1[0], 1) << 4;
  key1[0] ^= bit(key1[0], 2) << 5;
  key1[0] ^= bit(key1[0], 8) << 11;
  key1[1] ^= bit(key1[1], 0) << 5;
  key1[1] ^= bit(key1[1], 8) << 11;
  key1[2] ^= bit(key1[2], 1) << 5;
  key1[2] ^= bit(key1[2], 8) << 11;

  const wordCount = length >>> 1;
  const upperLimitWords = upperLimit >>> 1;

  for (let i = 0; i < 0x10000; i++) {
    const seed = feistel(i, fn1GroupA, fn1GroupB, FN1_OPT, key1);

    const subkey = expandSubkey(seed);
    subkey[0] ^= masterKey[0];
    subkey[1] ^= masterKey[1];

    const key2 = expandKey96(subkey, expand2ndKeyBits);
    key2[0] ^= bit(key2[0], 0) << 5;
    key2[0] ^= bit(key2[0], 6) << 11;
    key2[1] ^= bit(key2[1], 0) << 5;
    key2[1] ^= bit(key2[1], 1) << 4;
    key2[2] ^= bit(key2[2], 2) << 5;
    key2[2] ^= bit(key2[2], 3) << 4;
    key2[2] ^= bit(key2[2], 7) << 11;
    key2[3] ^= bit(key2[3], 1) << 5;

    let a = i;
    for (; a < wordCount && a < upperLimitWords; a += 0x10000) {
      const offset = a * 2;
      const word = srcView.getUint16(offset, true); // read LE
      const decoded = feistel(word, fn2GroupA, fn2GroupB, FN2_OPT, key2);
      dstView.setUint16(offset, decoded, false); // write BE
    }
    for (; a < wordCount; a += 0x10000) {
      const offset = a * 2;
      dstView.setUint16(offset, srcView.getUint16(offset, false), true);
    }
  }

  return dec;
}
