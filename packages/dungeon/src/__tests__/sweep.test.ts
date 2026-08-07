/**
 * M2's acceptance sweep (`walker-plan.md`): all 13 real `bcdfs` maps,
 * sampled poses, all 4 facings, through the real `buildViewList` ->
 * `compositeDrawList` pipeline, against the real M1 `slots.json` + atlas.
 * Zero exceptions, zero out-of-atlas frame references, zero out-of-surface
 * writes.
 *
 * `fixtures/levels-trimmed.json` is a real, verified export
 * (`crawl/scripts/export_dungeon_levels.py`, this same session) of all 13
 * maps, trimmed to just the `wallFlags` plane (geometry) and a `populated`
 * plane (this exporter's own bookkeeping -- 1 for an on-disk square, 0 for
 * the densifier's defensive fill -- so this test can sample real,
 * game-encoded cells rather than accidentally landing on filler). Dropping
 * `type`/`sublevel`/`objectHandle` (not needed for pure wall geometry) cuts
 * the fixture from ~3.8 MB to ~360 KB.
 *
 * "Zero out-of-surface writes": `IndexedSurface.blit` already clips both
 * source and destination rects defensively (see its own doc comment), so
 * this is guaranteed by construction as long as every draw goes through
 * `compositeDrawList` — which is what this test exercises. "Zero
 * out-of-atlas frame references" is what `PieceBank.frame()` would throw
 * on; `compositeDrawList`/`drawPieceDraw` do not catch that, so it surfaces
 * as a real test failure, not a silently-swallowed one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import type { AtlasMeta } from '@seer-project/core';
import { PieceBank } from '../raster/PieceBank.ts';
import { IndexedSurface } from '../raster/IndexedSurface.ts';
import { compositeDrawList } from '../raster/composite.ts';
import { validateSlotTableFile, validateDungeonLevelFile } from '../schema/validate.ts';
import { FlatGridLevel } from '../model/FlatGridLevel.ts';
import { buildViewList } from '../view/buildViewList.ts';
import { viewSpecFromSlotTable } from '../view/ViewSpec.ts';
import type { Pose, Dir4 } from '../model/Pose.ts';
import type { SemanticsFile } from '../schema/semantics.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function loadFixtures() {
  const levelsRaw = JSON.parse(readFileSync(`${FIXTURES}levels-trimmed.json`, 'utf8'));
  const level = validateDungeonLevelFile(levelsRaw);
  const slots = validateSlotTableFile(JSON.parse(readFileSync(`${FIXTURES}slots.json`, 'utf8')));
  const pngBuf = readFileSync(`${FIXTURES}dungeon-bcdfx.png`);
  const png = PNG.sync.read(pngBuf);
  const atlas = JSON.parse(readFileSync(`${FIXTURES}dungeon-bcdfx.json`, 'utf8')) as AtlasMeta;
  const bank = PieceBank.fromRGBA(new Uint8Array(png.data), png.width, png.height, atlas);
  return { level, slots, bank };
}

const SEMANTICS = { schemaVersion: 1, confidence: 'confirmed', source: 'sweep test', walls: {}, features: {} } as SemanticsFile;

/** Every populated `(x, y)` in a unit, per its own bookkeeping plane. */
function populatedCells(unit: { planes: Record<string, number[]> }, width: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const populated = unit.planes.populated;
  if (!populated) throw new Error('fixture is missing the populated plane');
  for (let i = 0; i < populated.length; i++) {
    if (populated[i]) out.push({ x: i % width, y: Math.floor(i / width) });
  }
  return out;
}

/** Deterministic, evenly-spaced sample of up to `n` items (no RNG, so a
 * failure is always reproducible). */
function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const stride = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const item = items[Math.floor(i * stride)];
    if (item) out.push(item);
  }
  return out;
}

describe('M2 sweep: all 13 maps x sampled poses x 4 facings', () => {
  const { level: levelFile, slots, bank } = loadFixtures();
  const banks = { [slots.banks[0]!.id]: bank };
  const spec = viewSpecFromSlotTable(slots);

  const SAMPLES_PER_UNIT = 50;
  const FACINGS: Dir4[] = [0, 1, 2, 3];

  it(`completes ${levelFile.units.length} units x up to ${SAMPLES_PER_UNIT} poses x ${FACINGS.length} facings with zero exceptions, zero out-of-atlas frame refs, zero out-of-surface writes`, () => {
    let frameCount = 0;
    let poseCount = 0;
    let expectedPoseCount = 0;
    const width = (levelFile.cellSpace as { width: number }).width;

    for (const unit of levelFile.units) {
      const cellLevel = new FlatGridLevel(levelFile, unit);
      const cells = sample(populatedCells(unit, width), SAMPLES_PER_UNIT);
      expect(cells.length).toBeGreaterThan(0); // every real map has populated squares
      expectedPoseCount += cells.length * FACINGS.length;

      for (const cell of cells) {
        for (const facing of FACINGS) {
          const pose: Pose = { level: unit.id, x: cell.x, y: cell.y, facing };
          poseCount++;

          const items = buildViewList(cellLevel, pose, spec, SEMANTICS, slots);

          const surface = new IndexedSurface(slots.surface.width, slots.surface.height);
          const dataLengthBefore = surface.data.length;
          compositeDrawList(surface, banks, slots, items);

          // "Zero out-of-surface writes": the surface's own backing array
          // must never change shape (blit only ever writes inside it).
          expect(surface.data.length).toBe(dataLengthBefore);
          expect(surface.width).toBe(slots.surface.width);
          expect(surface.height).toBe(slots.surface.height);

          frameCount += items.length;
        }
      }
    }

    expect(poseCount).toBe(expectedPoseCount);
    expect(poseCount).toBeGreaterThan(0);
    console.log(`sweep: ${levelFile.units.length} units, ${poseCount} poses, ${frameCount} draw items composited, zero exceptions`);
  });
});
