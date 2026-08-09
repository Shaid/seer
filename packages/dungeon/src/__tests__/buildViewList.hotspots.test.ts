/**
 * M4 — `buildViewList` wires the real, confirmed hotspot codes
 * (`data-structure.md` "Clickable-hotspot globals") onto alcove/plaque/
 * door-switch prop items, and carries the source entity + a stable handle
 * so `Walker.pick`/`PatchedCellQuery.setPatch` can address it. Reuses
 * `props.test.ts`'s real, on-disk `(map, row, col)` fixtures rather than
 * synthesizing entities, so this is exercised against real `bcdfs` data.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateSlotTableFile, validateDungeonLevelFile } from '../schema/validate.js';
import { FlatGridLevel } from '../model/FlatGridLevel.js';
import { buildViewList } from '../view/buildViewList.js';
import { viewSpecFromSlotTable } from '../view/ViewSpec.js';
import type { Pose, Dir4 } from '../model/Pose.js';
import type { SemanticsFile } from '../schema/semantics.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SEMANTICS = {
  schemaVersion: 1,
  confidence: 'confirmed',
  source: 'test',
  walls: {},
  features: {},
} as SemanticsFile;

function load() {
  const levelFile = validateDungeonLevelFile(
    JSON.parse(readFileSync(`${FIXTURES}levels-trimmed.json`, 'utf8')),
  );
  const slots = validateSlotTableFile(
    JSON.parse(readFileSync(`${FIXTURES}slots-with-props.json`, 'utf8')),
  );
  const unit = levelFile.units.find((u) => u.id === 1)!;
  return { level: new FlatGridLevel(levelFile, unit), spec: viewSpecFromSlotTable(slots), slots };
}

const FACINGS: Dir4[] = [0, 1, 2, 3];

/** Every prop item `buildViewList` emits across all 4 facings at `(x, y)`. */
function propItemsAt(x: number, y: number) {
  const { level, spec, slots } = load();
  const items = FACINGS.flatMap((facing) => {
    const pose: Pose = { level: 1, x, y, facing };
    return buildViewList(level, pose, spec, SEMANTICS, slots).filter((i) => i.kind === 'prop');
  });
  return items;
}

describe('buildViewList: M4 hotspot/entity wiring on real props.test.ts fixtures', () => {
  it('alcove (row 2, col 35) carries hotspot code 0x69, its source entity, and a FlatGridLevel-shaped handle', () => {
    // This cell also carries a plain floor item on the same same-square
    // chain (a real, on-disk co-occurrence -- an alcove and a dropped item
    // can share a square), so filter to the alcove's own entity type rather
    // than asserting every item at this cell is one.
    const items = propItemsAt(35, 2).filter((i) => i.entity?.type === 0x16);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.hotspot).toEqual({ code: 0x69 });
      expect(item.entity?.type).toBe(0x16);
      expect(item.entityHandle).toMatch(/^1:2:35:\d+$/);
    }
  });

  it('plaque (row 5, col 43) carries hotspot code 0x6a or 0x6f (type 0x20/0x21) and a handle', () => {
    const items = propItemsAt(43, 5).filter(
      (i) => i.entity?.type === 0x20 || i.entity?.type === 0x21,
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect([0x6a, 0x6f]).toContain(item.hotspot?.code);
      expect([0x20, 0x21]).toContain(item.entity?.type);
      expect(item.entityHandle).toMatch(/^1:5:43:\d+$/);
    }
  });

  it('door-switch (row 5, col 55) carries hotspot code 0x64 and a handle', () => {
    // Same co-occurrence caveat as the alcove case above -- this square also
    // carries a plain floor item.
    const items = propItemsAt(55, 5).filter((i) => i.entity?.type === 0x0f);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.hotspot).toEqual({ code: 0x64 });
      expect(item.entity?.type).toBe(0x0f);
      expect(item.entityHandle).toMatch(/^1:5:55:\d+$/);
    }
  });

  it('stairs (row 18, col 5) render as a prop but carry no hotspot code (not a known clickable structure)', () => {
    const items = propItemsAt(5, 18).filter((i) => i.entity?.type === 0x12);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.hotspot).toBeUndefined();
      expect(item.entity?.type).toBe(0x12);
    }
  });

  it('every item (wall or prop) carries the absolute cell it was resolved at', () => {
    const { level, spec, slots } = load();
    const pose: Pose = { level: 1, x: 35, y: 2, facing: 0 };
    const items = buildViewList(level, pose, spec, SEMANTICS, slots);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(typeof item.cellX).toBe('number');
      expect(typeof item.cellY).toBe('number');
    }
  });
});
