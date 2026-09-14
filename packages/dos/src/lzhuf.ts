/**
 * Haruhiko Okumura's classic **LZHUF** codec: LZSS over a 4096-byte sliding
 * window (`N=4096`, max match length `F=60`, `THRESHOLD=2`), with literal
 * bytes and match-length codes driven by a single **adaptive** (dynamic-
 * tree) Huffman model, plus a static 6-bit-prefix table (`D_CODE`/`D_LEN`)
 * for the match-distance's upper bits.
 *
 * This module decodes exactly ONE independent LZHUF stream — model and ring
 * buffer are freshly initialised on every call to `lzhufDecompress`. Some
 * consumers (e.g. multi-entry archive containers) reset the model per
 * entry; that framing is container-specific and does not belong here — this
 * module is purely the codec.
 *
 * `D_CODE`/`D_LEN` depend only on the window size `N`, not on `F`, and are
 * reused verbatim from the public-domain reference `lzhuf.c`.
 */

const N = 4096; // LZSS ring-buffer size
const F = 60; // max match length
const THRESHOLD = 2;
const N_CHAR = 256 - THRESHOLD + F; // 314 — literal + match-length alphabet size
const T = N_CHAR * 2 - 1; // 627 — adaptive Huffman node table size
const R = T - 1; // 626 — root node index
const MAX_FREQ = 0x8000;

/**
 * Static 6-bit-prefix table for the upper bits of a match distance.
 * Depends only on the window size `N`, not on `F` — reused verbatim from
 * the public-domain reference `lzhuf.c` (see file header).
 */
/** @internal exported only so tests can assert the prefix code stays valid. */
// prettier-ignore
export const D_CODE = Uint8Array.from([
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,0x01,
  0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,0x02,
  0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,
  0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,
  0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,
  0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x09,0x09,0x09,0x09,0x09,0x09,0x09,0x09,
  0x0A,0x0A,0x0A,0x0A,0x0A,0x0A,0x0A,0x0A,0x0B,0x0B,0x0B,0x0B,0x0B,0x0B,0x0B,0x0B,
  0x0C,0x0C,0x0C,0x0C,0x0D,0x0D,0x0D,0x0D,0x0E,0x0E,0x0E,0x0E,0x0F,0x0F,0x0F,0x0F,
  0x10,0x10,0x10,0x10,0x11,0x11,0x11,0x11,0x12,0x12,0x12,0x12,0x13,0x13,0x13,0x13,
  0x14,0x14,0x14,0x14,0x15,0x15,0x15,0x15,0x16,0x16,0x16,0x16,0x17,0x17,0x17,0x17,
  0x18,0x18,0x19,0x19,0x1A,0x1A,0x1B,0x1B,0x1C,0x1C,0x1D,0x1D,0x1E,0x1E,0x1F,0x1F,
  0x20,0x20,0x21,0x21,0x22,0x22,0x23,0x23,0x24,0x24,0x25,0x25,0x26,0x26,0x27,0x27,
  0x28,0x28,0x29,0x29,0x2A,0x2A,0x2B,0x2B,0x2C,0x2C,0x2D,0x2D,0x2E,0x2E,0x2F,0x2F,
  0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x3A,0x3B,0x3C,0x3D,0x3E,0x3F,
]);

/** @internal exported only so tests can assert the prefix code stays valid. */
// prettier-ignore
export const D_LEN = Uint8Array.from([
  0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,
  0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,0x03,
  0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,
  0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,
  0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,0x04,
  0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,
  0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,
  0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,
  // 0x80..0x8F: length 5, NOT 6 -- D_CODE gives symbols 0x0A/0x0B a span of
  // 8 byte-values each, and span == 2**(8 - length). A length of 6 here is
  // not a valid canonical prefix code (Kraft sum comes to 1.03125, not 1)
  // and desynchronises the bitstream on any match distance in [640, 767].
  0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,0x05,
  0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,
  0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,
  0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,0x06,
  0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,
  0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,
  0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,0x07,
  0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,0x08,
]);

class InputExhausted extends Error {}

class LZHUFDecoder {
  private readonly data: Uint8Array;
  private pos = 0;
  private getbuf = 0;
  private getlen = 0;

  private readonly freq = new Uint16Array(T + 1);
  private readonly son = new Uint16Array(T);
  private readonly prnt = new Uint16Array(T + N_CHAR);
  private readonly textBuf = new Uint8Array(N + F - 1);

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** Set once `decompress` is running in decode-until-exhausted mode. */
  private strict = false;

  private readByte(): number {
    if (this.pos < this.data.length) {
      return this.data[this.pos++];
    }
    if (this.strict) throw new InputExhausted();
    return 0;
  }

  private getBit(): number {
    while (this.getlen <= 8) {
      const i = this.readByte();
      this.getbuf |= i << (8 - this.getlen);
      this.getlen += 8;
    }
    const i = this.getbuf;
    this.getbuf = (this.getbuf << 1) & 0xffff;
    this.getlen -= 1;
    return i & 0x8000 ? 1 : 0;
  }

  private getByte(): number {
    while (this.getlen <= 8) {
      const i = this.readByte();
      this.getbuf |= i << (8 - this.getlen);
      this.getlen += 8;
    }
    const i = this.getbuf;
    this.getbuf = (this.getbuf << 8) & 0xffff;
    this.getlen -= 8;
    return (i >> 8) & 0xff;
  }

