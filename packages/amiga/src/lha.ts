/**
 * LHA / LZH archive reading — the Amiga distribution format.
 *
 * Practically every WHDLoad install ships as a `.lha`, so a corpus of
 * them is opaque without this. Reads header levels 0, 1 and 2, and
 * decodes the `-lh0-`/`-lhd-` (stored) and `-lh4-`/`-lh5-`/`-lh6-`/
 * `-lh7-` (LZSS + static Huffman) methods, which covers the format as
 * it is actually used. `-lh1-` (dynamic Huffman) and the LZarc-era
 * methods are reported as unsupported rather than mis-decoded.
 *
 * Read-only, zero-dependency, and deliberately non-throwing at the
 * archive level: a damaged member yields an error for that member, not
 * for the whole archive, because recon corpora contain damaged files.
 */

const THRESHOLD = 3;
const MAXMATCH = 256;
const NC = 255 + MAXMATCH + 2 - THRESHOLD; // 510
const CBIT = 9;
const NT = 19;
const TBIT = 5;

export interface LhaEntry {
  /** Path inside the archive, with directory separators normalised to '/'. */
  name: string;
  /** Compression method as stored, e.g. 'lh5' or 'lh0'. */
  method: string;
  compressedSize: number;
  originalSize: number;
  /** CRC-16 of the uncompressed data, as recorded in the header. */
  crc16: number;
  /** File offset of this member's compressed payload. */
  dataOffset: number;
  headerLevel: number;
  isDirectory: boolean;
}

function ascii(data: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[off + i]);
  return s;
}

function u16(data: Uint8Array, off: number): number {
  return data[off] | (data[off + 1] << 8);
}

function u32(data: Uint8Array, off: number): number {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
}

/** True if `data` looks like an LHA archive (method signature at the usual offset). */
export function isLhaFile(data: Uint8Array): boolean {
  if (data.length < 22) return false;
  return data[2] === 0x2d && data[6] === 0x2d; // '-xxx-'
}

/**
 * List an archive's members. Stops at the first structurally impossible
 * header rather than throwing, so a truncated archive still yields the
 * members that precede the damage.
 */
export function listLha(data: Uint8Array): LhaEntry[] {
  const entries: LhaEntry[] = [];
  let off = 0;

  while (off + 22 < data.length) {
    const level = data[off + 20];
    let headerSize: number;
    let name = '';
    let dataOffset: number;
    let crc16 = 0;

    if (level === 0 || level === 1) {
      headerSize = data[off];
      if (headerSize === 0) break;
      const nameLen = data[off + 21];
      name = ascii(data, off + 22, nameLen);
      const afterName = off + 22 + nameLen;
      crc16 = u16(data, afterName);
      if (level === 0) {
        // Level 0: the size field counts from offset 2, so the header
        // occupies headerSize + 2 bytes.
        dataOffset = off + headerSize + 2;
      } else {
        // Level 1: the size field counts the WHOLE base header, and
        // extended headers (each a 2-byte size then payload, terminated
        // by a zero size) follow immediately after it.
        let ext = off + headerSize;
        for (;;) {
          if (ext + 2 > data.length) break;
          const extSize = u16(data, ext);
          if (extSize === 0) {
            ext += 2;
            break;
          }
          if (extSize > 2) {
            const type = data[ext + 2];
            // An extended header is [size:2][type:1][payload], with
            // `size` covering all three, so the payload is size - 3.
            if (type === 0x01) name = ascii(data, ext + 3, extSize - 3);
            else if (type === 0x02) name = ascii(data, ext + 3, extSize - 3).replace(/\xff/g, '/') + name;
          }
          ext += extSize;
        }
        dataOffset = ext;
      }
    } else if (level === 2) {
      headerSize = u16(data, off);
      if (headerSize === 0) break;
      crc16 = u16(data, off + 21);
      let ext = off + 24;
      for (;;) {
        if (ext + 2 > data.length) break;
        const extSize = u16(data, ext);
        if (extSize === 0) break;
        // Extended header: 1 byte type, then payload.
        const type = data[ext + 2];
        if (type === 0x01) {
          name = ascii(data, ext + 3, extSize - 3);
        } else if (type === 0x02) {
          name = ascii(data, ext + 3, extSize - 3).replace(/\xff/g, '/') + name;
        }
        ext += extSize;
      }
      dataOffset = off + headerSize;
    } else {
      break;
    }

    const method = ascii(data, off + 2, 5).replace(/-/g, '');
    const skipSize = u32(data, off + 7);
    const originalSize = u32(data, off + 11);
    if (dataOffset > data.length) break;

    // Level 1 stores a "skip size" spanning the extended headers AND the
    // payload, measured from `headerSize + 2` — two bytes past where the
    // extended headers themselves begin. Verified against real archives:
    // both readings are tried and the one landing on a plausible next
    // header wins, since packers of this era are not consistent here.
    const looksLikeHeader = (at: number) =>
      at === data.length || (at + 22 <= data.length && data[at + 2] === 0x2d && data[at + 6] === 0x2d);
    let compressedSize = skipSize;
    if (level === 1) {
      const candidates = [off + headerSize + 2 + skipSize, dataOffset + skipSize, off + headerSize + skipSize];
      const next = candidates.find(looksLikeHeader) ?? candidates[0];
      compressedSize = Math.max(0, next - dataOffset);
    }

    const normalised = name.replace(/\\/g, '/').replace(/\xff/g, '/');
    entries.push({
      name: normalised,
      method,
      compressedSize,
      originalSize,
      crc16,
      dataOffset,
      headerLevel: level,
      isDirectory: method === 'lhd' || normalised.endsWith('/'),
    });

    const next = dataOffset + compressedSize;
    if (next <= off || next > data.length) break;
    off = next;
  }
  return entries;
}

