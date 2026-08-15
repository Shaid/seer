/**
 * Scoring statistics shared across probe commands.
 *
 * Every statistic here is either standard (Shannon entropy) or was
 * validated on real corpus data before being promoted into a tool:
 * normalized roughness is the byte-order discriminator measured across the
 * Spirit of Excalibur CDTV tracks (correct order scored 700–4,300 of
 * 16-bit full scale vs ~21,800 byte-swapped), and lag-1 autocorrelation is
 * the "is this audio?" gate the Legend XFSD decode documented (0.514–0.979
 * on real resources). Both are normalized to full scale here so their
 * thresholds are bit-depth-independent.
 *
 * Nothing in this module asserts a decode — these are hypothesis-ranking
 * inputs, reported alongside every verdict so rankings can be argued with.
 */

/** Shannon entropy of a byte window, in bits per byte (0..8). */
export function shannonEntropy(data: Uint8Array, start = 0, end = data.length): number {
  const counts = new Uint32Array(256);
  const n = end - start;
  if (n <= 0) return 0;
  for (let i = start; i < end; i++) counts[data[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i] === 0) continue;
    const p = counts[i] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Shortest period 1..maxPeriod at which the window repeats near-exactly
 * (`b[i] === b[i+p]` for ≥ `threshold` of positions), or null. Low entropy
 * alone must not be called "fill" — a repeating 4-byte pattern has low
 * entropy but is patterned fill, not zero fill, and skipping this test is
 * the patterned-fill-defeats-naive-entropy-scan failure mode.
 */
export function repeatingPeriod(
  data: Uint8Array,
  start = 0,
  end = data.length,
  maxPeriod = 64,
  threshold = 0.99,
): number | null {
  const n = end - start;
  const maxP = Math.min(maxPeriod, n >> 1);
  // Rejecting a candidate period on a short prefix first turns the common
  // case (low-entropy data that is not actually periodic) from `maxPeriod`
  // full-window passes into `maxPeriod` short ones. The prefix gate is
  // deliberately looser than `threshold`, so a window whose few permitted
  // mismatches happen to cluster at the start still reaches full confirmation.
  const probeEnd = Math.min(end, start + 256);
  const probeGate = threshold - 0.04;

  for (let p = 1; p <= maxP; p++) {
    if (probeEnd - p > start) {
      let probeEq = 0;
      let probeTotal = 0;
      for (let i = start; i < probeEnd - p; i++) {
        if (data[i] === data[i + p]) probeEq++;
        probeTotal++;
      }
      if (probeTotal > 0 && probeEq / probeTotal < probeGate) continue;
    }
    let eq = 0;
    const total = n - p;
    for (let i = start; i < end - p; i++) {
      if (data[i] === data[i + p]) eq++;
    }
    if (total > 0 && eq / total >= threshold) return p;
  }
  return null;
}

/**
 * Normalized mean absolute difference at lag `s` — low minima mark
 * candidate record strides / scanline pitches. 0 = identical, 1 = maximal.
 */
export function meanAbsDiffAtLag(data: Uint8Array, lag: number, start = 0, end = data.length): number {
  const n = end - start - lag;
  if (n <= 0) return 1;
  let sum = 0;
  for (let i = start; i < end - lag; i++) sum += Math.abs(data[i] - data[i + lag]);
  return sum / n / 255;
}

/**
 * Fraction of positions where `b[i] === b[i+lag]`.
 *
 * Deliberately exact, not sampled. Subsampling this was tried as an
 * optimization and rejected: it bought under 3% of classifier throughput
 * while changing up to 3% of verdicts, and — because the scanline lags
 * being tested are mostly multiples of 4 — an even-numbered sampling
 * step *aliases* with the very periodicity being measured, making the
 * error non-monotonic in the step size.
 */
export function equalityRateAtLag(data: Uint8Array, lag: number, start = 0, end = data.length): number {
  const n = end - start - lag;
  if (n <= 0) return 0;
  let eq = 0;
  for (let i = start; i < end - lag; i++) {
    if (data[i] === data[i + lag]) eq++;
  }
  return eq / n;
}

/**
 * Mean absolute sample-to-sample difference of decoded PCM, as a fraction
 * of full scale (samples normalized to [-1, 1] → result in [0, 2], in
 * practice ≪ 1 for real audio and ≈ 0.3–0.7 for wrong-byte-order noise).
 */
export function normalizedRoughness(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1]);
  return sum / (samples.length - 1) / 2;
}

