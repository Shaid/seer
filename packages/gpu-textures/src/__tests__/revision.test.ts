/**
 * The tripwire half of `revision.ts`: a fixed synthetic corpus run through
 * every decode path {@link BC_DECODER_REVISION} claims to cover, hashed, and
 * compared against the digest pinned *next to the revision constant*.
 *
 * The point is not correctness — `bc.test.ts` and `swizzle.test.ts` hold the
 * spec-conformance cases, and a digest can only ever say "the same as last
 * time". The point is that a change to decoded bytes cannot land without
 * someone opening `revision.ts`, where the instruction to bump the revision
 * and append to the changelog is the first thing they read. A consumer's
 * extraction cache keys off that number; if it doesn't move, every cached
 * texture in every downstream project silently keeps the old pixels.
 *
 * So when this fails: do **not** just paste the new digest in. Work out
 * whether decoded output really changed (it did, or this wouldn't fail),
 * bump `BC_DECODER_REVISION`, add a changelog line, *then* update the digest.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  decodeBC1, decodeBC2, decodeBC3, decodeBC4, decodeBC5, decodeBC6H, decodeBC7,
} from '../bc.js';
import { deswizzle, computeBlockHeightLog2, swizzledSurfaceSize } from '../swizzle.js';
import { BC_DECODER_DIGEST, BC_DECODER_REVISION } from '../revision.js';

/**
 * A fixed, dependency-free byte source. A real texture corpus would be
 * better input but worse as a pin: it would have to be committed, and its
 * own provenance would then need a stamp. An LCG is reproducible forever in
 * three lines.
 */
function pseudoRandomBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

/** 16x16 texels = 4x4 blocks: enough to exercise every block in a row and the row stride between them. */
const W = 16;
const H = 16;
const BLOCKS = (W / 4) * (H / 4);

type BlockDecoder = (data: Uint8Array, width: number, height: number, out: Uint8Array, outOff?: number) => void;

/** `[label, decoder, bytes-per-4x4-block, seed]` — one entry per decode path in scope. */
const CASES: [string, BlockDecoder, number, number][] = [
  ['bc1', decodeBC1, 8, 0x1001],
  ['bc2', decodeBC2, 16, 0x2002],
  ['bc3', decodeBC3, 16, 0x3003],
  ['bc4', decodeBC4, 8, 0x4004],
  ['bc5', decodeBC5, 16, 0x5005],
  ['bc6h', decodeBC6H, 16, 0x6006],
  ['bc7', decodeBC7, 16, 0x7007],
];

/**
 * Hashes the decoded RGBA of every case plus one deswizzle, in a fixed
 * order, with each case's label folded in so a reordering or a dropped case
 * also moves the digest.
 */
function corpusDigest(): string {
  const hash = createHash('sha256');
  for (const [label, decode, blockBytes, seed] of CASES) {
    const src = pseudoRandomBytes(BLOCKS * blockBytes, seed);
    const out = new Uint8Array(W * H * 4);
    decode(src, W, H, out);
    hash.update(label);
    hash.update(out);
  }

  // The Tegra X1 block-linear path: output bytes this package owns just as
  // much as the BC palettes, and a source of exactly the same silent-staleness
  // bug (the consuming project has already shipped one GOB-padding fix).
  const blockHeightLog2 = computeBlockHeightLog2(H / 4);
  const swizzled = pseudoRandomBytes(swizzledSurfaceSize(W, H, 4, 4, 8, blockHeightLog2), 0x8008);
  hash.update('deswizzle');
  hash.update(deswizzle(W, H, 1, 4, 4, 1, 8, 0, blockHeightLog2, swizzled));

  return hash.digest('hex');
}

describe('BC_DECODER_REVISION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(BC_DECODER_REVISION)).toBe(true);
    expect(BC_DECODER_REVISION).toBeGreaterThan(0);
  });

  it('pins the decoded bytes of the whole in-scope corpus', () => {
    expect(corpusDigest()).toBe(BC_DECODER_DIGEST);
  });
});