// ── -lh4-/-lh5-/-lh6-/-lh7- decoder (LZSS + static Huffman) ────────────

class BitReader {
  private data: Uint8Array;
  private pos: number;
  private end: number;
  private bitbuf = 0;
  private subbitbuf = 0;
  private bitcount = 0;

  constructor(data: Uint8Array, start: number, end: number) {
    this.data = data;
    this.pos = start;
    this.end = end;
    this.fillbuf(16);
  }

  fillbuf(n: number): void {
    while (n > this.bitcount) {
      n -= this.bitcount;
      this.bitbuf = ((this.bitbuf << this.bitcount) + (this.subbitbuf >>> (8 - this.bitcount))) & 0xffff;
      this.subbitbuf = this.pos < this.end ? this.data[this.pos++] : 0;
      this.bitcount = 8;
    }
    this.bitcount -= n;
    this.bitbuf = ((this.bitbuf << n) + (this.subbitbuf >>> (8 - n))) & 0xffff;
    this.subbitbuf = (this.subbitbuf << n) & 0xff;
  }

  peek(n: number): number {
    return (this.bitbuf >>> (16 - n)) & ((1 << n) - 1);
  }

  /** The whole 16-bit window, for bit-by-bit Huffman tree descent. */
  raw(): number {
    return this.bitbuf;
  }

  getbits(n: number): number {
    if (n === 0) return 0;
    const x = this.bitbuf >>> (16 - n);
    this.fillbuf(n);
    return x;
  }
}

/**
 * Canonical Huffman table builder — a faithful translation of LHA's
 * `make_table`. Codes no longer than `tablebits` get a direct lookup
 * slot; longer ones extend into a binary tree held in `left`/`right`,
 * so the walking "pointer" of the C original moves between three
 * arrays, which is why the slot is tracked as an (array, index) pair.
 */
function makeTable(
  nchar: number,
  bitlen: Uint8Array,
  tablebits: number,
  table: Uint16Array,
  left: Uint16Array,
  right: Uint16Array,
): void {
  const count = new Uint16Array(17);
  const weight = new Uint32Array(17);
  const start = new Uint32Array(18);

  for (let i = 0; i < nchar; i++) count[bitlen[i]]++;
  count[0] = 0;

  start[1] = 0;
  for (let i = 1; i <= 16; i++) start[i + 1] = start[i] + (count[i] << (16 - i));
  if (start[17] !== 0x10000) throw new Error('lha: bad Huffman table');

  const jutbits = 16 - tablebits;
  let i = 1;
  for (; i <= tablebits; i++) {
    start[i] >>>= jutbits;
    weight[i] = 1 << (tablebits - i);
  }
  for (; i <= 16; i++) weight[i] = 1 << (16 - i);

  const tableEnd = start[tablebits + 1] >>> jutbits;
  if (tableEnd !== 1 << tablebits) {
    for (let k = tableEnd; k < 1 << tablebits; k++) table[k] = 0;
  }

  let avail = nchar;
  const mask = 1 << (15 - tablebits);
  for (let ch = 0; ch < nchar; ch++) {
    const len = bitlen[ch];
    if (len === 0) continue;
    const nextcode = start[len] + weight[len];
    if (len <= tablebits) {
      for (let n = start[len]; n < nextcode; n++) table[n] = ch;
    } else {
      let k = start[len];
      let slotArr = table;
      let slotIdx = k >>> jutbits;
      let bits = len - tablebits;
      while (bits !== 0) {
        if (slotArr[slotIdx] === 0) {
          right[avail] = 0;
          left[avail] = 0;
          slotArr[slotIdx] = avail++;
        }
        const node = slotArr[slotIdx];
        if (k & mask) {
          slotArr = right;
          slotIdx = node;
        } else {
          slotArr = left;
          slotIdx = node;
        }
        k = (k << 1) & 0xffff;
        bits--;
      }
      slotArr[slotIdx] = ch;
    }
    start[len] = nextcode;
  }
}

interface HuffState {
  cLen: Uint8Array;
  ptLen: Uint8Array;
  cTable: Uint16Array;
  ptTable: Uint16Array;
  left: Uint16Array;
  right: Uint16Array;
  blocksize: number;
  np: number;
  pbit: number;
}

