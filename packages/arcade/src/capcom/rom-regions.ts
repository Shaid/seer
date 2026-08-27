/**
 * Generic helpers for assembling a CPS1/CPS2 MAME "region" (maincpu, gfx,
 * audiocpu, qsound...) out of the individual ROM-chip files a romset ZIP
 * contains, following the exact semantics of MAME's own ROM_LOAD macros
 * (`src/emu/romentry.h`). These loading conventions are shared across the
 * entire CPS1/CPS2 catalog (they describe how each game's physical ROM
 * chips are wired to the bus, not anything game-specific), so this module
 * has no `ddsom`-specific knowledge — the per-game file->region mapping
 * (which files, which offsets, which region size) lives in each game's own
 * `tools/<game>/export-game-data.ts` / `build-assets.ts`.
 *
 * Two loading patterns are implemented, both confirmed against
 * `src/emu/romentry.h` in mamedev/mame (see docs/ddsom/cps2/data-structure.md):
 *
 * - `ROM_LOAD16_WORD_SWAP` (`ROM_GROUPWORD | ROM_REVERSE`, no skip): the
 *   dumped EPROM's bytes are copied in, but each adjacent byte pair is
 *   swapped. Used for 68000 program ROMs and (on ddsom) the QSound sample
 *   ROMs — `swapWordBytes()`.
 * - `ROM_LOAD64_WORD` (`ROM_GROUPWORD | ROM_SKIP(6)`, no reverse): the
 *   source is read 2 bytes (1 word) at a time and those words are written
 *   into every 4th word slot of the destination (i.e. 4 ROMs' words
 *   interleave to build 64-bit-wide groups), with each word's own byte
 *   order left untouched. Used for CPS gfx mask ROMs — `interleaveWords()`.
 */

/** ROM_LOAD16_WORD_SWAP: swap each adjacent byte pair (a per-16-bit-word byteswap), applied to one contiguous ROM's bytes. */
export function swapWordBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i + 1 < src.length; i += 2) {
    out[i] = src[i + 1];
    out[i + 1] = src[i];
  }
  if (src.length % 2 === 1) out[src.length - 1] = src[src.length - 1];
  return out;
}

/** Place a byte-swapped ROM at a given destination offset in a preallocated region buffer (ROM_LOAD16_WORD_SWAP with an explicit load offset, e.g. one of several 68000 program ROMs concatenated into "maincpu"). */
export function loadWordSwapped(dest: Uint8Array, destOffset: number, src: Uint8Array): void {
  dest.set(swapWordBytes(src), destOffset);
}

/**
 * ROM_LOAD64_WORD: copy `src`'s bytes 2 at a time into `dest`, placing each
 * word at `destBase + wordSlot*2 + k*groupBytes` for the k-th word of
 * `src` (`wordSlot` selects which of the `groupBytes/2` interleaved chips
 * this call is loading — e.g. 0,2,4,6 for a 4-way, 8-byte/64-bit group).
 */
export function interleaveWords(
  dest: Uint8Array,
  destBase: number,
  src: Uint8Array,
  wordSlotBytes: number,
  groupBytes: number,
): void {
  const view = new DataView(dest.buffer, dest.byteOffset, dest.byteLength);
  for (let i = 0; i + 1 < src.length; i += 2) {
    const destOffset = destBase + (i / 2) * groupBytes + wordSlotBytes;
    view.setUint8(destOffset, src[i]);
    view.setUint8(destOffset + 1, src[i + 1]);
  }
}

/** Allocate a zero-filled region buffer of the given size (matches MAME's ROM_REGION default fill). */
export function allocRegion(size: number): Uint8Array {
  return new Uint8Array(size);
}
