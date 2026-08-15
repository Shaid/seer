/**
 * Byte-range selection shared by gfx/audio/stride: an explicit `--range`,
 * a `--regions <probe-map.json>` file produced by `probe map` (so offsets
 * flow between commands as a pipeline rather than being hand-copied), or
 * the whole file.
 */

import { readFileSync } from 'node:fs';
import { parseNumber } from './args.js';

export interface ByteRange {
  start: number;
  end: number; // exclusive
  /** Where this range came from — 'range' flag, a map region's class, or 'file'. */
  label: string;
}

/** Parse `--range start:end` (either bound may be hex `0x…`; end is exclusive). */
export function parseRange(raw: string, fileSize: number): ByteRange {
  const m = raw.split(':');
  if (m.length !== 2) throw new Error(`--range must be start:end, got ${raw}`);
  const start = m[0] === '' ? 0 : parseNumber(m[0], '--range start');
  const end = m[1] === '' ? fileSize : parseNumber(m[1], '--range end');
  if (start < 0 || end > fileSize || start >= end) {
    throw new Error(`--range ${raw} out of bounds for ${fileSize}-byte file`);
  }
  return { start, end, label: 'range' };
}

/** Region classes worth sweeping per command (a text region is never a bitmap candidate, etc.). */
const SWEEPABLE: Record<string, (cls: string) => boolean> = {
  gfx: (c) => !['zero-fill', 'ascii-text'].includes(c),
  audio: (c) => !['zero-fill', 'ascii-text'].includes(c),
  stride: () => true,
};

interface MapRegionJson {
  start: number;
  end: number;
  class: string;
}

/** Load candidate ranges from `probe map`'s JSON output. */
export function rangesFromMapJson(path: string, forCommand: 'gfx' | 'audio' | 'stride'): ByteRange[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { regions?: MapRegionJson[] };
  if (!Array.isArray(parsed.regions)) {
    throw new Error(`--regions ${path}: no "regions" array (expected probe map JSON output)`);
  }
  const keep = SWEEPABLE[forCommand];
  return parsed.regions
    .filter((r) => keep(r.class))
    .map((r) => ({ start: r.start, end: r.end, label: r.class }));
}

/**
 * Resolve the ranges a command should operate on from its flags. Precedence:
 * `--range` > `--regions` > whole file.
 */
export function resolveRanges(
  flags: { range?: string; regions?: string },
  fileSize: number,
  forCommand: 'gfx' | 'audio' | 'stride',
): ByteRange[] {
  if (flags.range) return [parseRange(flags.range, fileSize)];
  if (flags.regions) {
    const ranges = rangesFromMapJson(flags.regions, forCommand).filter(
      (r) => r.start < fileSize && r.end <= fileSize && r.start < r.end,
    );
    if (ranges.length === 0) {
      throw new Error(`--regions: no sweepable regions for ${forCommand} in ${flags.regions}`);
    }
    return ranges;
  }
  return [{ start: 0, end: fileSize, label: 'file' }];
}
