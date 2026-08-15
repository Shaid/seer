import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMap, renderMap } from '../map.js';
import { classifyWindows } from '../classify.js';
import { parseFlags } from '../args.js';
import { parseRange, rangesFromMapJson } from '../range.js';
import { randomBytes } from './helpers.js';

describe('analyzeMap', () => {
  it('produces the documented JSON shape', () => {
    const data = new Uint8Array(2048);
    const result = analyzeMap(data, 'blob.bin', 256);
    expect(result).toMatchObject({ file: 'blob.bin', size: 2048, window: 256 });
    expect(result.regions[0]).toMatchObject({ start: 0, end: 2048, class: 'zero-fill' });
    expect(result.regions[0]).toHaveProperty('confidence');
    expect(result.regions[0]).toHaveProperty('note');
  });
});

describe('renderMap', () => {
  it('renders a stacked canvas with plot, ribbons and region bar', () => {
    const data = randomBytes(8192, 21);
    const wins = classifyWindows(data, 256);
    const regions = analyzeMap(data, 'x', 256).regions;
    const c = renderMap(data, wins, regions, 128);
    // 8192 bytes at width 128 → 64 plot rows, plus 2 ribbons + region bar + labels.
    expect(c.width).toBe(128);
    expect(c.height).toBe(64 + (4 + 20) * 2 + 4 + 12 + 10);
    expect(c.rgba.length).toBe(c.width * c.height * 4);
  });

  it('collapses very large files instead of growing unboundedly', () => {
    const data = new Uint8Array(4 * 1024 * 1024);
    const c = renderMap(data, classifyWindows(data, 65536), analyzeMap(data, 'x', 65536).regions, 512);
    expect(c.height).toBeLessThan(2200);
  });
});

describe('parseFlags', () => {
  it('parses strings, numbers (hex and decimal) and bools', () => {
    const { positional, flags } = parseFlags(['file.bin', '--width', '0x40', '--out=/tmp/x', '--aga'], {
      width: 'number',
      out: 'string',
      aga: 'bool',
    });
    expect(positional).toEqual(['file.bin']);
    expect(flags).toEqual({ width: 64, out: '/tmp/x', aga: true });
  });

  it('rejects unknown flags loudly', () => {
    expect(() => parseFlags(['--wdith', '3'], { width: 'number' })).toThrow(/unknown flag/);
  });
});

describe('range plumbing', () => {
  it('parses hex ranges with open ends', () => {
    expect(parseRange('0x400:0x800', 4096)).toMatchObject({ start: 0x400, end: 0x800 });
    expect(parseRange(':0x800', 4096).start).toBe(0);
    expect(parseRange('0x400:', 4096).end).toBe(4096);
    expect(() => parseRange('0x800:0x400', 4096)).toThrow(/out of bounds/);
  });

  it("map's JSON output feeds gfx/audio via --regions, filtering unsweepable classes", () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-test-'));
    try {
      const json = join(dir, 'probe-map-x.json');
      writeFileSync(
        json,
        JSON.stringify({
          regions: [
            { start: 0, end: 4096, class: 'zero-fill' },
            { start: 4096, end: 8192, class: 'planar-graphics?' },
            { start: 8192, end: 12288, class: 'ascii-text' },
          ],
        }),
      );
      const ranges = rangesFromMapJson(json, 'gfx');
      expect(ranges).toEqual([{ start: 4096, end: 8192, label: 'planar-graphics?' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
