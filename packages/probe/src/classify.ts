/**
 * Windowed byte-region classifier shared by `probe map` (segmentation) and
 * `probe cnf` (data-island carving).
 *
 * Guardrails, each tied to a documented failure mode:
 * - A short repeating period is tested BEFORE low entropy is called "fill"
 *   (patterned fill defeats a naive entropy scan).
 * - Every class assignment is gated on entropy, never byte shape alone.
 * - `m68k-code?`, `pcm-audio?` and `planar-graphics?` are weak hints, kept
 *   suffixed `?` in the class name itself so no downstream consumer can
 *   read them as findings.
 * - High entropy is reported as `compressed-or-encrypted` with a note that
 *   a trivial cipher also lands here — high entropy does not imply real
 *   compression.
 */

import {
  repeatingPeriod,
  equalityRateAtLag,
} from './score.js';

export type RegionClass =
  | 'zero-fill'
  | 'patterned-fill'
  | 'ascii-text'
  | 'packed-records'
  | 'planar-graphics?'
  | 'pcm-audio?'
  | 'compressed-or-encrypted'
  | 'm68k-code?'
  | 'mixed';

export interface WindowInfo {
  start: number;
  end: number;
  entropy: number;
  /** Byte-class fractions; `high` covers 0x7F–0xFE (0x00, 0xFF, printable and control bytes are counted separately). */
  fractions: { zero: number; ff: number; ascii: number; ctrl: number; high: number };
  class: RegionClass;
  /** 0..1 — how decisively this window matched its class. */
  strength: number;
}

export interface Region {
  start: number;
  end: number;
  len: number;
  class: RegionClass;
  entropy: number;
  confidence: number;
  note: string;
}

const NOTES: Record<RegionClass, string> = {
  'zero-fill': 'near-uniform 0x00',
  'patterned-fill': 'short repeating byte pattern (not zero fill)',
  'ascii-text': 'printable ASCII dominant',
  'packed-records': 'mid-entropy structured bytes; try probe stride',
  'planar-graphics?': 'weak hint only: scanline-lag self-similarity; try probe gfx',
  'pcm-audio?': 'weak hint only: smooth sample deltas; try probe audio',
  'compressed-or-encrypted': 'compressed or encrypted or trivially ciphered — high entropy alone cannot distinguish',
  'm68k-code?': 'weak hint only: even-aligned words decode to common 68k opcodes',
  mixed: 'no single class dominates',
};

/**
 * Fraction of even-aligned big-endian words that decode to plausible 68000
 * opcodes. Deliberately rough — it feeds a `?`-suffixed hint, nothing more.
 */
export function m68kOpcodeFraction(data: Uint8Array, start = 0, end = data.length): number {
  let plausible = 0;
  let total = 0;
  for (let i = start & ~1; i + 1 < end; i += 2) {
    const w = (data[i] << 8) | data[i + 1];
    total++;
    const hi = w >> 12;
    if (
      w === 0x4e75 || // RTS
      w === 0x4e71 || // NOP
      w === 0x4e73 || // RTE
      (w & 0xfff8) === 0x4e50 || // LINK
      (w & 0xfff8) === 0x4e58 || // UNLK
      (w & 0xffc0) === 0x4e80 || // JSR
      (w & 0xffc0) === 0x4ec0 || // JMP
      w === 0x48e7 || // MOVEM.L push
      w === 0x4cdf || // MOVEM.L pop
      hi === 0x1 || // MOVE.B
      hi === 0x2 || // MOVE.L
      hi === 0x3 || // MOVE.W
      hi === 0x6 || // Bcc
      hi === 0x5 || // ADDQ/SUBQ/Scc/DBcc
      (w & 0xf1c0) === 0x41c0 || // LEA
      (w & 0xff00) === 0x4a00 || // TST.B
      (w & 0xff80) === 0x4a40 // TST.W/L
    ) {
      plausible++;
    }
  }
  return total === 0 ? 0 : plausible / total;
}

/**
 * Byte histogram, entropy and class fractions in ONE pass.
 *
 * Entropy and fractions are both pure functions of the histogram, and
 * this runs on every window of every file in a corpus — computing the
 * histogram twice was pure waste.
 */
function windowStats(
  data: Uint8Array,
  start: number,
  end: number,
): { entropy: number; fractions: WindowInfo['fractions'] } {
  const counts = new Uint32Array(256);
  const n = end - start;
  if (n <= 0) {
    return { entropy: 0, fractions: { zero: 0, ff: 0, ascii: 0, ctrl: 0, high: 0 } };
  }
  for (let i = start; i < end; i++) counts[data[i]]++;

  let entropy = 0;
  let ascii = 0;
  let ctrl = 0;
  let high = 0;
  for (let b = 0; b < 256; b++) {
    const c = counts[b];
    if (c === 0) continue;
    const p = c / n;
    entropy -= p * Math.log2(p);
    if (b === 0x00 || b === 0xff) continue;
    if (b >= 0x20 && b <= 0x7e) ascii += c;
    else if (b <= 0x1f) ctrl += c;
    else high += c;
  }
  return {
    entropy,
    fractions: {
      zero: counts[0x00] / n,
      ff: counts[0xff] / n,
      ascii: ascii / n,
      ctrl: ctrl / n,
      high: high / n,
    },
  };
}

