/** Deterministic PRNG (LCG) so tests never depend on Math.random. */
export function makeRng(seed = 0x1234): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function randomBytes(length: number, seed = 0x1234): Uint8Array {
  const rng = makeRng(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

/**
 * Row-interleaved planar encoder, written independently of
 * @seer-project/gfx's offset formula (which has its own round-trip tests)
 * so probe's sweep tests aren't circular.
 */
export function encodeRowInterleaved(
  img: Uint8Array,
  width: number,
  height: number,
  planes: number,
): Uint8Array {
  const rowBytes = width >> 3;
  const buf = new Uint8Array(height * rowBytes * planes);
  for (let y = 0; y < height; y++) {
    for (let p = 0; p < planes; p++) {
      for (let x = 0; x < width; x++) {
        if ((img[y * width + x] >> p) & 1) {
          buf[y * rowBytes * planes + p * rowBytes + (x >> 3)] |= 1 << (7 - (x & 7));
        }
      }
    }
  }
  return buf;
}

/**
 * A structured test image: overlapping filled rectangles using the full
 * 3-plane palette (real art picks its plane count to fit its palette, and
 * the sweep's indexUsage metric relies on that).
 */
export function structuredImage(width: number, height: number): Uint8Array {
  const img = new Uint8Array(width * height);
  const rects: [number, number, number, number, number][] = [
    [4, 2, 24, 27, 3],
    [30, 5, 30, 15, 5],
    [10, 22, 40, 8, 1],
    [50, 2, 12, 18, 6],
    [2, 12, 20, 10, 7],
    [40, 24, 20, 6, 2],
    [26, 1, 10, 8, 4],
  ];
  for (const [x0, y0, w, h, v] of rects) {
    for (let y = y0; y < Math.min(height, y0 + h); y++) {
      for (let x = x0; x < Math.min(width, x0 + w); x++) img[y * width + x] = v;
    }
  }
  return img;
}
