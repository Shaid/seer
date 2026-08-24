/**
 * `seer-probe map <file>` — the "what am I looking at" pass.
 *
 * One stacked PNG (byte-class plot, entropy ribbon, class-fraction ribbon,
 * labelled region bar) plus a JSON segmentation whose `regions` array is
 * accepted directly by `probe gfx`/`probe audio`/`probe stride` via
 * `--regions`, so offsets flow between commands instead of being
 * hand-copied.
 */

import { readBinary, writeJson, writePNG } from '@seer-project/pipeline';
import { parseFlags } from './args.js';
import { classifyRegions, classifyWindows, type Region, type WindowInfo, type RegionClass } from './classify.js';
import { artifactPath, ensureOutDir } from './out.js';
import { createCanvas, drawText, fillRect, heatColor, setPixel, type Canvas, type RGB } from './render.js';

export interface MapResult {
  file: string;
  size: number;
  window: number;
  regions: Region[];
}

/** Pure analysis half — everything except file I/O and rendering. */
export function analyzeMap(data: Uint8Array, file: string, window = 256): MapResult {
  return { file, size: data.length, window, regions: classifyRegions(data, window) };
}

// ── Rendering ──────────────────────────────────────────────────────────

const BYTE_COLORS: { zero: RGB; ff: RGB; ascii: RGB; ctrl: RGB; high: RGB } = {
  zero: [0, 0, 0],
  ff: [255, 255, 255],
  ascii: [64, 200, 64],
  ctrl: [64, 96, 255],
  high: [230, 64, 64],
};

export const REGION_COLORS: Record<RegionClass, RGB> = {
  'zero-fill': [40, 40, 40],
  'patterned-fill': [110, 80, 170],
  'ascii-text': [64, 200, 64],
  'packed-records': [230, 160, 40],
  'planar-graphics?': [40, 180, 180],
  'pcm-audio?': [220, 80, 220],
  'compressed-or-encrypted': [230, 64, 64],
  'm68k-code?': [64, 96, 255],
  mixed: [128, 128, 128],
};

function byteColor(b: number): RGB {
  if (b === 0x00) return BYTE_COLORS.zero;
  if (b === 0xff) return BYTE_COLORS.ff;
  if (b >= 0x20 && b <= 0x7e) return BYTE_COLORS.ascii;
  if (b <= 0x1f) return BYTE_COLORS.ctrl;
  return BYTE_COLORS.high;
}

const MAX_PLOT_ROWS = 2048;
const RIBBON_H = 20;
const GAP = 4;
const REGION_BAR_H = 12;
const LABEL_H = 10;

