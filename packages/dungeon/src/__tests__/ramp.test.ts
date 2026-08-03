/**
 * M4 — ramp-aware rendering (`walker-plan.md` "ramp-aware rendering"): the
 * real `bcdfx` indexed atlas (`scripts/export_dungeon_tileset_indexed.py`)
 * plus its ramp0/ramp3 palette files — `bcdfx` serves both (levels 1-4 use
 * ramp 0, levels 12-13 use ramp 3), and one baked-ramp0 atlas is provably
 * wrong for the latter. This proves the fix at the data level: the same
 * decoded index buffer renders to *different* RGBA colors under ramp0 vs.
 * ramp3, and `PieceBank.fromIndexedRGBA` recovers indices that round-trip
 * exactly back to the source pixels through the ramp they were baked with.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import type { AtlasMeta } from '@seer/core';
import { PieceBank } from '../raster/PieceBank.ts';
import { indicesToRGBA, parseRampPalette, paletteRampForUnit, rampPalettePath, indexedTilesetPaths, type RampPaletteFile } from '../raster/palette.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function loadPNG(name: string) {
  const png = PNG.sync.read(readFileSync(`${FIXTURES}${name}`));
  return { rgba: new Uint8Array(png.data), width: png.width, height: png.height };
}

function loadRampPalette(name: string) {
  return parseRampPalette(JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as RampPaletteFile);
}

describe('rampPalettePath / indexedTilesetPaths — naming convention', () => {
  it('matches the real files export_dungeon_tileset_indexed.py writes', () => {
    expect(rampPalettePath('bcdfx', 0)).toBe('palettes/dungeon-bcdfx-ramp0.json');
    expect(rampPalettePath('bcdfx', 3)).toBe('palettes/dungeon-bcdfx-ramp3.json');
    expect(indexedTilesetPaths('bcdfx')).toEqual({
      indexPng: 'textures/dungeon-bcdfx-indexed.png',
      maskPng: 'textures/dungeon-bcdfx-indexed-mask.png',
      atlasJson: 'textures/dungeon-bcdfx-indexed.json',
    });
  });
});

describe('paletteRampForUnit', () => {
  it('uses LevelUnit.paletteRamp when present', () => {
    expect(paletteRampForUnit({ paletteRamp: 3 })).toBe(3);
  });

  it('defaults to 0 for a unit without one', () => {
    expect(paletteRampForUnit({})).toBe(0);
  });
});

describe('PieceBank.fromIndexedRGBA + ramp swap — real bcdfx assets', () => {
  const index = loadPNG('dungeon-bcdfx-indexed.png');
  const mask = loadPNG('dungeon-bcdfx-indexed-mask.png');
  const atlas = JSON.parse(readFileSync(`${FIXTURES}dungeon-bcdfx-indexed.json`, 'utf8')) as AtlasMeta;
  const ramp0 = loadRampPalette('dungeon-bcdfx-ramp0.json');
  const ramp3 = loadRampPalette('dungeon-bcdfx-ramp3.json');

  it('ramp0/ramp3 are both real 64-entry palettes and are not identical (bcdfx genuinely serves two different ramps)', () => {
    expect(ramp0).toHaveLength(64);
    expect(ramp3).toHaveLength(64);
    expect(ramp0).not.toEqual(ramp3);
  });

  it('decodes the real indexed atlas against its own baked (ramp0) palette with zero mismatches', () => {
    // fromIndexedRGBA throws on any pixel color not found in basePalette,
    // so simply not throwing is the exact-recovery proof — no silent
    // approximation possible.
    expect(() => PieceBank.fromIndexedRGBA(index.rgba, mask.rgba, index.width, index.height, atlas, ramp0)).not.toThrow();
  });

  it('recovered indices round-trip byte-exact back to the source RGBA through the same (ramp0) palette', () => {
    const bank = PieceBank.fromIndexedRGBA(index.rgba, mask.rgba, index.width, index.height, atlas, ramp0);
    const rebuilt = indicesToRGBA(bank.index, ramp0);
    // Compare RGB only (source alpha may legitimately differ per-pixel where
    // the atlas has fully-transparent padding; index/mask handle that
    // separately, not via alpha here since basePalette itself has a=255
    // uniformly). A single mismatch-count assertion, not a per-pixel
    // `expect` call — the latter's diffing overhead times out on a
    // multi-hundred-thousand-byte image for no extra signal.
    let mismatches = 0;
    for (let i = 0; i < bank.index.length; i++) {
      const o = i * 4;
      if (rebuilt[o] !== index.rgba[o] || rebuilt[o + 1] !== index.rgba[o + 1] || rebuilt[o + 2] !== index.rgba[o + 2]) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('rejects being paired with a ramp that is not actually the atlas\'s baked ramp (a wrong-ramp pairing does not silently "work")', () => {
    // ramp3's colors mostly differ from ramp0's, so decoding the ramp0-baked
    // PNG against ramp3 as if it were the base should fail to find at least
    // one pixel's color in ramp3's table.
    expect(() => PieceBank.fromIndexedRGBA(index.rgba, mask.rgba, index.width, index.height, atlas, ramp3)).toThrow(/isn't in basePalette/);
  });

  it('the SAME recovered index buffer renders to different RGBA colors under ramp0 vs ramp3 (the actual M4 bug fix, not just "didn\'t crash")', () => {
    const bank = PieceBank.fromIndexedRGBA(index.rgba, mask.rgba, index.width, index.height, atlas, ramp0);
    const underRamp0 = indicesToRGBA(bank.index, ramp0);
    const underRamp3 = indicesToRGBA(bank.index, ramp3);
    let differingPixels = 0;
    for (let i = 0; i < bank.index.length; i++) {
      const o = i * 4;
      if (underRamp0[o] !== underRamp3[o] || underRamp0[o + 1] !== underRamp3[o + 1] || underRamp0[o + 2] !== underRamp3[o + 2]) {
        differingPixels++;
      }
    }
    expect(differingPixels).toBeGreaterThan(0);
  });

  it('exposes real bank frames from the indexed atlas (same frame-lookup API as fromRGBA)', () => {
    const bank = PieceBank.fromIndexedRGBA(index.rgba, mask.rgba, index.width, index.height, atlas, ramp0);
    const firstFrame = atlas.frames[0]!;
    expect(bank.hasFrame(firstFrame.name)).toBe(true);
    expect(bank.frame(firstFrame.name)).toEqual({ x: firstFrame.x, y: firstFrame.y, w: firstFrame.w, h: firstFrame.h });
  });
});