/** Lag-1 autocorrelation of decoded PCM. Real audio ≈ 0.5–0.98; noise ≈ 0. */
export function lag1Autocorrelation(samples: Float32Array): number {
  const n = samples.length;
  if (n < 3) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = samples[i] - mean;
    den += d * d;
    if (i > 0) num += d * (samples[i - 1] - mean);
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Mean horizontal run length of a row-major index image, normalized to
 * (0, 1] by width. Art has runs; noise decodes to runs of ~1 px.
 */
export function meanRunLength(indices: Uint8Array, width: number, height: number): number {
  let runs = 0;
  let total = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let runStart = 0;
    for (let x = 1; x <= width; x++) {
      if (x === width || indices[row + x] !== indices[row + x - 1]) {
        runs++;
        total += x - runStart;
        runStart = x;
      }
    }
  }
  return runs === 0 ? 0 : total / runs / width;
}

/**
 * Mean absolute difference between vertically adjacent rows of an index
 * image, normalized by the index range. Real bitmaps are far more
 * vertically coherent than a wrong-stride decode.
 */
export function rowIncoherence(indices: Uint8Array, width: number, height: number, levels: number): number {
  if (height < 2) return 1;
  let sum = 0;
  let n = 0;
  for (let y = 1; y < height; y++) {
    const a = (y - 1) * width;
    const b = y * width;
    for (let x = 0; x < width; x++) {
      sum += Math.abs(indices[b + x] - indices[a + x]);
      n++;
    }
  }
  return sum / n / Math.max(1, levels - 1);
}

/**
 * Best alignment shift between adjacent rows, searched over ±maxShift px.
 * A correct width centres on 0; a wrong width produces a consistent
 * non-zero shift (the diagonal-smear signature), and the mean measured
 * shift × height estimates how far off the width is.
 */
export function dominantRowShear(
  indices: Uint8Array,
  width: number,
  height: number,
  maxShift = 8,
): number {
  if (height < 3) return 0;
  const shifts: number[] = [];
  for (let y = 1; y < height; y++) {
    const a = (y - 1) * width;
    const b = y * width;
    let bestShift = 0;
    let bestScore = Infinity;
    for (let s = -maxShift; s <= maxShift; s++) {
      let sum = 0;
      let n = 0;
      for (let x = Math.max(0, -s); x < Math.min(width, width - s); x++) {
        sum += Math.abs(indices[b + x + s] - indices[a + x]);
        n++;
      }
      const score = n === 0 ? Infinity : sum / n;
      if (score < bestScore) {
        bestScore = score;
        bestShift = s;
      }
    }
    shifts.push(bestShift);
  }
  // Median, so one noisy row can't fake a shear.
  shifts.sort((x, y) => x - y);
  return shifts[shifts.length >> 1];
}

/**
 * Fraction of the 2^planes index space actually used. Real art picks a
 * plane count to fit its palette, so a correct decode uses a substantial
 * fraction of its indices — while decoding N-plane data as 2N planes
 * produces a sparse, mostly-empty index space. Rewarding usage (rather
 * than sparseness) is what stops higher plane counts from always winning.
 */
export function indexUsage(indices: Uint8Array, levels: number): number {
  const used = new Set<number>();
  for (const v of indices) used.add(v);
  return used.size / Math.max(1, levels);
}