/** Render the stacked map PNG. Exposed for tests (pure: canvas in, canvas out). */
export function renderMap(
  data: Uint8Array,
  wins: WindowInfo[],
  regions: Region[],
  width = 512,
): Canvas {
  // Byte plot: 1 px per byte, collapsing to 1 px per `scale` bytes
  // (dominant class) when the file would exceed MAX_PLOT_ROWS rows.
  const scale = Math.max(1, Math.ceil(data.length / (width * MAX_PLOT_ROWS)));
  const plotRows = Math.max(1, Math.ceil(data.length / scale / width));
  const height = plotRows + (GAP + RIBBON_H) * 2 + GAP + REGION_BAR_H + LABEL_H;
  const c = createCanvas(width, height, [24, 24, 24]);

  for (let px = 0; px * scale < data.length; px++) {
    const x = px % width;
    const y = Math.floor(px / width);
    setPixel(c, x, y, scale === 1 ? byteColor(data[px]) : dominantColor(data, px * scale, scale));
  }

  const toX = (offset: number) => Math.min(width - 1, Math.floor((offset / data.length) * width));

  // Entropy ribbon.
  const entropyY = plotRows + GAP;
  for (const w of wins) {
    const x0 = toX(w.start);
    const x1 = Math.max(x0 + 1, toX(w.end));
    fillRect(c, x0, entropyY, x1 - x0, RIBBON_H, heatColor(w.entropy / 8));
  }

  // Class-fraction ribbon: stacked zero/ascii/ctrl/high/ff per column.
  const fracY = entropyY + RIBBON_H + GAP;
  for (const w of wins) {
    const x0 = toX(w.start);
    const x1 = Math.max(x0 + 1, toX(w.end));
    const stack: [RGB, number][] = [
      [BYTE_COLORS.zero, w.fractions.zero],
      [BYTE_COLORS.ascii, w.fractions.ascii],
      [BYTE_COLORS.ctrl, w.fractions.ctrl],
      [BYTE_COLORS.high, w.fractions.high],
      [BYTE_COLORS.ff, w.fractions.ff],
    ];
    let y = fracY;
    for (const [color, frac] of stack) {
      const h = Math.round(frac * RIBBON_H);
      fillRect(c, x0, y, x1 - x0, h, color);
      y += h;
    }
  }

  // Region bar + offset labels.
  const regionY = fracY + RIBBON_H + GAP;
  const labelY = regionY + REGION_BAR_H + 1;
  let lastLabelEnd = -Infinity;
  for (const r of regions) {
    const x0 = toX(r.start);
    const x1 = Math.max(x0 + 1, toX(r.end));
    fillRect(c, x0, regionY, x1 - x0, REGION_BAR_H, REGION_COLORS[r.class]);
    const label = `0X${r.start.toString(16).toUpperCase()}`;
    if (x0 > lastLabelEnd + 4) {
      lastLabelEnd = x0 + drawText(c, x0, labelY, label, [200, 200, 200]);
    }
  }

  return c;
}

function dominantColor(data: Uint8Array, start: number, count: number): RGB {
  const tallies = { zero: 0, ff: 0, ascii: 0, ctrl: 0, high: 0 };
  const end = Math.min(start + count, data.length);
  for (let i = start; i < end; i++) {
    const b = data[i];
    if (b === 0x00) tallies.zero++;
    else if (b === 0xff) tallies.ff++;
    else if (b >= 0x20 && b <= 0x7e) tallies.ascii++;
    else if (b <= 0x1f) tallies.ctrl++;
    else tallies.high++;
  }
  let best: keyof typeof tallies = 'zero';
  for (const k of Object.keys(tallies) as (keyof typeof tallies)[]) {
    if (tallies[k] > tallies[best]) best = k;
  }
  return BYTE_COLORS[best];
}

// ── CLI ────────────────────────────────────────────────────────────────

export const MAP_USAGE = `seer-probe map <file> [--window 256] [--width 512] [--out <dir>]
  Segment a file into class-labelled regions. Writes probe-map-<name>.png
  (byte plot + entropy + class fractions + region bar) and .json (regions,
  feedable to gfx/audio/stride via --regions).`;

export async function runMap(argv: string[]): Promise<number> {
  const { positional, flags } = parseFlags(argv, {
    window: 'number',
    width: 'number',
    out: 'string',
  });
  const file = positional[0];
  if (!file) {
    console.error(MAP_USAGE);
    return 1;
  }
  const data = readBinary(file);
  const window = (flags.window as number) ?? 256;
  const width = (flags.width as number) ?? 512;

  const result = analyzeMap(data, file, window);
  const canvas = renderMap(data, classifyWindows(data, window), result.regions, width);

  const outDir = ensureOutDir(flags.out as string | undefined);
  const pngPath = artifactPath(outDir, 'map', file, '.png');
  const jsonPath = artifactPath(outDir, 'map', file, '.json');
  await writePNG(pngPath, canvas.rgba, canvas.width, canvas.height);
  writeJson(jsonPath, result);

  console.log(`${result.size} bytes, ${result.regions.length} regions:`);
  for (const r of result.regions) {
    console.log(
      `  0x${r.start.toString(16)}-0x${r.end.toString(16)} ${r.class} (entropy ${r.entropy.toFixed(2)}, confidence ${r.confidence.toFixed(2)})`,
    );
  }
  console.log(`wrote ${pngPath}`);
  console.log(`wrote ${jsonPath}`);
  return 0;
}
