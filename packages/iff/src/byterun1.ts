/**
 * ByteRun1 — the EA IFF-85 run-length codec used by `ILBM`/`PBM `/`ANIM`
 * `BODY` chunks when their `BMHD.compression` field is 1 (0 = uncompressed).
 * Public spec, not game-specific — see the "Compression" appendix of the
 * original IFF-85 EA/Electronic Arts document.
 *
 * Algorithm, reading one signed control byte `n` at a time:
 *   - `n` in [0, 127]: copy the next `n + 1` bytes literally.
 *   - `n` in [-127, -1]: repeat the next single byte `1 - n` times.
 *   - `n === -128`: no-op (some encoders emit this as padding).
 */

/**
 * Decode a ByteRun1-compressed buffer. Stops once `expectedLength` output
 * bytes have been produced (BODY chunks routinely have a few bytes of
 * trailing padding after the last real run) — pass the row/plane geometry's
 * own byte count, not `input.length`. Never throws on a truncated/malformed
 * input; missing trailing bytes decode as zero, consistent with
 * `@seer-project/gfx`'s "degrade, don't abort" convention for probing
 * unfamiliar data.
 */
export function decodeByteRun1(input: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let outPos = 0;
  let inPos = 0;

  while (outPos < expectedLength && inPos < input.length) {
    const n = (input[inPos++] << 24) >> 24; // sign-extend byte to int8

    if (n >= 0) {
      const count = n + 1;
      for (let i = 0; i < count && outPos < expectedLength; i++) {
        out[outPos++] = inPos < input.length ? input[inPos++] : 0;
      }
    } else if (n !== -128) {
      const count = 1 - n;
      const value = inPos < input.length ? input[inPos++] : 0;
      for (let i = 0; i < count && outPos < expectedLength; i++) {
        out[outPos++] = value;
      }
    }
    // n === -128: no-op, just consumed the control byte.
  }

  return out;
}
