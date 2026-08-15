/**
 * `seer-probe stride <file>` — record-size and scanline-pitch finder.
 *
 * Codifies the autocorrelation-period-is-the-scanline-stride technique
 * plus the string-start-gap histogram triage tip. Three signals, combined:
 * byte self-similarity (normalized mean |b[i]−b[i+s]|, minima are
 * candidate periods), equality rate, and the ASCII-run-start gap
 * histogram. Harmonics are folded (2s/3s report as s), but ALL strong
 * fundamentals are reported rather than only the top one — a record type
 * whose tail previews the next record produces two honest fundamentals,
 * and picking one silently is the documented failure mode.
 */

import { readBinary, writeJson, writePNG } from '@seer-project/pipeline';
import { parseFlags } from './args.js';
import { meanAbsDiffAtLag, equalityRateAtLag } from './score.js';
import { artifactPath, ensureOutDir } from './out.js';
import { resolveRanges } from './range.js';
import { createCanvas, fillRect, setPixel, type Canvas } from './render.js';

export interface StrideCandidate {
  stride: number;
  /** Combined 0..1 score; components reported separately so the ranking can be argued with. */
  score: number;
  signals: {
    selfSimilarity: number;
    equalityRate: number;
    stringGapSupport: boolean;
  };
  /** Byte columns (offsets within the record) holding one constant value across sampled records. */
  constantColumns: number[];
}

export interface StrideResult {
  file: string;
  size: number;
  range: { start: number; end: number };
  candidates: StrideCandidate[];
  /** Dominant gaps between consecutive ASCII-run starts, largest count first. */
  stringGaps: { gap: number; count: number }[];
}

/** Cap on bytes examined per lag so large files stay interactive. */
const MAX_ANALYSIS_BYTES = 1 << 18;

export interface StrideOptions {
  start?: number;
  end?: number;
  maxStride?: number;
  top?: number;
}

/** Pure analysis half. */
export function analyzeStride(data: Uint8Array, file: string, opts: StrideOptions = {}): StrideResult {
  const start = opts.start ?? 0;
  const fullEnd = opts.end ?? data.length;
  const end = Math.min(fullEnd, start + MAX_ANALYSIS_BYTES);
  const n = end - start;
  const maxStride = Math.min(opts.maxStride ?? 2048, n >> 2);
  const top = opts.top ?? 8;

  const gaps = stringGapHistogram(data, start, fullEnd);
  const gapSet = new Set(gaps.slice(0, 8).map((g) => g.gap));

  // Per-lag dip/peak scores against the local median baseline.
  const diffs = new Float64Array(maxStride + 1);
  const eqs = new Float64Array(maxStride + 1);
  for (let s = 1; s <= maxStride; s++) {
    diffs[s] = meanAbsDiffAtLag(data, s, start, end);
    eqs[s] = equalityRateAtLag(data, s, start, end);
  }
  const diffBase = median(diffs.subarray(1));
  const eqBase = median(eqs.subarray(1));

  const scored: StrideCandidate[] = [];
  for (let s = 2; s <= maxStride; s++) {
    const selfSim = diffBase > 0 ? (diffBase - diffs[s]) / diffBase : 0;
    const eqBoost = eqBase < 1 ? (eqs[s] - eqBase) / (1 - eqBase) : 0;
    const gapSupport = gapSet.has(s);
    let score = 0.6 * clamp01(selfSim) + 0.4 * clamp01(eqBoost);
    if (gapSupport) score = Math.min(1, score + 0.15);
    if (score <= 0.05) continue;
    // Local-minimum requirement on the diff curve so a broad valley doesn't
    // nominate every lag inside it.
    if (s > 2 && s < maxStride && !(diffs[s] <= diffs[s - 1] && diffs[s] <= diffs[s + 1])) continue;
    scored.push({
      stride: s,
      score: round3(score),
      signals: {
        selfSimilarity: round3(clamp01(selfSim)),
        equalityRate: round3(clamp01(eqBoost)),
        stringGapSupport: gapSupport,
      },
      constantColumns: [],
    });
  }
  scored.sort((a, b) => b.score - a.score);

  // Harmonic folding, both directions: drop s when a comparably-strong
  // DIVISOR exists anywhere in the scored set (a chance-favoured 21×s can
  // outrank the fundamental, so folding only against already-kept
  // candidates isn't enough), and when a kept fundamental divides it —
  // report 37, not 74, 111 or 777.
  const scoreOf = new Map(scored.map((c) => [c.stride, c.score]));
  const kept: StrideCandidate[] = [];
  for (const c of scored) {
    let isHarmonic = kept.some((k) => c.stride % k.stride === 0 && k.score >= c.score * 0.8);
    if (!isHarmonic) {
      for (let d = 2; d * d <= c.stride && !isHarmonic; d++) {
        if (c.stride % d !== 0) continue;
        for (const div of [d, c.stride / d]) {
          const s = scoreOf.get(div);
          if (div !== c.stride && s !== undefined && s >= c.score * 0.8) isHarmonic = true;
        }
      }
    }
    if (isHarmonic) continue;
    kept.push(c);
    if (kept.length >= top) break;
  }

  for (const c of kept) {
    c.constantColumns = constantColumns(data, start, end, c.stride);
  }

  return {
    file,
    size: data.length,
    range: { start, end: fullEnd },
    candidates: kept,
    stringGaps: gaps.slice(0, 8),
  };
}

