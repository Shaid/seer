/**
 * A monotonic integer identifying *which* version of this package's texture
 * decoders produced a given pile of decoded bytes.
 *
 * ## Why a number lives in a codec package
 *
 * A decompilation project's extraction pipeline caches aggressively — a
 * per-stage resume log so an interrupted run skips what it finished, plus a
 * manifest whose existing rows mean "already produced, don't redo". Neither
 * records *what the decoder did at the time*, so when a decoder bug is fixed
 * the cached outputs are silently wrong and a re-run is a no-op: the only way
 * back to correct pixels is for a human to notice and clear both caches by
 * hand. That happened twice to the consuming project after the two 2026-10-25
 * fixes below — tens of thousands of PNGs and ~2,500 GLBs sat stale for a day
 * and a half each time.
 *
 * {@link BC_DECODER_REVISION} is the fix: a consumer stamps its caches with
 * it, and a mismatch between the stamp on disk and the stamp in the binary is
 * exactly the signal "these bytes came out of a different decoder". The
 * number has no meaning beyond inequality — it is a cache key, not a semver.
 *
 * ## Scope
 *
 * It covers the **pure-TypeScript decode paths whose output bytes this
 * package owns**: every `decodeBC*` in `bc.ts` and the Tegra X1 block-linear
 * `deswizzle`/`getImageData` in `swizzle.ts`. A change to any of them that
 * moves a single output byte must bump it.
 *
 * It deliberately does **not** cover `astc.ts`/`zstd.ts`: their output is
 * decided by the pinned `@tootallnate/*-wasm` dependencies, which
 * `package-lock.json` already versions, and which this file could only track
 * by duplicating that pin. Nor does it cover the *encoders*
 * (`encodeBC1`/`encodeBC3`) — nothing caches encoder output the way an
 * extraction pipeline caches decodes.
 *
 * ## Changelog — bump this, in this list, on any decode-output change
 *
 * - **1** — the package's initial decoders (2026-09-14, `7e722cc`),
 *   including the full spec-conformant BC7 decoder that replaced the
 *   consuming project's own broken one. Not a historical stamp anyone wrote:
 *   the numbering starts here so the two later fixes have distinct values.
 * - **2** — `311602c` (2026-10-25): BC3/BC4/BC5 read all 48 bits of the
 *   3-bit index field. `bits |= data[b+2+i] << (i*8)` wrapped at i=4/i=5
 *   (JS masks the shift count to 5 bits), OR'ing the top two index bytes
 *   back over the bottom two — up to 7 of 16 texels wrong per block.
 * - **3** — `9c0b918` (2026-10-25): BC2/BC3 colour blocks are always
 *   4-colour. The punch-through flag BC1 derives from `c0 <= c1` was being
 *   passed through to BC2/BC3, where the endpoint ordering carries no
 *   meaning — roughly half of all BC2/BC3 blocks decoded palette entries 2
 *   and 3 as the ½-average and black instead of the 2/3 and 1/3 points.
 *
 * {@link BC_DECODER_DIGEST} is the enforcement half: `revision.test.ts`
 * decodes a fixed synthetic corpus through every path in scope and compares
 * its SHA-256 against that constant, so a decode-output change cannot land
 * without someone editing this file — at which point the changelog above is
 * staring them in the face.
 */

/** See this module's doc comment. Bump on any change to decoded bytes. */
export const BC_DECODER_REVISION = 3;

/**
 * SHA-256 of the fixed synthetic decode corpus built by `revision.test.ts`,
 * pinned here rather than in the test so that changing it means touching the
 * same file as {@link BC_DECODER_REVISION}.
 *
 * Not a correctness oracle — `bc.test.ts` holds the spec-conformance cases.
 * This is a tripwire: it fails on *any* movement in decoded bytes, including
 * a refactor that was meant to be behaviour-preserving and wasn't.
 */
export const BC_DECODER_DIGEST =
  '322782bc632408ebfc2b9e1d44b63e952b34ba551fd3f5004cafd9fe9c3e8d4b';
