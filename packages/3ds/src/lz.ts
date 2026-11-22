/**
 * Nintendo LZ77-family decompressors used by 3DS Fire Emblem data files.
 *
 * Ported from the DSDecmp reference (as vendored into SciresM/FEAT), which
 * handles the exact stream layouts these games ship:
 *
 * - LZ10  (type byte 0x10) — short-repeat variant: every compressed block is
 *   two bytes, `length = (b1 >> 4) + 3`, `disp = ((b1 & 0xF) << 8 | b2) + 1`.
 * - LZ11  (type byte 0x11) — long-repeat variant with three block encodings
 *   for longer lengths (see LZ11 below).
 * - "LZ13" — FE13/Fates wrapper: `[0x13][u24 size][LZ11 stream]`. The u24 is
 *   the size of the game's in-place decompression buffer, NOT the decompressed
 *   size: it equals the inner LZ11 size in most files but differs in others
 *   (853/4,914 Awakening, 1,480/13,455 Fates). The inner LZ11 header's size is
 *   authoritative and is what this decoder returns. The wrapper is followed by
 *   a standard LZ11 stream (which begins with its own `0x11` type byte).
 * - Stored wrapper — `[0x00][u24 size][raw bytes]` with size = file length - 4
 *   (31 Fates `.lz` files); the payload is returned as-is.
 *
 * Both bare streams are `[type byte][u24 LE decompressed size][blocks...]`.
 */

const BUFFER_LENGTH = 0x1000;

/** Decompress a bare LZ10 or LZ11 stream. `data[0]` selects the variant. */
export function decompressLz(data: Uint8Array): Uint8Array {
  const type = data[0];
  if (type === 0x10) return decompressLz10(data);
  if (type === 0x11) return decompressLz11(data);
  throw new Error(`Unknown LZ compression type 0x${type.toString(16)}`);
}

/** Decompress an LZ11 stream (`[0x11][u24 size][blocks...]`). */
export function decompressLz11(data: Uint8Array): Uint8Array {
  return decompressLz10Or11(data, true);
}

/** Decompress an LZ10 stream (`[0x10][u24 size][blocks...]`). */
export function decompressLz10(data: Uint8Array): Uint8Array {
  return decompressLz10Or11(data, false);
}

function readDecompressedSize(data: Uint8Array, inPos: number): { size: number; inPos: number } {
  let size = data[1] | (data[2] << 8) | (data[3] << 16);
  let pos = inPos;
  if (size === 0) {
    size = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
    pos += 4;
  }
  return { size, inPos: pos };
}

function decompressLz10Or11(data: Uint8Array, long: boolean): Uint8Array {
  return decodeLz10Or11(data, long, false).out;
}

/**
 * Shared LZ10/LZ11 loop. With `strict`, an input over-read (the stream ran off
 * the end of `data`) throws instead of silently reading zeros, and the number
 * of consumed input bytes is returned so callers can check the stream ends
 * where the data does.
 */
function decodeLz10Or11(data: Uint8Array, long: boolean, strict: boolean): { out: Uint8Array; consumed: number } {
  const { size, inPos: start } = readDecompressedSize(data, 4);
  if (strict && size > MAX_BARE_RATIO * data.length) throw new Error('LZ declared size implausible');
  const out = new Uint8Array(size);
  // Ring buffer mirroring DSDecmp's history window.
  const buf = new Uint8Array(BUFFER_LENGTH);
  let bufPos = 0;
  let inPos = start;
  let outPos = 0;
  let mask = 1;
  let flags = 0;

  while (outPos < size) {
    if (strict && inPos >= data.length) throw new Error('LZ input exhausted before declared size');
    if (mask === 1) {
      flags = data[inPos++];
      mask = 0x80;
    } else {
      mask >>= 1;
    }

    if (flags & mask) {
      if (!long) {
        // LZ10: exactly two bytes per block.
        const b1 = data[inPos++];
        const b2 = data[inPos++];
        const length = (b1 >> 4) + 3;
        const disp = (((b1 & 0x0f) << 8) | b2) + 1;
        if (disp > outPos) throw new Error('LZ back-reference before start of output');
        copyRepeat(out, buf, bufPos, outPos, length, disp);
        outPos += length;
        bufPos = (bufPos + length) % BUFFER_LENGTH;
        continue;
      }

      const b1 = data[inPos++];
      let length = b1 >> 4;
      let disp: number;
      if (length === 0) {
        const b2 = data[inPos++];
        const b3 = data[inPos++];
        length = (((b1 & 0x0f) << 4) | (b2 >> 4)) + 0x11;
        disp = (((b2 & 0x0f) << 8) | b3) + 1;
      } else if (length === 1) {
        const b2 = data[inPos++];
        const b3 = data[inPos++];
        const b4 = data[inPos++];
        length = (((b1 & 0x0f) << 12) | (b2 << 4) | (b3 >> 4)) + 0x111;
        disp = (((b3 & 0x0f) << 8) | b4) + 1;
      } else {
        const b2 = data[inPos++];
        length = ((b1 & 0xf0) >> 4) + 1;
        disp = (((b1 & 0x0f) << 8) | b2) + 1;
      }

      if (disp > outPos) throw new Error('LZ back-reference before start of output');
      copyRepeat(out, buf, bufPos, outPos, length, disp);
      outPos += length;
      bufPos = (bufPos + length) % BUFFER_LENGTH;
    } else {
      const byte = data[inPos++];
      out[outPos++] = byte;
      buf[bufPos] = byte;
      bufPos = (bufPos + 1) % BUFFER_LENGTH;
    }
  }
  if (strict && inPos > data.length) throw new Error('LZ input over-read');
  return { out, consumed: inPos };
}

