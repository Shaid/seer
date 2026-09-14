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
 * - "LZ13" — FE13/Fates wrapper: `[0x13][u24 size][LZ11 stream]`. The first
 *   four bytes are `0x13` + the little-endian decompressed size, followed by
 *   a standard LZ11 stream (which begins with its own `0x11` type byte).
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
  const { size, inPos: start } = readDecompressedSize(data, 4);
  const out = new Uint8Array(size);
  // Ring buffer mirroring DSDecmp's history window.
  const buf = new Uint8Array(BUFFER_LENGTH);
  let bufPos = 0;
  let inPos = start;
  let outPos = 0;
  let mask = 1;
  let flags = 0;

  while (outPos < size) {
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
  return out;
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
 * Data that is not any of those forms (an already-uncompressed CTPK, BCH or
 * CGFX, whose magics never start with 0x10/0x11/0x13) passes through
 * untouched. A wrapper with an unrecognised inner type throws rather than
 * silently handing back still-compressed bytes for a parser to choke on.
 */
export function decompressLz13(data: Uint8Array): Uint8Array {
  if (data.length < 5) return data;
  if (data[0] === 0x13) {
    const inner = data[4];
    if (inner !== 0x10 && inner !== 0x11) {
      throw new Error(`LZ13 wrapper with unknown inner stream type 0x${inner!.toString(16)}`);
    }
    return decompressLz(data.subarray(4));
  }
  if (data[0] === 0x10 || data[0] === 0x11) return decompressLz(data);
  return data;
}