/** Histogram of gaps between consecutive ASCII-run starts (runs ≥ 4 printable chars). */
export function stringGapHistogram(
  data: Uint8Array,
  start = 0,
  end = data.length,
): { gap: number; count: number }[] {
  const starts: number[] = [];
  let runStart = -1;
  let runLen = 0;
  for (let i = start; i < end; i++) {
    const b = data[i];
    if (b >= 0x20 && b <= 0x7e) {
      if (runLen === 0) runStart = i;
      runLen++;
    } else {
      if (runLen >= 4) starts.push(runStart);
      runLen = 0;
    }
  }
  if (runLen >= 4) starts.push(runStart);

  const counts = new Map<number, number>();
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([gap, count]) => ({ gap, count }))
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.count - a.count);
}

/** Columns whose byte value is identical across ≥ 98% of sampled records. */
function constantColumns(data: Uint8Array, start: number, end: number, stride: number): number[] {
  const rows = Math.min(Math.floor((end - start) / stride), 4096);
  if (rows < 4) return [];
  const cols: number[] = [];
  for (let col = 0; col < stride; col++) {
    const counts = new Map<number, number>();
    for (let r = 0; r < rows; r++) {
      const b = data[start + r * stride + col];
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    const best = Math.max(...counts.values());
    if (best / rows >= 0.98) cols.push(col);
  }
  return cols;
}

// ── Rendering ──────────────────────────────────────────────────────────

const MAX_GRID_ROWS = 2048;

/**
 * Record-grid PNG: the range rendered as a `stride`-wide greyscale byte
 * image with constant columns marked in the top strip, so the record's
 * field layout is readable at a glance.
 */
export function renderRecordGrid(
  data: Uint8Array,
  start: number,
  end: number,
  stride: number,
  constant: number[],
): Canvas {
  const rows = Math.min(Math.floor((end - start) / stride), MAX_GRID_ROWS);
  const markerH = 4;
  const c = createCanvas(stride, rows + markerH, [24, 24, 24]);
  for (const col of constant) fillRect(c, col, 0, 1, markerH, [230, 64, 64]);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < stride; x++) {
      const v = data[start + y * stride + x];
      setPixel(c, x, y + markerH, [v, v, v]);
    }
  }
  return c;
}

// ── CLI ────────────────────────────────────────────────────────────────

export const STRIDE_USAGE = `seer-probe stride <file> [--range start:end] [--regions <probe-map.json>] [--max 2048] [--top 8] [--out <dir>]
  Find candidate record sizes / scanline pitches. Writes a record-grid PNG
  for the best candidate per range, plus JSON with all strong fundamentals.`;

export function runStride(argv: string[]): number {
  const { positional, flags } = parseFlags(argv, {
    range: 'string',
    regions: 'string',
    max: 'number',
    top: 'number',
    out: 'string',
  });
  const file = positional[0];
  if (!file) {
    console.error(STRIDE_USAGE);
    return 1;
  }
  const data = readBinary(file);
  const ranges = resolveRanges(
    { range: flags.range as string | undefined, regions: flags.regions as string | undefined },
    data.length,
    'stride',
  );
  const outDir = ensureOutDir(flags.out as string | undefined);

  const results: StrideResult[] = [];
  for (const r of ranges) {
    const result = analyzeStride(data, file, {
      start: r.start,
      end: r.end,
      maxStride: flags.max as number | undefined,
      top: flags.top as number | undefined,
    });
    results.push(result);
    const best = result.candidates[0];
    // Suffix every partial range, not just multi-region runs — two --range
    // invocations on the same file must not overwrite each other's artifacts.
    const suffix = r.start === 0 && r.end === data.length ? '' : `-0x${r.start.toString(16)}`;
    if (best) {
      const grid = renderRecordGrid(data, r.start, r.end, best.stride, best.constantColumns);
      const gridPath = artifactPath(outDir, 'stride', file, `${suffix}.png`);
      writePNG(gridPath, grid.rgba, grid.width, grid.height);
      console.log(
        `0x${r.start.toString(16)}-0x${r.end.toString(16)}: stride ${best.stride} (score ${best.score}), ` +
          `${result.candidates.length} fundamentals, wrote ${gridPath}`,
      );
    } else {
      console.log(`0x${r.start.toString(16)}-0x${r.end.toString(16)}: no periodic structure found`);
    }
  }

  const only = ranges.length === 1 ? ranges[0] : null;
  const jsonSuffix = only && !(only.start === 0 && only.end === data.length) ? `-0x${only.start.toString(16)}` : '';
  const jsonPath = artifactPath(outDir, 'stride', file, `${jsonSuffix}.json`);
  writeJson(jsonPath, results.length === 1 ? results[0] : results);
  console.log(`wrote ${jsonPath}`);
  return 0;
}

function median(arr: Float64Array): number {
  const sorted = Float64Array.from(arr).sort();
  return sorted[sorted.length >> 1];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