/** Largest decompressed/compressed ratio accepted for a bare (unwrapped) LZ stream. */
const MAX_BARE_RATIO = 64;
/** Trailing bytes tolerated after a bare stream ends (4-byte alignment padding). */
const MAX_BARE_PADDING = 4;

/**
 * Decode `data` as a bare LZ10/LZ11 stream only if it is unambiguously one:
 * it decodes to exactly its declared size without over-reading, consumes the
 * input to within alignment padding, and the declared size is at most 64x the
 * input. Returns `null` otherwise (a raw file whose first byte happens to be
 * 0x10/0x11).
 */
export function tryDecompressBareLz(data: Uint8Array): Uint8Array | null {
  if (data.length < 5 || (data[0] !== 0x10 && data[0] !== 0x11)) return null;
  try {
    const { out, consumed } = decodeLz10Or11(data, data[0] === 0x11, true);
    return data.length - consumed <= MAX_BARE_PADDING ? out : null;
  } catch {
    return null;
  }
}

/**
 * Copy `length` bytes from `disp` positions back, updating the ring buffer so
 * overlapping repetitions decode correctly.
 */
function copyRepeat(
  out: Uint8Array,
  buf: Uint8Array,
  bufPos: number,
  outPos: number,
  length: number,
  disp: number,
): void {
  let idx = bufPos + BUFFER_LENGTH - disp;
  for (let i = 0; i < length; i++) {
    const byte = buf[idx % BUFFER_LENGTH];
    out[outPos + i] = byte;
    buf[bufPos] = byte;
    bufPos = (bufPos + 1) % BUFFER_LENGTH;
    idx++;
  }
}

/**
 * Decompress a 3DS Fire Emblem "LZ13" file: `[0x13][u24 size][LZ10/LZ11
 * stream]`. Also handles a bare LZ10/LZ11 stream with no wrapper, so callers
 * can feed any RomFS file through and get usable bytes back.
 *
 * A stored wrapper (`00` + u24 == length - 4) yields its raw payload. The LZ13
 * outer size is ignored; output length is the inner LZ11 size.
 *
 * Data that is not any of those forms passes through untouched. That includes
 * raw files whose first byte is 0x10/0x11 (a BIN whose pointer table starts
 * 0x10): a bare stream is only accepted when it decodes to exactly its declared
 * size, consumes the input to within padding and declares <= 64x its input
 * (see `tryDecompressBareLz`). A wrapper with an unrecognised inner type throws rather than
 * silently handing back still-compressed bytes for a parser to choke on.
 */
export function decompressLz13(data: Uint8Array): Uint8Array {
  if (data.length < 5) return data;
  // Stored wrapper: 00 + u24 (fileSize - 4) + raw payload.
  if (data[0] === 0x00 && (data[1] | (data[2] << 8) | (data[3] << 16)) === data.length - 4) {
    return data.subarray(4);
  }
  if (data[0] === 0x13) {
    const inner = data[4];
    if (inner !== 0x10 && inner !== 0x11) {
      throw new Error(`LZ13 wrapper with unknown inner stream type 0x${inner!.toString(16)}`);
    }
    return decompressLz(data.subarray(4));
  }
  // A bare stream is accepted only when it verifies end to end; a raw file
  // that merely starts with 0x10/0x11 (e.g. an Awakening `bev/` BIN) passes through.
  return tryDecompressBareLz(data) ?? data;
}
