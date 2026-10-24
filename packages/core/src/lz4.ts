/**
 * LZ4 **block** format decompression — the bare sequence stream, with no
 * frame header, no block size prefix and no checksums.
 *
 * This is the shape embedded inside other containers rather than the shape
 * of a `.lz4` file: a Nintendo Switch `NSO0` executable's three segments
 * (`@seer-project/switch`), Unity's compressed bundle blocks, and most
 * middleware that stores "LZ4" payloads at a known decompressed size all
 * use it. A real `.lz4` *frame* (magic `0x184d2204`) wraps one or more of
 * these blocks plus sizes and optional xxHash checksums, and is not
 * implemented here.
 *
 * It lives in `@seer-project/core` rather than next to
 * `@seer-project/pipeline`'s other decompressors (`decompressLZEXE`,
 * `ancientDecompress`, the RNC/PP20 pair) for one structural reason: that
 * barrel reaches `node:fs` through `config.js`/`io.js`, so anything
 * importing it stops being browser-safe. LZ4 is a pure byte transform with
 * no I/O and platform packages need it, so it belongs on the zero-dependency
 * side of the line.
 *
 * Deliberately hand-written rather than pulled from a dependency: the format
 * is ~30 lines and seer's offline pipelines avoid native/optional deps.
 */

/**
 * Expand one LZ4 block into at most `outSize` bytes.
 *
 * `outSize` is the *declared* decompressed size; the returned buffer is
 * trimmed to what the stream actually produced, so a caller can assert
 * `result.length === outSize` as a correctness check (a truncated or
 * misaligned stream then fails loudly instead of silently yielding a
 * zero-padded buffer).
 *
 * Throws rather than truncating on a literal run that overruns either
 * buffer, or a match offset of zero or one pointing before the start of the
 * output produced so far — all three mean the stream is not the block it
 * was declared to be, and a partial result would be indistinguishable from
 * a correct one.
 */
export function decompressLz4Block(src: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize);
  let i = 0;
  let o = 0;
  const n = src.length;
  while (i < n) {
    const token = src[i++];
    let litLen = token >> 4;
    if (litLen === 15) {
      for (;;) {
        const c = src[i++];
        litLen += c;
        if (c !== 255) break;
      }
    }
    if (o + litLen > outSize || i + litLen > n) throw new Error('lz4: literal run overruns buffer');
    out.set(src.subarray(i, i + litLen), o);
    i += litLen;
    o += litLen;
    // The last sequence in an LZ4 block is literals-only: no match follows.
    if (i >= n) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error(`lz4: bad match offset ${offset} at out ${o}`);
    let matchLen = token & 15;
    if (matchLen === 15) {
      for (;;) {
        const c = src[i++];
        matchLen += c;
        if (c !== 255) break;
      }
    }
    matchLen += 4; // minimum match length
    if (o + matchLen > outSize) throw new Error('lz4: match run overruns buffer');
    // Overlapping copies are legal and common (run-length encoding), so
    // this must be a byte-at-a-time copy, not a bulk `set` of a subarray.
    let s = o - offset;
    for (let k = 0; k < matchLen; k++) out[o++] = out[s++];
  }
  return o === outSize ? out : out.subarray(0, o);
}
