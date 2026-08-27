/**
 * CPS3 (Capcom Play System 3) program-ROM decryption.
 *
 * Direct port of MAME `cps3_state::cps3_mask()` / `rotxor()` /
 * `rotate_left()` (`src/mame/capcom/cps3.cpp`) — the cipher Andreas Naive
 * cracked for the CPS3 security-cart SH-2. The SIMMs in positions 1-2 hold
 * the 68000... no, the *SH-2* program, encrypted with an address-derived
 * XOR mask keyed by two 32-bit per-game constants:
 *
 *   decrypted_dword = raw_dword ^ cps3_mask(rom_address, key1, key2)
 *
 * where `rom_address` for SIMM1 is `0x06000000 + offset`, SIMM2 is
 * `0x06800000 + offset` (MAME's `decrypt_gamerom` loop XORs at those bases;
 * the raw dword is assembled big-endian from a pair of interleaved flash
 * chips: `(chip0[i]<<24)|(chip1[i]<<16)|(chip2[i]<<8)|chip3[i]` for the
 * 4-flash SIMM-1 layout; MAME stores the result as a host little-endian
 * u32, which this port reproduces by writing the dword bytes LE).
 *
 * Verified this session against a real `sfiii3n` dump: after decryption the
 * image disassembles (capstone SH-2, big-endian) as coherent code starting
 * `bra 0x20`, and the reset/vector area carries handler pointers into the
 * `0x06000000` region (e.g. bytes `18 04 00 06` = LE `0x06000418`).
 *
 * Per-game keys (MAME `cps3_state::init_*`):
 *
 *   redearth / warzard  0x9e300ab1, 0xa175b82c
 *   sfiii  (new gen)    0xb5fe053e, 0xfc03925a
 *   sfiii2 (dead cart)  0x00000000, 0x00000000
 *   jojo                0x02203ee3, 0x01301972
 *   sfiii3 (3rd strike) 0xa55432b4, 0x0c129981
 *   jojoba              0x23323ee3, 0x03021972
 */

function rotateLeft(u16n: number, n: number): number {
  const aux = u16n >> (16 - n);
  return ((u16n << n) | aux) % 0x10000;
}

function rotxor(val: number, xorval: number): number {
  let res = (val + rotateLeft(val, 2)) % 0x10000;
  res = (rotateLeft(res, 4) ^ (res & (val ^ xorval))) % 0x10000;
  return res;
}

/**
 * Compute the 32-bit XOR mask applied to one encrypted program dword at
 * `address`, for the game's decryption keys.
 */
export function cps3Mask(address: number, key1: number, key2: number): number {
  address ^= key1;

  let val: number = ((address & 0xffff) ^ 0xffff) & 0xffff;
  val = rotxor(val, key2 & 0xffff);
  val ^= ((address >> 16) ^ 0xffff) & 0xffff;
  val &= 0xffff;
  val = rotxor(val, key2 >> 16);
  val ^= ((address & 0xffff) ^ (key2 & 0xffff)) & 0xffff;
  val &= 0xffff;

  return (val | (val << 16)) >>> 0;
}

/**
 * Decrypt one host-endian byte image of an encrypted CPS3 program region.
 * `raw` is the assembled 4-flash interleave (per MAME: dword = chip0<<24 |
 * chip1<<16 | chip2<<8 | chip3, stored as native LE bytes — i.e. pass the
 * byte image MAME's encrypted `u32` array holds in memory). `regionBase` is
 * the CPU ROM address of byte 0 (0x06000000 for SIMM1, 0x06800000 for
 * SIMM2). XOR is symmetric, so this both decrypts and re-encrypts.
 */