function readPtLen(br: BitReader, st: HuffState, nn: number, nbit: number, iSpecial: number): void {
  const n = br.getbits(nbit);
  if (n === 0) {
    const c = br.getbits(nbit);
    st.ptLen.fill(0, 0, nn);
    st.ptTable.fill(c, 0, 256);
    return;
  }
  let i = 0;
  while (i < n && i < nn) {
    // A length is 3 bits, except that the all-ones value 7 is extended
    // by a unary run of 1 bits immediately after it.
    let c = br.peek(3);
    if (c === 7) {
      let mask = 1 << 12;
      while (mask & br.raw()) {
        mask >>>= 1;
        c++;
      }
    }
    br.fillbuf(c < 7 ? 3 : c - 3);
    st.ptLen[i++] = c;
    if (i === iSpecial) {
      let z = br.getbits(2);
      while (--z >= 0 && i < nn) st.ptLen[i++] = 0;
    }
  }
  while (i < nn) st.ptLen[i++] = 0;
  makeTable(nn, st.ptLen, 8, st.ptTable, st.left, st.right);
}

/** Decode one member compressed with a static-Huffman LZSS method. */
export function decodeLzh(
  data: Uint8Array,
  start: number,
  compressedSize: number,
  originalSize: number,
  method: string,
): Uint8Array {
  const dicbit = method === 'lh4' ? 12 : method === 'lh5' ? 13 : method === 'lh6' ? 15 : 16;
  const pbit = method === 'lh6' || method === 'lh7' ? 5 : 4;
  const np = dicbit + 1;

  const st: HuffState = {
    cLen: new Uint8Array(NC),
    ptLen: new Uint8Array(NT > np ? NT : np),
    cTable: new Uint16Array(4096),
    ptTable: new Uint16Array(256),
    left: new Uint16Array(2 * NC),
    right: new Uint16Array(2 * NC),
    blocksize: 0,
    np,
    pbit,
  };

  const br = new BitReader(data, start, start + compressedSize);
  const out = new Uint8Array(originalSize);
  let outIndex = 0;

  /**
   * Table lookup for short codes; for long ones the table bits are
   * consumed FIRST and the remainder walked bit by bit through the
   * left/right tree, then the code's residual length consumed. Getting
   * that order wrong desynchronises the whole stream.
   */
  const decodeSymbol = (table: Uint16Array, lens: Uint8Array, tablebits: number, limit: number): number => {
    let j = table[br.peek(tablebits)];
    if (j < limit) {
      br.fillbuf(lens[j]);
      return j;
    }
    br.fillbuf(tablebits);
    let mask = 1 << 15;
    do {
      j = br.raw() & mask ? st.right[j] : st.left[j];
      mask >>>= 1;
    } while (j >= limit);
    br.fillbuf(lens[j] - tablebits);
    return j;
  };

  const readCLen = (): void => {
    const n = br.getbits(CBIT);
    if (n === 0) {
      const c = br.getbits(CBIT);
      st.cLen.fill(0);
      st.cTable.fill(c);
      return;
    }
    let i = 0;
    while (i < n && i < NC) {
      let c = decodeSymbol(st.ptTable, st.ptLen, 8, NT);
      if (c <= 2) {
        if (c === 0) c = 1;
        else if (c === 1) c = br.getbits(4) + 3;
        else c = br.getbits(CBIT) + 20;
        while (--c >= 0 && i < NC) st.cLen[i++] = 0;
      } else {
        st.cLen[i++] = c - 2;
      }
    }
    while (i < NC) st.cLen[i++] = 0;
    makeTable(NC, st.cLen, 12, st.cTable, st.left, st.right);
  };

  while (outIndex < originalSize) {
    if (st.blocksize === 0) {
      st.blocksize = br.getbits(16);
      if (st.blocksize === 0) break;
      readPtLen(br, st, NT, TBIT, 3);
      readCLen();
      readPtLen(br, st, np, pbit, -1);
    }
    st.blocksize--;

    const c = decodeSymbol(st.cTable, st.cLen, 12, NC);
    if (c <= 255) {
      out[outIndex++] = c;
    } else {
      const length = c - 256 + THRESHOLD;
      let p = decodeSymbol(st.ptTable, st.ptLen, 8, np);
      if (p !== 0) p = (1 << (p - 1)) + br.getbits(p - 1);
      let src = outIndex - p - 1;
      if (src < 0) break;
      for (let k = 0; k < length && outIndex < originalSize; k++) out[outIndex++] = out[src++];
    }
  }
  return out;
}

/** Read one member's bytes, decompressing as needed. */
export function readLhaEntry(data: Uint8Array, entry: LhaEntry): Uint8Array {
  if (entry.method === 'lh0' || entry.method === 'lhd') {
    return data.subarray(entry.dataOffset, entry.dataOffset + entry.originalSize);
  }
  if (['lh4', 'lh5', 'lh6', 'lh7'].includes(entry.method)) {
    return decodeLzh(data, entry.dataOffset, entry.compressedSize, entry.originalSize, entry.method);
  }
  throw new Error(`lha: unsupported method -${entry.method}-`);
}
