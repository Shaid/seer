/**
 * SNK Neo Geo palette decoders.
 *
 * Neo Geo palette RAM is 2048 × 16-bit words at `$400000`. Each word is a
 * 15-bit RGB color: bits 0-4 R, 5-9 G, 10-14 B (`0RRRRRGGGGGBBBBB`).
 *
 * Unlike CPS1 (whose palette copy sites are a fixed brightness-forcing
 * idiom, see capcom/palette.ts), Neo Geo game programs typically *load*
 * palette words from 16-bit tables in the P ROM into palette RAM through
 * per-game helpers (e.g. Samurai Shodown IV's `$979e` routine, which has a
 * direct-word mode when the stream test word is `0xffff`). The tables
 * themselves are plain statically-addressable 16-bit color words; finding
 * them in a P ROM binary is a game-specific hunt (see
 * docs/neogeo/palette.md). This module ships the decode + a scan helper
 * that locates runs of plausible 16-bit color words.
 */

export const NEOGEO_PALETTE_SIZE = 2048; // 16-bit words
export const NEOGEO_PALETTE_BASE = 0x400000;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Decode one 16-bit Neo Geo palette word into 8-bit-per-channel RGB (bits 0-4 R, 5-9 G, 10-14 B). */
export function decodeNeoGeoPaletteWord(word: number): Rgb {
  return {
    r: (word & 0x1f) << 3,
    g: ((word >> 5) & 0x1f) << 3,
    b: ((word >> 10) & 0x1f) << 3,
  };
}

/** Decode `count` consecutive big-endian 16-bit words starting at `byteOffset` into RGB. */
export function decodeNeoGeoPaletteWords(
  data: Uint8Array,
  byteOffset: number,
  count: number,
): Rgb[] {
  const out = new Array<Rgb>(count);
  for (let i = 0; i < count; i++) {
    const off = byteOffset + i * 2;
    const word = (data[off] << 8) | data[off + 1];
    out[i] = decodeNeoGeoPaletteWord(word);
  }
  return out;
}

/**
 * Scan a big-endian byte region (the assembled P ROM) for 16-color palette
 * banks: runs of 16+ words where each word has bit 15 clear (the 15-bit
 * colors) at 32-byte alignment, and the bank "looks like" a sprite palette
 * (some near-black outline entries plus a spread of distinct hues/salience).
 *
 * Real Neo Geo palette tables come in dense runs (a character-select block
 * holds many back-to-back 16-color banks within a few KB), whereas
 * instruction/data noise produces only scattered matches. This scanner keeps
 * only banks that sit in such a cluster (>= `minCluster` banks within
 * `clusterWindow` bytes) — which collapses typical false positives from
 * thousands to a handful of real regions.
 *
 * Returns every matching bank's byte offset, ordered.
 */
export function scanNeoGeoPaletteBanks(
  data: Uint8Array,
  from = 0,
  to = data.length,
  opts: { minCluster?: number; clusterWindow?: number } = {},
): number[] {
  const { minCluster = 8, clusterWindow = 0x2000 } = opts;
  const hits: number[] = [];
  const w16 = (o: number) => (data[o] << 8) | data[o + 1];

  const isColor = (w: number) => (w & 0x8000) === 0 && w !== 0xffff;

  // Pass 1: collect every 32-byte-aligned bank that passes a weak plausibility
  // filter (>=12 plain color words, >=4 distinct, >=1 dark + >=2 bright).
  const candidates: number[] = [];
  const alignedStart = from + ((32 - (from % 32)) % 32);
  for (let base = alignedStart; base + 32 <= to; base += 32) {
    const words: number[] = [];
    let colors = 0;
    for (let i = 0; i < 16; i++) {
      const w = w16(base + i * 2);
      words.push(w);
      if (isColor(w)) colors++;
    }
    if (colors < 12) continue;
    const uniq = new Set(words.filter((w) => isColor(w)));
    if (uniq.size < 4) continue;
    let dark = 0;
    let bright = 0;
    for (const w of words) {
      const lum = (w & 0x1f) + ((w >> 5) & 0x1f) + ((w >> 10) & 0x1f);
      if (lum <= 3) dark++;
      else if (lum >= 24) bright++;
    }
    if (dark < 1 || bright < 2) continue;
    candidates.push(base);
  }

  // Pass 2: keep only candidates inside a dense cluster. Efficient O(n)
  // sliding window: count candidates within `clusterWindow` behind/ahead of
  // each candidate using two pointers over the sorted candidate list.
  const kept = new Uint8Array(candidates.length);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < candidates.length; i++) {
    while (candidates[lo]! + clusterWindow < candidates[i]!) lo++;
    while (hi < candidates.length && candidates[hi]! - candidates[i]! <= clusterWindow) hi++;
    kept[i] = hi - lo >= minCluster ? 1 : 0;
  }
  for (let i = 0; i < candidates.length; i++) if (kept[i]) hits.push(candidates[i]!);

  // Dedupe: consecutive candidates within 64 bytes count as one bank.
  const out: number[] = [];
  for (const a of hits) {
    if (out.length === 0 || a - out[out.length - 1]! > 64) out.push(a);
  }
  return out;
}