export function cps3DecryptProgram(
  raw: Uint8Array,
  regionBase: number,
  key1: number,
  key2: number,
): Uint8Array {
  const out = new Uint8Array(raw.length);
  for (let i = 0; i + 4 <= raw.length; i += 4) {
    // MAME reads the program as u32; host-little-endian byte order in memory.
    const dword = (raw[i + 3] << 24) | (raw[i + 2] << 16) | (raw[i + 1] << 8) | raw[i];
    const mask = cps3Mask(regionBase + i, key1, key2);
    const dec = (dword ^ mask) >>> 0;
    out[i] = dec & 0xff;
    out[i + 1] = (dec >>> 8) & 0xff;
    out[i + 2] = (dec >>> 16) & 0xff;
    out[i + 3] = (dec >>> 24) & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graphics: user5 assembly + decompression primitives
// ---------------------------------------------------------------------------

/**
 * Assemble MAME's "user5" region (8MB chars + sound source) from the graphics
 * SIMM flash chips. MAME (cps3.cpp `romdata` fill loop) walks flash slots in
 * SIMMs 3-7 as 2-chip pairs and produces one host-LE u32 per input byte-pair:
 *
 *   word = (f0[i+0]<<8) | (f0[i+1]<<24) | (f1[i+0]<<0) | (f1[i+1]<<16)
 *
 * stored as native (little-endian host) u32 bytes. `pairs` is ordered
 * [[f0, f1], ...]; each chip is 2MB. The caller picks which simm files to
 * feed (e.g. the 6-graphics-simm layout of sfiii3n). Returns the assembled
 * LE byte image (the same `m_user5` MAME's decompressor reads).
 */
export function assembleCps3User5(pairs: Uint8Array[][]): Uint8Array {
  let total = 0;
  for (const [f0] of pairs) total += f0.length * 2;
  const out = new Uint8Array(total);
  let o = 0;
  for (const [f0, f1] of pairs) {
    for (let i = 0; i + 1 < f0.length; i += 2) {
      const b0 = f0[i + 0];
      const b1 = f0[i + 1];
      const c0 = f1[i + 0];
      const c1 = f1[i + 1];
      const word = (b0 << 8) | (b1 << 24) | (c0 << 0) | (c1 << 16);
      out[o++] = word & 0xff;
      out[o++] = (word >>> 8) & 0xff;
      out[o++] = (word >>> 16) & 0xff;
      out[o++] = (word >>> 24) & 0xff;
    }
  }
  return out;
}

/** Byte-swap applied to DMA source reads on a little-endian host (MAME `DMA_XOR`). */
export const CPS3_DMA_XOR = 1;

/**
 * In-memory state for MAME's `process_character_dma` decompressor. Tiles are
 * decompressed into `charRam` (0x800000 bytes, the "spriteram"). The DMA
 * command list (which sources/dests trigger runs) is built at runtime by the
 * game's SH-2, so a caller supplies per-run source/dest/length — see the
 * doc in docs/cps/cps3.md §3 for why that list is not statically present.
 */
export class Cps3CharDma {
  readonly charRam = new Uint8Array(0x800000);
  private lastNormal = 0;

  /** One little-endian read from the assembled user5 region (byte-swapped). */
  private readUser5(source: number): number {
    return this.user5[(source ^ CPS3_DMA_XOR) & 0x7fffff] & 0xff;
  }

  constructor(user5: Uint8Array) {
    this.user5 = user5;
  }
  private readonly user5: Uint8Array;

  /**
   * MAME `process_byte` (6bpp path): writes `realByte`-encoded pixels to
   * charRam at `destination`. Returns bytes written.
   */
  processByte(realByte: number, destination: number): number {
    destination &= 0x7fffff;
    if (realByte & 0x40) {
      // RLE: repeat last normal byte (low 6 bits of count).
      let n = 0;
      const count = (realByte & 0x3f) + 1;
      for (let k = 0; k < count; k++) {
        this.charRam[((destination + n) & 0x7fffff) ^ 3] = this.lastNormal & 0x3f;
        n++;
      }
      return n;
    }
    this.charRam[(destination & 0x7fffff) ^ 3] = realByte;
    this.lastNormal = realByte;
    return 1;
  }

  /**
   * MAME `ProcessByte8` (8bpp path): either an RLE run (two equal preceding
   * bytes -> repeat low byte `(b+1)&0xff` times) or a literal. Returns bytes
   * written.
   */
  processByte8(b: number, dstOffset: number): number {
    const dest = this.charRam;
    let l = 0;
    if (this.lastB === this.lastB2) {
      const rle = (b + 1) & 0xff;
      for (let i = 0; i < rle; i++) {
        dest[(dstOffset & 0x7fffff) ^ 3] = this.lastB;
        dstOffset++;
        l++;
      }
      this.lastB2 = 0xffff;
      return l;
    }
    this.lastB2 = this.lastB;
    this.lastB = b;
    dest[(dstOffset & 0x7fffff) ^ 3] = b;
    return 1;
  }
  private lastB: number = 0xfffe;
  private lastB2: number = 0xffff;

  /**
   * MAME `do_char_dma` (6bpp): decompress `length` output bytes into
   * charRam starting at `destination`, from `source` in user5. `tableAddr`
   * is the decompression table base set by DMA command 4.
   */
  doCharDma(source: number, destination: number, length: number, tableAddr: number): void {
    this.lastNormal = 0;
    let remaining = length;
    while (remaining) {
      const cb = this.readUser5(source);
      source++;
      if (cb & 0x80) {
        // table pair run
        const idx = cb & 0x7f;
        let used = this.processByte(this.readUser5(tableAddr + idx * 2 + 0), destination);
        remaining -= used;
        destination += used;
        if (destination > 0x7fffff || remaining <= 0) return;
        used = this.processByte(this.readUser5(tableAddr + idx * 2 + 1), destination);
        remaining -= used;
        destination += used;
        if (destination > 0x7fffff || remaining <= 0) return;
      } else {
        const used = this.processByte(cb, destination);
        remaining -= used;
        destination += used;
        if (destination > 0x7fffff || remaining <= 0) return;
      }
    }
  }

  /**
   * MAME `do_alt_char_dma` (8bpp, SFIII New Gen "Sean's stage" style):
   * decompress into charRam. Each control byte selects, for 8 source bytes,
   * whether each is literal (0) or a table-pair reference (1).
   */
  doAltCharDma(source: number, destination: number, realLength: number, tableAddr: number): void {
    let ds = destination;
    const start = destination;
    this.lastB = 0xfffe;
    this.lastB2 = 0xffff;
    while (ds - start < realLength) {
      let ctrl = this.readUser5(source);
      source++;
      for (let i = 0; i < 8; i++) {
        const p = this.readUser5(source);
        source++;
        if (ctrl & 0x80) {
          ds += this.processByte8(this.readUser5(tableAddr + (p & 0x7f) * 2 + 0), ds);
          if (ds - start >= realLength) return;
          ds += this.processByte8(this.readUser5(tableAddr + (p & 0x7f) * 2 + 1), ds);
        } else {
          ds += this.processByte8(p, ds);
        }
        if (ds - start >= realLength) return;
        ctrl <<= 1; // next bit selects the next source byte
      }
    }
  }
}
