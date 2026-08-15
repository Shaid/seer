/**
 * `seer-probe gfx <file>` — the planar contact sheet.
 *
 * Sweeps the Amiga OCS/AGA planar parameter space over a byte range and
 * ranks every candidate by four separately-reported metrics, replacing the
 * write-script → guess → render → look → edit loop with one invocation.
 * The `width % 16 == 0` word-alignment constraint is what makes an
 * exhaustive sweep cheap.
 *
 * Output is greyscale and opaque by default — colour is only applied once
 * a palette is independently confirmed (`--palette`), and transparency is
 * never implied by a probe render. Every ranking is a hypothesis: the JSON
 * carries the score components precisely so the ranking can be argued
 * with, not trusted.
 */

import {
  decodePlanar,
  greyscaleRamp,
  indicesToRGBA,
  planarByteLength,
  type PlanarConfig,
  type PlanarLayout,
} from '@seer-project/gfx';
import { readBinary, writeJson, writePNG } from '@seer-project/pipeline';
import { parseFlags, parseNumber } from './args.js';
import { artifactPath, ensureOutDir } from './out.js';
import { resolveRanges, type ByteRange } from './range.js';
import {
  dominantRowShear,
  indexUsage,
  meanRunLength,
  rowIncoherence,
} from './score.js';
import { blitRGBA, createCanvas, drawText, fillRect, type Canvas } from './render.js';

export interface GfxCandidate {
  planes: number;
  width: number;
  height: number;
  layout: PlanarLayout;
  /** Absolute byte offset of the decode (range start + jitter). */
  offset: number;
  jitter: number;
  planeStride: number | null;
  maskPlane: boolean;
  score: number;
  components: {
    rowCoherence: number;
    runStructure: number;
    shear: number;
    indexUsage: number;
  };
  /** When the measured shear is non-zero, the width it suggests instead. */
  shearHint: number | null;
}

export interface GfxRangeResult {
  range: { start: number; end: number; label: string };
  best: GfxCandidate | null;
  candidates: GfxCandidate[];
}

export interface GfxResult {
  file: string;
  size: number;
  ranges: GfxRangeResult[];
}

export const SWEEP_WIDTHS = [16, 32, 48, 64, 80, 96, 128, 160, 176, 192, 256, 288, 320, 352, 640];
const LAYOUTS: PlanarLayout[] = ['row-interleaved', 'plane-major', 'word-interleaved'];

/** Rows used for scoring — enough for the metrics to converge, cheap enough to sweep thousands of candidates. */
const SCORE_ROWS = 64;
const SHEAR_MAX = 20;
/** Candidates need at least this many rows to be scoreable at all. */
const MIN_ROWS = 4;

export interface GfxSweepOptions {
  aga?: boolean;
  mask?: boolean;
  /** Jitter range: try offsets +0 … +(jitter−1). Default 16. */
  jitter?: number;
  planeStride?: number | null;
  widths?: number[];
  top?: number;
}

