/**
 * Shared binary utilities for working with Uint8Array and DataView.
 *
 * These are low-level, byte-oriented primitives with no assumptions about
 * any particular container or resource format — safe to use for any binary
 * reverse-engineering target, on any platform/endianness.
 *
 * Format-specific helpers (e.g. detecting a container's endianness from its
 * magic header) belong alongside that container's own decoder, not here.
 *
 * **These readers do not bounds-check.** Reading past the end of `data` yields
 * `undefined` (from `r8`) or a value computed from `undefined` operands, not an
 * error — deliberate, because probing an unknown format means reading
 * speculatively at offsets that may not pan out, and a throw per miss would be
 * useless. Validate the offset yourself, or use `BinaryReader`, which takes the
 * opposite position and throws `RangeError` on overrun. Pick per use: these for
 * probing, `BinaryReader` for walking a format you have already confirmed.
 */

export type Endianness = 'be' | 'le';

/** Sign-extend a 16-bit value held in a JS number. */
export function toI16(x: number): number {
  x &= 0xffff;
  return x & 0x8000 ? x - 0x10000 : x;
}

/** Sign-extend a 32-bit value held in a JS number. */
export function toI32(x: number): number {
  x >>>= 0;
  return x & 0x80000000 ? x - 0x100000000 : x;
}

/** Create a DataView over a Uint8Array, handling byteOffset/byteLength correctly. */
export function dataViewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Read a uint8 at offset. */
export function r8(data: Uint8Array, offset: number): number {
  return data[offset];
}

/** Read a uint16 at offset in the given endianness. */
export function r16(data: Uint8Array, offset: number, endian: Endianness): number {
  if (endian === 'le') return data[offset] | (data[offset + 1] << 8);
  return (data[offset] << 8) | data[offset + 1];
}

/** Read a uint24 at offset in the given endianness. */
export function r24(data: Uint8Array, offset: number, endian: Endianness): number {
  if (endian === 'le') {
    return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
  }
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

/** Read a uint32 at offset in the given endianness. */
export function r32(data: Uint8Array, offset: number, endian: Endianness): number {
  if (endian === 'le') {
    return (
      (data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24)) >>>
      0
    );
  }
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

// ---------------------------------------------------------------------------
// Text at a fixed offset
//
// Every byte-level format has magics, FourCCs and fixed-width name fields, and
// before these existed each package wrote its own `ascii()` — six named copies
// and ~18 inline `String.fromCharCode(...)` expressions across ten packages,
// silently disagreeing on what to do with a non-ASCII byte (pass it through /
// `.` / space / mask the top bit). These are the two policies worth sharing,
// named so a call site says which one it wants.
//
// Note these are byte->char, not a text decoding: byte `n` becomes code point
// `n` (Latin-1), never UTF-8. That is what you want for a magic or an ASCII
// identifier field and is NOT what you want for human-readable text in an
// unknown encoding — use `TextDecoder` for that.
// ---------------------------------------------------------------------------

/**
 * Read `len` bytes at `off` as characters, one byte per code point, with no
 * filtering at all. A byte past the end of `data` reads as `\0`.
 */
export function asciiAt(data: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[off + i] ?? 0);
  return s;
}

/** The four-character tag at `off` — `asciiAt(data, off, 4)`, named for the thing it reads. */
export function fourCCAt(data: Uint8Array, off = 0): string {
  return asciiAt(data, off, 4);
}

/**
 * Read `len` bytes at `off`, substituting `placeholder` for anything outside
 * printable ASCII (`0x20`-`0x7e`) — the hex-dump / filename-sanitizing
 * policy, as opposed to `asciiAt`'s pass-everything-through.
 */
export function printableAsciiAt(data: Uint8Array, off: number, len: number, placeholder = '.'): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = data[off + i];
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : placeholder;
  }
  return s;
}

/**
 * Read a NUL-terminated string at `off`, stopping at the first zero byte, the
 * end of `data`, or `maxLen` bytes — whichever comes first. One byte per code
 * point, like `asciiAt`.
 */
export function cStringAt(data: Uint8Array, off: number, maxLen = 256): string {
  let s = '';
  const end = Math.min(off + maxLen, data.length);
  for (let i = off; i < end; i++) {
    const b = data[i]!;
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/**
 * Lowercase hex of `len` bytes at `off`, two digits per byte, no separator —
 * the `Buffer…toString('hex')` spelling without `Buffer`, so it works in a
 * browser too.
 *
 * This one **truncates** past the end of `data` rather than padding, the
 * opposite of `asciiAt`. Padding is right for a fixed-width text field, where
 * a short read is still that field; it is wrong here, because `00` is a real
 * byte value and emitting it for a byte that is not there turns a truncated
 * buffer into a plausible-looking digest.
 */
export function hexAt(data: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = data[off + i];
    if (b === undefined) break;
    s += b.toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * Whether the bytes at `off` spell `magic`. Compares code unit by code unit,
 * so it never allocates a string and never depends on a text encoding; a
 * `magic` with a code unit above 255 can therefore never match.
 */
export function matchesMagic(data: Uint8Array, off: number, magic: string): boolean {
  if (off + magic.length > data.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (data[off + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Clamp `v` into `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Round `v` up to the next multiple of `align`.
 *
 * **Never write `(v + (n - 1)) & ~(n - 1)` for this.** JS's bitwise operators
 * coerce both operands to 32-bit *signed* integers, so that idiom silently
 * corrupts for any `v` at or beyond `2**31` (~2.147 GB) — well inside the
 * range of a modern disc or cartridge image. Found the hard way in a
 * consuming project whose archive is 6.9 GB: `(6936719456 + 31) & ~31`
 * evaluates to `-1653215136`, which then encoded as a huge unsigned file
 * position and failed on the next read.
 *
 * `%` is exact for every JS safe integer, so this agrees with the bitwise
 * form for every power-of-two `align` below `2**31` and keeps working above
 * it. Unlike that form it also handles a non-power-of-two `align`.
 */
export function alignUp(v: number, align: number): number {
  const r = v % align;
  return r === 0 ? v : v + (align - r);
}

/** Clamp `v` into `[0, 1]` — written verbatim in six places before this existed. */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