  /** `StartHuff()` — initialise the adaptive frequency tree. */
  private startHuff(): void {
    const { freq, son, prnt } = this;
    for (let i = 0; i < N_CHAR; i++) {
      freq[i] = 1;
      son[i] = i + T;
      prnt[i + T] = i;
    }
    let i = 0;
    let j = N_CHAR;
    while (j <= R) {
      freq[j] = freq[i] + freq[i + 1];
      son[j] = i;
      prnt[i] = j;
      prnt[i + 1] = j;
      i += 2;
      j += 1;
    }
    freq[T] = 0xffff;
    prnt[R] = 0;
  }

  /** `reconst()` — rebuild the tree once a node's frequency saturates. */
  private reconst(): void {
    const { freq, son, prnt } = this;
    let j = 0;
    for (let i = 0; i < T; i++) {
      if (son[i] >= T) {
        freq[j] = (freq[i] + 1) >> 1;
        son[j] = son[i];
        j += 1;
      }
    }
    let i = 0;
    j = N_CHAR;
    while (j < T) {
      const k0 = i + 1;
      const f = freq[i] + freq[k0];
      freq[j] = f;
      let k = j - 1;
      while (f < freq[k]) k -= 1;
      k += 1;
      for (let idx = j - 1; idx >= k; idx--) freq[idx + 1] = freq[idx];
      freq[k] = f;
      for (let idx = j - 1; idx >= k; idx--) son[idx + 1] = son[idx];
      son[k] = i;
      i += 2;
      j += 1;
    }
    for (let ii = 0; ii < T; ii++) {
      const k = son[ii];
      if (k >= T) {
        prnt[k] = ii;
      } else {
        prnt[k] = ii;
        prnt[k + 1] = ii;
      }
    }
  }

  /** `update(c)` — increment a leaf's frequency and re-balance the tree. */
  private updateAfterDecode(leaf: number): void {
    const { freq, son, prnt } = this;
    if (freq[R] === MAX_FREQ) this.reconst();
    let c = prnt[leaf + T];
    for (;;) {
      freq[c] += 1;
      const k = freq[c];
      let l = c + 1;
      if (k > freq[l]) {
        l += 1;
        while (k > freq[l]) l += 1;
        l -= 1;
        freq[c] = freq[l];
        freq[l] = k;
        const i = son[c];
        prnt[i] = l;
        if (i < T) prnt[i + 1] = l;
        const j = son[l];
        son[l] = i;
        prnt[j] = c;
        if (j < T) prnt[j + 1] = c;
        son[c] = j;
        c = l;
      }
      c = prnt[c];
      if (c === 0) break;
    }
  }

  /** `DecodeChar()` — walk the tree root-to-leaf, one bit per level. */
  private decodeChar(): number {
    let c = this.son[R];
    while (c < T) {
      c += this.getBit();
      c = this.son[c];
    }
    c -= T;
    this.updateAfterDecode(c);
    return c;
  }

  /** `DecodePosition()` — decode a match distance (0..N-1). */
  private decodePosition(): number {
    let i = this.getByte();
    const c = D_CODE[i] << 6;
    let j = D_LEN[i] - 2;
    while (j > 0) {
      i = ((i << 1) & 0xffff) + this.getBit();
      j -= 1;
    }
    return c | (i & 0x3f);
  }

  /**
   * Decode this ONE stream (fresh adaptive model, fresh ring buffer). Pass
   * the known decompressed size when available; pass `undefined` to decode
   * until the compressed input given to this decoder is exhausted.
   */
  decompress(outSize?: number): Uint8Array {
    this.strict = outSize === undefined;
    this.startHuff();
    const bounded = outSize !== undefined;
    const out = bounded ? new Uint8Array(outSize) : ([] as number[]);
    const push = bounded
      ? (i: number, v: number) => {
          (out as Uint8Array)[i] = v;
        }
      : (_i: number, v: number) => {
          (out as number[]).push(v);
        };
    const textBuf = this.textBuf;
    for (let i = 0; i < N - F; i++) textBuf[i] = 0x20;
    let r = N - F;
    let count = 0;
    try {
      while (!bounded || count < (outSize as number)) {
        const c = this.decodeChar();
        if (c < 256) {
          push(count, c);
          textBuf[r] = c;
          r = (r + 1) & (N - 1);
          count += 1;
        } else {
          let i = (r - this.decodePosition() - 1) & (N - 1);
          const j = c - 255 + THRESHOLD;
          for (let k = 0; k < j; k++) {
            if (bounded && count >= (outSize as number)) break;
            const cc = textBuf[i & (N - 1)];
            push(count, cc);
            textBuf[r] = cc;
            r = (r + 1) & (N - 1);
            count += 1;
            i += 1;
          }
        }
      }
    } catch (e) {
      if (!(e instanceof InputExhausted)) throw e;
    }
    return bounded ? (out as Uint8Array) : Uint8Array.from(out as number[]);
  }
}

/**
 * Decompress ONE LZHUF stream. Pass `outSize` when the real decompressed
 * size is known; pass `undefined` to decode until the compressed input is
 * exhausted (useful for archive formats that record only some entries'
 * decompressed sizes).
 */
export function lzhufDecompress(data: Uint8Array, outSize?: number): Uint8Array {
  return new LZHUFDecoder(data).decompress(outSize);
}
