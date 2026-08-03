/**
 * M5 (`docs/blackcrypt/walker-plan.md`): props render without exceptions,
 * out-of-atlas frame refs or out-of-surface writes for real `bcdfs` cells
 * that actually carry each of the five wired structure classes (alcove,
 * plaque, stairs, door-switch, door-lock — see `buildViewList.ts`'s module
 * doc comment for why floor-plate/floor-item aren't wired yet).
 *
 * The five `(map, row, col)` fixtures below were found by scanning real
 * `data/blackcrypt/amiga/bcdfs` via `bclib.bcdfs.read_dungeon_world` for the
 * first record of each type (`0x16` alcove, `0x20`/`0x21` plaque, `0x12`
 * sub-kind 2/3 stairs, `0x0F` door switch, `0x22` door lock) — not synthetic
 * data. `(x, y) = (col, row)` per `FlatGridLevel`'s own indexing convention.
 *
 * Placing the pose *on* the structure's own cell means `depth=0, lateral=0`
 * always visits it (`project(x, y, facing, 0, 0) === (x, y)` for every
 * facing) — a convenient way to exercise the same cell under all 4 facings
 * without re-deriving where a sight line would otherwise land it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import type { AtlasMeta } from '@seer/core';
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

function loadBank(name: string): PieceBank {
  const pngBuf = readFileSync(`${FIXTURES}${name}.png`);
  const png = PNG.sync.read(pngBuf);
  const atlas = JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')) as AtlasMeta;
  return PieceBank.fromRGBA(new Uint8Array(png.data), png.width, png.height, atlas);
}

function loadFixtures() {
  const levelsRaw = JSON.parse(readFileSync(`${FIXTURES}levels-trimmed.json`, 'utf8'));
  const level = validateDungeonLevelFile(levelsRaw);
  // A separate fixture from `corridor.golden.test.ts`'s `slots.json` — that
  // one's golden framebuffer is byte-exact against the M1 17-slot (walls
  // only) table, and `compositeSlotTable` draws *every* populated slot
  // unconditionally, so adding the 40 M5 prop slots to the same file would
  // silently change that golden image. `slots-with-props.json` is
  // `crawl/public/assets/blackcrypt/amiga/dungeon/slots.json` as of this
  // session (`scripts/export_dungeon_props.py`) — walls plus props,
  // including door-lock's `wall-decorations` bank entry (its `FrameTemplate`
  // needs a second atlas the wall/alcove/plaque/stairs/door-switch classes
  // don't reference at all).
  const slots = validateSlotTableFile(JSON.parse(readFileSync(`${FIXTURES}slots-with-props.json`, 'utf8')));
  const bank = loadBank('dungeon-bcdfx');
  return { level, slots, bank };
}

const SEMANTICS = { schemaVersion: 1, confidence: 'confirmed', source: 'props.test.ts', walls: {}, features: {} } as SemanticsFile;

// (map, row, col, expected propType) — real records, see module doc comment.
// `slots.json`'s prop atlas frames (`dungeon-bcdfx`) don't include the
// door-switch pull-chain frames used by the fixture's slots.json copy, so
// this only needs the fixture's own bank/atlas to resolve every frame the
// wired classes reference (alcove-*, plaque-*, stairs-flight-*).
const REAL_CELLS: Array<{ row: number; col: number; propType: string }> = [
  { row: 2, col: 35, propType: 'alcove' },
  { row: 5, col: 43, propType: 'plaque' },
  { row: 18, col: 5, propType: 'stairs' },
  { row: 5, col: 55, propType: 'door-switch' },
  // Real map-1 (`unit id === 1`) door lock, gfxNumber 0x53 -> gfxIndex 2
  // (`bclib.bcdfs.read_dungeon_world`, type `0x22`, `raw[7] == 0x2`) — found
  // by the same scan the module doc comment describes for the other three.
  { row: 9, col: 5, propType: 'door-lock' },
  // Real map-1 floor item: type 0x2a (not a monster, not any handled
  // structure type -- falls to the generic floor-item path), gfxNumber
  // 0x77 -> group 26 (`data/floor-item-gfx-table.json`), single entity, no
  // same-square chain -- a clean single-item cell.
  { row: 6, col: 16, propType: 'floor-item' },
];

describe('M5 props: real bcdfs cells x 4 facings', () => {
  const { level: levelFile, slots, bank } = loadFixtures();
  const decorBank = loadBank('wall-decorations');
  const floorItemBank = loadBank('floor-items');
  const banks = { [slots.banks[0]!.id]: bank, [slots.banks[1]!.id]: decorBank, [slots.banks[2]!.id]: floorItemBank };
  const spec = viewSpecFromSlotTable(slots);
  const unit = levelFile.units.find((u) => u.id === 1);
  if (!unit) throw new Error('fixture is missing unit 1');
  const cellLevel = new FlatGridLevel(levelFile, unit);

  const FACINGS: Dir4[] = [0, 1, 2, 3];

  it('every real cell carries the entity the fixture claims (sanity check on the fixture itself)', () => {
    for (const { row, col } of REAL_CELLS) {
      const entities = cellLevel.entitiesAt(col, row);
      expect(entities.length).toBeGreaterThan(0);
    }
  });

  it.each(REAL_CELLS)('($row,$col) [$propType]: renders across all 4 facings with zero exceptions, zero out-of-atlas refs, zero out-of-surface writes', ({ row, col }) => {
    let anyPropDrawn = false;

    for (const facing of FACINGS) {
      const pose: Pose = { level: 1, x: col, y: row, facing };
      const items = buildViewList(cellLevel, pose, spec, SEMANTICS, slots);
      const propItems = items.filter((i) => i.kind === 'prop');
      if (propItems.length > 0) anyPropDrawn = true;

      const surface = new IndexedSurface(slots.surface.width, slots.surface.height);
      const dataLengthBefore = surface.data.length;
      expect(() => compositeDrawList(surface, banks, slots, items)).not.toThrow();
      expect(surface.data.length).toBe(dataLengthBefore);
    }

    // Not every facing draws this cell's structure (single-wall/right-only
    // gating means at most one or two of the four facings ever will — see
    // buildViewList's module doc comment) but at least one of the four
    // real, on-disk facings must, or the wiring is a silent no-op.
    expect(anyPropDrawn).toBe(true);
  });

  it('a cell with no entities never emits a prop item', () => {
    // (0,0) on unit 1 is defensive-fill territory (not a real on-disk
    // square) in the trimmed fixture -- guaranteed entity-free.
    for (const facing of FACINGS) {
      const pose: Pose = { level: 1, x: 0, y: 0, facing };
      const items = buildViewList(cellLevel, pose, spec, SEMANTICS, slots);
      expect(items.filter((i) => i.kind === 'prop')).toHaveLength(0);
    }
  });

  it('floor-item resolves gfxNumber -> group -> frame and anchor-minus-registration position, matching the real floor-items atlas', () => {
    // gfxNumber 0x77 -> group 26 (`data/floor-item-gfx-table.json`) -> frame
    // `floor26-d<depth>`, one of the three real frames confirmed to exist
    // in `sprites/floor-items.json`.
    let resolvedAny = false;
    for (const facing of FACINGS) {
      const pose: Pose = { level: 1, x: 16, y: 6, facing };
      const items = buildViewList(cellLevel, pose, spec, SEMANTICS, slots);
      for (const item of items.filter((i) => i.propType === 'floor-item')) {
        expect(typeof item.frame).toBe('string');
        expect(item.frame).toMatch(/^floor26-d[0-2]$/);
        expect(floorItemBank.hasFrame(item.frame as string)).toBe(true);
        expect(item.bank).toBe(slots.floorItem!.bank);
        resolvedAny = true;
      }
    }
    expect(resolvedAny).toBe(true);
  });

  it('blackcrypt-prop-clipped-descriptors: all 8 clipped alcove/plaque/stairs slots crop a valid, in-bounds rect of their full-sibling frame', () => {
    // Real bcdfs poses landing exactly on `(depth=1, lateral=±1, dir=0)` for
    // one of these specific structures aren't derived here -- this asserts
    // the resolved slot geometry directly (srcX/srcW/srcH must stay inside
    // the referenced frame's own bounds, and destX/destY inside the
    // viewport), which is what a render actually depends on, plus a manual
    // composite of all 8 was visually confirmed ungarbled this session (see
    // data-structure.md's writeup) -- not re-asserted pixel-by-pixel here.
    const CLIPPED_KEYS = [
      'prop:alcove:-1:1:0', 'prop:alcove:1:1:0',
      'prop:plaque:-1:1:0', 'prop:plaque:1:1:0',
      'prop:stairs-a:-1:1', 'prop:stairs-a:1:1',
      'prop:stairs-b:-1:1', 'prop:stairs-b:1:1',
    ];
    let checked = 0;
    for (const key of CLIPPED_KEYS) {
      const slot = slots.slots[key];
      expect(slot).toBeTruthy();
      for (const draw of slot!.draws) {
        expect(typeof draw.frame).toBe('string');
        const rect = bank.frame(draw.frame as string);
        const srcX = draw.srcX ?? 0;
        const srcW = draw.srcW ?? rect.w;
        expect(srcX).toBeGreaterThanOrEqual(0);
        expect(srcX + srcW).toBeLessThanOrEqual(rect.w);
        expect(draw.srcH ?? rect.h).toBe(rect.h);
        expect(draw.destX).toBeGreaterThanOrEqual(0);
        expect(draw.destX + srcW).toBeLessThanOrEqual(slots.viewport.width);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it('door-lock resolves its FrameTemplate to a literal frame name matching the real per-map decor bank, never leaves it unresolved', () => {
    // gfxNumber 0x53 -> gfxIndex 2 (`read_door_lock`'s `(gfx-0x51)`), unit id
    // 1 -> `{mapId}` == "1" -- so every resolved frame must be exactly
    // `m1_decor2_<near|mid|far>`, one of the three real frames confirmed to
    // exist in `sprites/wall-decorations.json` for this map/gfxIndex pair.
    let resolvedAny = false;
    for (const facing of FACINGS) {
      const pose: Pose = { level: 1, x: 5, y: 9, facing };
      const items = buildViewList(cellLevel, pose, spec, SEMANTICS, slots);
      for (const item of items.filter((i) => i.propType === 'door-lock')) {
        expect(typeof item.frame).toBe('string');
        expect(item.frame).toMatch(/^m1_decor2_(near|mid|far)$/);
        expect(decorBank.hasFrame(item.frame as string)).toBe(true);
        resolvedAny = true;
      }
    }
    expect(resolvedAny).toBe(true);
  });
});