/** Classify one window. Exposed for tests; `classifyRegions` is the real API. */
export function classifyWindow(data: Uint8Array, start: number, end: number): WindowInfo {
  const { entropy, fractions } = windowStats(data, start, end);

  let cls: RegionClass;
  let strength: number;

  // Each test below is ordered cheapest-first and every expensive one is
  // computed lazily — a zero-fill window must not pay for a period scan
  // it can never need.
  const isZeroFill = fractions.zero >= 0.95;
  const period = !isZeroFill && entropy < 3 ? repeatingPeriod(data, start, end) : null;
  const opcodeFraction =
    !isZeroFill && period === null && entropy >= 3 && entropy < highEntropyThreshold(end - start)
      ? m68kOpcodeFraction(data, start, end)
      : 0;

  if (isZeroFill) {
    cls = 'zero-fill';
    strength = fractions.zero;
  } else if (period !== null) {
    cls = 'patterned-fill';
    strength = 1 - entropy / 3;
  } else if (fractions.ascii + fractions.ctrl >= 0.9 && fractions.ascii >= 0.6 && entropy < 5.5) {
    cls = 'ascii-text';
    strength = fractions.ascii;
  } else if (entropy >= highEntropyThreshold(end - start)) {
    cls = 'compressed-or-encrypted';
    strength = (entropy - highEntropyThreshold(end - start)) / (8 - highEntropyThreshold(end - start));
  } else if (entropy >= 3 && opcodeFraction >= 0.55) {
    cls = 'm68k-code?';
    strength = opcodeFraction;
  } else if (entropy >= 3 && entropy < 7 && smoothAsSigned8(data, start, end)) {
    cls = 'pcm-audio?';
    strength = 0.5;
  } else if (entropy >= 1 && entropy < 6.5 && scanlineLagHint(data, start, end)) {
    cls = 'planar-graphics?';
    strength = 0.5;
  } else if (entropy >= 3) {
    cls = 'packed-records';
    strength = 0.5;
  } else {
    cls = 'mixed';
    strength = 0.3;
  }

  return { start, end, entropy, fractions, class: cls, strength: clamp01(strength) };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Entropy gate for "compressed-or-encrypted", adjusted for window size: a
 * window of n samples over a 256-symbol alphabet can't reach 8 bits/byte —
 * 256 uniform-random bytes measure ≈ 7.2 — so a fixed 7.5 gate would
 * misclassify genuinely random small windows as packed records.
 */
function highEntropyThreshold(n: number): number {
  if (n >= 4096) return 7.5;
  if (n >= 1024) return 7.3;
  if (n >= 512) return 7.0;
  return 6.7;
}

/**
 * Weak audio hint: interpreting the window as signed 8-bit PCM gives
 * smooth deltas. Computes the same full-scale-normalised roughness
 * `normalizedRoughness` does, but reads the bytes directly instead of
 * materialising a Float32Array per window — this runs on most windows of
 * every file in a corpus, and the allocation churn was the point.
 */
function smoothAsSigned8(data: Uint8Array, start: number, end: number): boolean {
  const n = Math.min(end - start, 2048);
  if (n < 2) return false;
  let sum = 0;
  let prev = (data[start] << 24) >> 24;
  for (let i = 1; i < n; i++) {
    const v = (data[start + i] << 24) >> 24;
    sum += Math.abs(v - prev);
    prev = v;
  }
  // Samples normalise as v/128 and roughness halves the [-1,1] span.
  const rough = sum / (n - 1) / 256;
  return rough > 0.001 && rough < 0.06;
}

/** Weak graphics hint: strong self-similarity at a plausible scanline lag. */
function scanlineLagHint(data: Uint8Array, start: number, end: number): boolean {
  for (const lag of [20, 24, 32, 40, 44, 80, 160, 176]) {
    if (end - start < lag * 4) continue;
    if (equalityRateAtLag(data, lag, start, end) >= 0.55) return true;
  }
  return false;
}

/** Classify every window of `data` (exposed for map's ribbons). */
export function classifyWindows(data: Uint8Array, window = 256): WindowInfo[] {
  const out: WindowInfo[] = [];
  for (let start = 0; start < data.length; start += window) {
    out.push(classifyWindow(data, start, Math.min(start + window, data.length)));
  }
  return out;
}

/**
 * Segment `data` into class-labelled regions: classify per window, absorb
 * single-window islands surrounded by one class, then merge runs.
 */
export function classifyRegions(data: Uint8Array, window = 256): Region[] {
  const wins = classifyWindows(data, window);
  if (wins.length === 0) return [];

  // Majority smoothing: a lone window between two agreeing neighbours joins them.
  for (let i = 1; i < wins.length - 1; i++) {
    if (
      wins[i - 1].class === wins[i + 1].class &&
      wins[i].class !== wins[i - 1].class
    ) {
      wins[i] = { ...wins[i], class: wins[i - 1].class, strength: wins[i - 1].strength * 0.5 };
    }
  }

  const regions: Region[] = [];
  let runStart = 0;
  for (let i = 1; i <= wins.length; i++) {
    if (i === wins.length || wins[i].class !== wins[runStart].class) {
      const run = wins.slice(runStart, i);
      const start = run[0].start;
      const end = run[run.length - 1].end;
      const cls = run[0].class;
      regions.push({
        start,
        end,
        len: end - start,
        class: cls,
        entropy: round3(run.reduce((s, w) => s + w.entropy, 0) / run.length),
        confidence: round3(run.reduce((s, w) => s + w.strength, 0) / run.length),
        note: NOTES[cls],
      });
      runStart = i;
    }
  }
  return regions;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