/** Sweep one byte range. Pure — no I/O. */
export function sweepGfx(data: Uint8Array, range: ByteRange, opts: GfxSweepOptions = {}): GfxRangeResult {
  const maxPlanes = opts.aga ? 8 : 6;
  const jitterMax = Math.max(1, opts.jitter ?? 16);
  const top = opts.top ?? 24;
  const widths = opts.widths ?? SWEEP_WIDTHS;
  const candidates: GfxCandidate[] = [];

  for (let planes = 1; planes <= maxPlanes; planes++) {
    for (const maskPlane of opts.mask ? [false, true] : [false]) {
      const decodePlanes = planes + (maskPlane ? 1 : 0);
      if (decodePlanes > 8) continue;
      for (const layout of LAYOUTS) {
        if (opts.planeStride != null && layout !== 'plane-major') continue;
        for (const width of widths) {
          for (let jitter = 0; jitter < jitterMax; jitter++) {
            const c = scoreCandidate(data, range, {
              planes,
              decodePlanes,
              maskPlane,
              layout,
              width,
              jitter,
              planeStride: opts.planeStride ?? null,
            });
            if (c) candidates.push(c);
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const kept = dedupeJitterNeighbours(candidates).slice(0, top);
  return { range: { start: range.start, end: range.end, label: range.label }, best: kept[0] ?? null, candidates: kept };
}

interface CandidateSpec {
  planes: number;
  decodePlanes: number;
  maskPlane: boolean;
  layout: PlanarLayout;
  width: number;
  jitter: number;
  planeStride: number | null;
}

function scoreCandidate(data: Uint8Array, range: ByteRange, spec: CandidateSpec): GfxCandidate | null {
  const offset = range.start + spec.jitter;
  const avail = range.end - offset;
  const rowBytes = spec.width >> 3;
  const bytesPerRow = rowBytes * spec.decodePlanes;
  // Height: for scoring, cap; for plane-major the height IS the plane
  // stride, so it is derived from the range (assume the region bounds the
  // bitmap) rather than capped independently.
  const fullHeight = Math.floor(avail / bytesPerRow);
  if (fullHeight < MIN_ROWS) return null;
  const isPlaneMajor = spec.layout === 'plane-major';
  const height = isPlaneMajor ? Math.min(fullHeight, 512) : Math.min(fullHeight, SCORE_ROWS);

  const cfg: PlanarConfig = {
    width: spec.width,
    height,
    planes: spec.decodePlanes,
    layout: spec.layout,
    offset,
    ...(spec.planeStride != null ? { planeStride: spec.planeStride } : {}),
  };
  if (planarByteLength(cfg) > avail) return null;

  let indices = decodePlanar(data, cfg);
  let scoreHeight = height;
  if (isPlaneMajor && height > SCORE_ROWS) {
    indices = indices.subarray(0, spec.width * SCORE_ROWS);
    scoreHeight = SCORE_ROWS;
  }
  if (spec.maskPlane) {
    // Strip the mask plane's bit before scoring — the colour image is what
    // gets judged; the mask only participates via index compactness.
    const maskBit = ~(1 << (spec.decodePlanes - 1));
    indices = indices.map((v) => v & maskBit);
  }

  const levels = 1 << spec.planes;
  const coherence = 1 - rowIncoherence(indices, spec.width, scoreHeight, levels);
  const runs = meanRunLength(indices, spec.width, scoreHeight);
  // Mean run length is width-normalized in (0, 1]; noise sits near 1/width.
  // Map through a log so "runs of ~8 px" and "runs of ~80 px" both score well.
  const runStructure = clamp01(Math.log2(runs * spec.width) / Math.log2(spec.width));
  const shear = dominantRowShear(indices, spec.width, scoreHeight, SHEAR_MAX);
  const shearScore = 1 - Math.abs(shear) / SHEAR_MAX;
  const usage = indexUsage(indices, levels);

  const allZero = indices.every((v) => v === 0);
  if (allZero) return null;

  // Redundant-plane penalty: decoding N-plane data as 2N planes pairs
  // identical rows into duplicated plane bits, producing a clean-looking
  // image that would otherwise beat the truth on index compactness alone.
  // Constant planes and planes duplicating an earlier plane don't count
  // as evidence for the higher plane count.
  const redundant = redundantPlaneCount(indices, spec.planes);

  const score =
    0.4 * coherence + 0.3 * runStructure + 0.2 * shearScore + 0.1 * usage - 0.12 * redundant;
  return {
    planes: spec.planes,
    width: spec.width,
    height: fullHeight,
    layout: spec.layout,
    offset,
    jitter: spec.jitter,
    planeStride: spec.planeStride,
    maskPlane: spec.maskPlane,
    score: round3(score),
    components: {
      rowCoherence: round3(coherence),
      runStructure: round3(runStructure),
      shear,
      indexUsage: round3(usage),
    },
    shearHint: shear !== 0 ? spec.width + shear : null,
  };
}

/** Planes that are (near-)constant or (near-)duplicates of an earlier plane. */
function redundantPlaneCount(indices: Uint8Array, planes: number): number {
  const n = indices.length;
  let redundant = 0;
  for (let p = 0; p < planes; p++) {
    let ones = 0;
    for (let i = 0; i < n; i++) ones += (indices[i] >> p) & 1;
    if (ones === 0 || ones === n) {
      redundant++;
      continue;
    }
    for (let q = 0; q < p; q++) {
      let same = 0;
      for (let i = 0; i < n; i++) {
        if (((indices[i] >> p) & 1) === ((indices[i] >> q) & 1)) same++;
      }
      if (same / n >= 0.98) {
        redundant++;
        break;
      }
    }
  }
  return redundant;
}

/**
 * Adjacent jitters of the same (planes, width, layout) mostly score
 * near-identically; keep only the best per parameter combination so the
 * contact sheet shows 24 distinct hypotheses, not one hypothesis 16 times.
 */
function dedupeJitterNeighbours(sorted: GfxCandidate[]): GfxCandidate[] {
  const seen = new Set<string>();
  const out: GfxCandidate[] = [];
  for (const c of sorted) {
    const key = `${c.planes}/${c.width}/${c.layout}/${c.maskPlane}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ── Rendering ──────────────────────────────────────────────────────────

const CELL_W = 176;
const CELL_IMG_H = 100;
const CAPTION_H = 10;
const PAD = 4;
const SHEET_COLS = 4;

/** Decode a candidate to RGBA (greyscale ramp unless a confirmed palette is supplied). */
export function renderCandidate(
  data: Uint8Array,
  c: GfxCandidate,
  maxHeight: number,
  palette?: number[],
): { rgba: Uint8Array; width: number; height: number } {
  const height = Math.min(c.height, maxHeight);
  const cfg: PlanarConfig = {
    width: c.width,
    height,
    planes: c.planes + (c.maskPlane ? 1 : 0),
    layout: c.layout,
    offset: c.offset,
    ...(c.planeStride != null ? { planeStride: c.planeStride } : {}),
  };
  let indices = decodePlanar(data, cfg);
  if (c.maskPlane) {
    const maskBit = ~(1 << c.planes);
    indices = indices.map((v) => v & maskBit);
  }
  const rgba = indicesToRGBA(indices, palette ?? greyscaleRamp(c.planes));
  return { rgba, width: c.width, height };
}

/** The labelled contact-sheet grid of ranked candidates. */
export function renderContactSheet(data: Uint8Array, candidates: GfxCandidate[], palette?: number[]): Canvas {
  const rows = Math.ceil(candidates.length / SHEET_COLS);
  const cellH = CELL_IMG_H + CAPTION_H + PAD;
  const c = createCanvas(SHEET_COLS * (CELL_W + PAD) + PAD, rows * cellH + PAD, [24, 24, 24]);

  candidates.forEach((cand, i) => {
    const cx = PAD + (i % SHEET_COLS) * (CELL_W + PAD);
    const cy = PAD + Math.floor(i / SHEET_COLS) * cellH;
    const img = renderCandidate(data, cand, CELL_IMG_H, palette);
    // Crop, never scale — a resampled thumbnail can hide the shear/comb
    // signature the sheet exists to show.
    const cropped = cropRGBA(img.rgba, img.width, img.height, CELL_W, CELL_IMG_H);
    fillRect(c, cx, cy, CELL_W, CELL_IMG_H, [0, 0, 0]);
    blitRGBA(c, cropped.rgba, cropped.width, cropped.height, cx, cy);
    const caption = `#${i + 1} P${cand.planes} W${cand.width} ${layoutTag(cand.layout)} J${cand.jitter}${cand.maskPlane ? ' M' : ''} ${cand.score.toFixed(2)}`;
    drawText(c, cx, cy + CELL_IMG_H + 2, caption, [220, 220, 220]);
  });
  return c;
}

function layoutTag(layout: PlanarLayout): string {
  return layout === 'row-interleaved' ? 'ROW' : layout === 'plane-major' ? 'PLN' : 'WRD';
}

function cropRGBA(
  rgba: Uint8Array,
  width: number,
  height: number,
  maxW: number,
  maxH: number,
): { rgba: Uint8Array; width: number; height: number } {
  const w = Math.min(width, maxW);
  const h = Math.min(height, maxH);
  if (w === width && h === height) return { rgba, width, height };
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(rgba.subarray((y * width) * 4, (y * width + w) * 4), y * w * 4);
  }
  return { rgba: out, width: w, height: h };
}

// ── CLI ────────────────────────────────────────────────────────────────

export const GFX_USAGE = `seer-probe gfx <file> [--range start:end] [--regions <probe-map.json>] [--platform amiga]
      [--aga] [--mask] [--jitter 16] [--plane-stride auto|<bytes>] [--palette <file>] [--top 24] [--out <dir>]
  Sweep the Amiga planar parameter space over a range and write a ranked,
  captioned contact-sheet PNG, a full-resolution PNG of the best candidate,
  and JSON with per-candidate score components. Greyscale until a palette
  is confirmed.`;

export function runGfx(argv: string[]): number {
  const { positional, flags } = parseFlags(argv, {
    range: 'string',
    regions: 'string',
    platform: 'string',
    aga: 'bool',
    mask: 'bool',
    jitter: 'number',
    'plane-stride': 'string',
    palette: 'string',
    top: 'number',
    out: 'string',
  });
  const file = positional[0];
  if (!file) {
    console.error(GFX_USAGE);
    return 1;
  }
  const platform = (flags.platform as string) ?? 'amiga';
  if (platform !== 'amiga') {
    console.error(`gfx: only --platform amiga is implemented (got ${platform})`);
    return 1;
  }
  const strideRaw = flags['plane-stride'] as string | undefined;
  const planeStride = strideRaw && strideRaw !== 'auto' ? parseNumber(strideRaw, '--plane-stride') : null;

  const data = readBinary(file);
  const ranges = resolveRanges(
    { range: flags.range as string | undefined, regions: flags.regions as string | undefined },
    data.length,
    'gfx',
  );
  const palette = flags.palette ? loadPalette(flags.palette as string) : undefined;
  const outDir = ensureOutDir(flags.out as string | undefined);

  const result: GfxResult = { file, size: data.length, ranges: [] };
  for (const r of ranges) {
    const swept = sweepGfx(data, r, {
      aga: flags.aga as boolean | undefined,
      mask: flags.mask as boolean | undefined,
      jitter: flags.jitter as number | undefined,
      planeStride,
      top: flags.top as number | undefined,
    });
    result.ranges.push(swept);

    // Suffix every partial range, not just multi-region runs — two --range
    // invocations on the same file must not overwrite each other's artifacts.
    const suffix = r.start === 0 && r.end === data.length ? '' : `-0x${r.start.toString(16)}`;
    if (swept.candidates.length > 0) {
      const sheet = renderContactSheet(data, swept.candidates, palette);
      const sheetPath = artifactPath(outDir, 'gfx', file, `${suffix}-sheet.png`);
      writePNG(sheetPath, sheet.rgba, sheet.width, sheet.height);

      const best = swept.best!;
      const full = renderCandidate(data, best, 1024, palette);
      const bestPath = artifactPath(outDir, 'gfx', file, `${suffix}-best.png`);
      writePNG(bestPath, full.rgba, full.width, full.height);

      console.log(
        `0x${r.start.toString(16)}-0x${r.end.toString(16)}: best P${best.planes} W${best.width} ${best.layout} ` +
          `+${best.jitter} score ${best.score}` +
          (best.shearHint !== null ? ` (shearHint: try width ${best.shearHint})` : ''),
      );
      console.log(`wrote ${sheetPath}`);
      console.log(`wrote ${bestPath}`);
    } else {
      console.log(`0x${r.start.toString(16)}-0x${r.end.toString(16)}: no decodable candidates`);
    }
  }

  const only = ranges.length === 1 ? ranges[0] : null;
  const jsonSuffix = only && !(only.start === 0 && only.end === data.length) ? `-0x${only.start.toString(16)}` : '';
  const jsonPath = artifactPath(outDir, 'gfx', file, `${jsonSuffix}.json`);
  writeJson(jsonPath, result);
  console.log(`wrote ${jsonPath}`);
  return 0;
}

/**
 * `--palette` file: raw big-endian 16-bit colour words (OCS 0x0RGB), or a
 * JSON array of `[r,g,b]` triples / flat numbers. Palettes are a
 * confirmed-knowledge input, so the format is strict.
 */
function loadPalette(path: string): number[] {
  const bytes = readBinary(path);
  const text = tryText(bytes);
  if (text?.trimStart().startsWith('[')) {
    const arr = JSON.parse(text) as number[] | [number, number, number][];
    return arr.flat() as number[];
  }
  const out: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const word = (bytes[i] << 8) | bytes[i + 1];
    out.push(((word >> 8) & 0xf) * 17, ((word >> 4) & 0xf) * 17, (word & 0xf) * 17);
  }
  return out;
}

function tryText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
