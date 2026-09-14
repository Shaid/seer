/**
 * Minimal little-endian readers over Uint8Array, shared by the format
 * decoders in this package. Deliberately tiny and dependency-free so the
 * same modules run in Node (offline pipeline) and the browser (viewer).
 */

export interface ByteReader {
  /** Absolute byte position. */
  pos: number;
  /** The underlying buffer. */
  data: Uint8Array;
  u8(): number;
  u16(): number;
  u32(): number;
  i32(): number;
  u64(): number;
  bytes(n: number): Uint8Array;
  skip(n: number): void;
}

export function reader(data: Uint8Array, pos = 0): ByteReader {
  const r: ByteReader = {
    pos,
    data,
    u8() {
      return data[r.pos++];
    },
    u16() {
      const v = data[r.pos] | (data[r.pos + 1] << 8);
      r.pos += 2;
      return v;
    },
    u32() {
      const v =
        data[r.pos] | (data[r.pos + 1] << 8) | (data[r.pos + 2] << 16) | (data[r.pos + 3] << 24);
      r.pos += 4;
      return v >>> 0;
    },
    i32() {
      return r.u32() | 0;
    },
    u64() {
      const lo = r.u32();
      const hi = r.u32();
      return hi * 0x1_0000_0000 + lo;
    },
    bytes(n: number) {
      const b = data.subarray(r.pos, r.pos + n);
      r.pos += n;
      return b;
    },
    skip(n: number) {
      r.pos += n;
    },
  };
  return r;
}

/** Read a u32 at an absolute offset without moving the reader. */
export function u32At(data: Uint8Array, off: number): number {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
}

export function u16At(data: Uint8Array, off: number): number {
  return data[off] | (data[off + 1] << 8);
}

export function u64At(data: Uint8Array, off: number): number {
  const lo = u32At(data, off);
  const hi = u32At(data, off + 4);
  return hi * 0x1_0000_0000 + lo;
}
