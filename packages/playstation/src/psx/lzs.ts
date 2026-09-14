/**
 * PSX "LZS"/"ALZ1" decompressor -- a classic LZSS variant used throughout
 * several PSX titles' data files (psx-spx: "CDROM File Compression LZ5 and
 * LZ5-variants").
 *
 * LZSS parameters:
 *   - Ring buffer: 4096 bytes, initialized to 0x00
 *   - Initial buffer position: 0xFEE (4078)
 *   - Max match length: 18 (4-bit length field + 3)
 *   - Flag byte: LSB-first; 1 = literal, 0 = reference
 *   - Reference: 2 bytes -> 12-bit offset + 4-bit (length - 3)
 *
 * References can overlap the output cursor (self-referencing repeat runs) and
 * can reference data before the start of output (resolves to 0x00 bytes).
 *
 * Every on-disk file opens with a u32 LE header, but two titles' files
 * disagree on what it means, confirmed from each one's own real data:
 *
 *  - **Exact compressed length** (`decompressLzsFile`): the header is the
 *    precise byte count of the compressed payload that follows, and there
 *    may be further, unrelated bytes in the same buffer afterward (e.g. a
 *    fixed-size resource slot's padding) that are NOT part of the stream.
 *  - **Approximate compressed length** (`decompressLzsBuffer`): the header is
 *    only approximately the compressed length (psx-spx documents up to 7
 *    bytes of jitter) -- every byte from offset 4 to the end of the buffer is
 *    compressed payload, and the header itself is not used to bound decoding.
 *
 * Sources: wiki.ffrtt.ru FF7/LZSS format; cebix/ff7tools ff7/lzss.py
 * (reference implementation); q-gears Gears doc §1.1.2; psx-spx "CDROM File
 * Compression".
 */

const WSIZE = 4096;
const WSIZE_MASK = WSIZE - 1;
const MIN_REF_LEN = 3;
const INITIAL_POS = 0xfee;

/** Decompress a raw LZSS payload (no header). */
export function decompressLzss(payload: Uint8Array): Uint8Array {
  const srcLen = payload.length;
  const out: number[] = [];
  let srcPos = 0;
  let j = 0; // output position

  while (srcPos < srcLen) {
    const flags = payload[srcPos++]!;
    if (srcPos >= srcLen) break;

    for (let bit = 0; bit < 8; bit++) {
      if (srcPos >= srcLen) break;

      if (flags & (1 << bit)) {
        // Literal byte
        out.push(payload[srcPos++]!);
        j++;
      } else {
        // Reference: 2 bytes
        if (srcPos + 1 >= srcLen) break;
        const b1 = payload[srcPos]!;
        const b2 = payload[srcPos + 1]!;
        srcPos += 2;

        const offset = b1 | ((b2 & 0xf0) << 4);
        const length = (b2 & 0x0f) + MIN_REF_LEN;

        let ref = j - ((j + INITIAL_POS - offset) & WSIZE_MASK);
        for (let k = 0; k < length; k++) {
          out.push(ref < 0 ? 0 : (out[ref] ?? 0));
          j++;
          ref++;
        }
      }
    }
  }

  return new Uint8Array(out);
}

/**
 * Decompress an LZS file whose u32 LE header is the exact compressed-payload
 * length (bytes after the 4-byte header) -- there may be trailing bytes in
 * `data` past that boundary, which are not part of the compressed stream.
 */
export function decompressLzsFile(data: Uint8Array): Uint8Array {
  if (data.length < 4) {
    throw new Error(`LZS file too short: ${data.length} bytes`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const compressedSize = dv.getUint32(0, true);
  if (4 + compressedSize > data.length) {
    throw new Error(
      `LZS header declares ${compressedSize} compressed bytes but file has ${data.length - 4}`,
    );
  }
  return decompressLzss(data.subarray(4, 4 + compressedSize));
}

/**
 * Decompress an LZS buffer whose u32 LE header is only an approximate
 * compressed-payload length (up to 7 bytes of jitter) -- every byte from
 * offset 4 to the end of `data` is treated as compressed payload.
 */
export function decompressLzsBuffer(data: Uint8Array): Uint8Array {
  if (data.length < 4) {
    throw new Error(`LZS buffer too short: ${data.length} bytes`);
  }
  return decompressLzss(data.subarray(4));
}

/**
 * Check if data looks like LZS-compressed (has a plausible size header). The
 * header value should be approximately `data.length - 4`, per psx-spx's
 * documented 0..7 jitter.
 */
export function isLzsCompressed(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const hdr = (data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24)) >>> 0;
  const actualCompressed = data.length - 4;
  return hdr >= actualCompressed && hdr <= actualCompressed + 7;
}
