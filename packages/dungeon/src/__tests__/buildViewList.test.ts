import { describe, expect, it } from 'vitest';
import { buildViewList } from '../view/buildViewList.js';
import { viewSpecFromSlotTable } from '../view/ViewSpec.js';
import { FlatGridLevel } from '../model/FlatGridLevel.js';
import type { Pose } from '../model/Pose.js';
import type { DungeonLevelFile } from '../schema/level.js';
import type { SlotTableFile } from '../schema/slots.js';
import type { SemanticsFile } from '../schema/semantics.js';

const WIDTH = 5;
const HEIGHT = 5;
// facing 0 (N): project(x0=2, y0=0, depth, lateral) = (2+lateral, depth) --
// see Pose.test.ts's confirmed FACING_DELTAS/project math.
const POSE: Pose = { level: 1, x: 2, y: 0, facing: 0 };

function idx(x: number, y: number): number {
  return y * WIDTH + x;
}

function makeLevel(wallBits: Partial<Record<string, number>>): FlatGridLevel {
  const wallFlags = new Array(WIDTH * HEIGHT).fill(0);
  for (const [key, bits] of Object.entries(wallBits)) {
    const [x, y] = key.split(',').map(Number);
    wallFlags[idx(x!, y!)] = bits!;
  }
  const file: DungeonLevelFile = {
    schemaVersion: 1,
    game: 'test',
    platform: 'test',
    cellSpace: { kind: 'flat', width: WIDTH, height: HEIGHT },
    wallStorage: { kind: 'bitflags', plane: 'wallFlags', bits: [1, 2, 4, 8] },
    yAxisDown: false,
    units: [{ id: 1, planes: { wallFlags } }],
  };
  return new FlatGridLevel(file, file.units[0]!);
}

const N = 1,
  E = 2,
  W = 8;

function makeSlots(): SlotTableFile {
  const slots: SlotTableFile['slots'] = {};
  for (let depth = 0; depth < 4; depth++) {
    for (const lateral of [0, 1, -1]) {
      if (depth < 3) {
        slots[`front:${lateral}:${depth}`] = {
          draws: [
            { bank: 'b', frame: `front-${lateral}-${depth}`, destX: 0, destY: 0, blend: 'replace' },
          ],
        };
      }
    }
    slots[`side:L:${depth}`] = {
      draws: [{ bank: 'b', frame: `side-L-${depth}`, destX: 0, destY: 0, blend: 'mask' }],
    };
    slots[`side:R:${depth}`] = {
      draws: [{ bank: 'b', frame: `side-R-${depth}`, destX: 0, destY: 0, blend: 'mask' }],
    };
  }
  return {
    schemaVersion: 1,
    surface: { width: 320, height: 200 },
    viewport: { x: 0, y: 0, width: 208, height: 140 },
    depthCount: 4,
    lateralOffsets: [0, 1, -1],
    frontWallMaxDepth: 3,
    banks: [{ id: 'b', atlas: 'a.json', image: 'a.png' }],
    slots,
  };
}

const SEMANTICS = {
  schemaVersion: 1,
  confidence: 'confirmed',
  source: 'test',
  walls: {},
  features: {},
} as SemanticsFile;

// Every fixture in this file uses plain string frames, never an `AnimRef` —
// `frame` is asserted as `string` here for that reason (M4 widened
// `DrawItem.frame` to `FrameRef`; see `raster/anim.test.ts` for `AnimRef` coverage).
function framesOf(items: ReturnType<typeof buildViewList>): string[] {
  return items.map((i) => i.frame as string).sort();
}

describe('buildViewList', () => {
  it('emits nothing when there are no walls anywhere', () => {
    const level = makeLevel({});
    const items = buildViewList(
      level,
      POSE,
      viewSpecFromSlotTable(makeSlots()),
      SEMANTICS,
      makeSlots(),
    );
    expect(items).toEqual([]);
  });

  it('emits a front-wall item when the cell ahead has a wall facing the pose', () => {
    // cell (depth=1, lateral=0) = (2, 1); pose faces N, so test bit N.
    const level = makeLevel({ '2,1': N });
    const items = buildViewList(
      level,
      POSE,
      viewSpecFromSlotTable(makeSlots()),
      SEMANTICS,
      makeSlots(),
    );
    expect(framesOf(items)).toEqual(['front-0-1']);
    expect(items[0]).toMatchObject({ kind: 'front', depth: 1, lateral: 0 });
  });

  it('never emits a front-wall item at depth >= frontWallMaxDepth (the depth<3 gate)', () => {
    // cell (depth=3, lateral=0) = (2, 3) -- has an N wall, but depth 3 is excluded.
    const level = makeLevel({ '2,3': N });
    const items = buildViewList(
      level,
      POSE,
      viewSpecFromSlotTable(makeSlots()),
      SEMANTICS,
      makeSlots(),
    );
    expect(items).toEqual([]);
  });

  it('emits front-wall items at non-zero lateral offsets too (front is not lateral-gated)', () => {
    // cell (depth=1, lateral=1) = (3, 1); still tests bit N (facing-relative, not cell-relative).
    const level = makeLevel({ '3,1': N });
    const items = buildViewList(
      level,
      POSE,
      viewSpecFromSlotTable(makeSlots()),
      SEMANTICS,
      makeSlots(),
    );
    expect(framesOf(items)).toEqual(['front-1-1']);
    expect(items[0]).toMatchObject({ kind: 'front', depth: 1, lateral: 1 });
  });

  it('emits left/right side-wall items only at the centre column (lateral === 0)', () => {
    // Facing N: left = W (bit 8), right = E (bit 2). Cell (2, 2) is the
    // lateral=0 cell at depth 2.
    const level = makeLevel({ '2,2': W | E });
    const items = buildViewList(
      level,
      POSE,
      viewSpecFromSlotTable(makeSlots()),
      SEMANTICS,
      makeSlots(),
    );
    expect(framesOf(items)).toEqual(['side-L-2', 'side-R-2']);
  });

  it('never emits a side-wall item off the centre column, even if that cell has the same wall bits', () => {
    // Cell (3, 2) is the lateral=+1 cell at depth 2 -- same W|E bits, but
    // side walls are gated to lateral === 0 only.
    const level = makeLevel({ '3,2': W | E });
    const items = buildViewList(
      level,
      POSE,
      viewSpecFromSlotTable(makeSlots()),
      SEMANTICS,
      makeSlots(),
    );
    expect(items).toEqual([]);
  });

  it('side walls are tested up through the full depthCount (unlike front walls)', () => {
    // depth 3, lateral 0 = (2, 3) -- side walls have no depth<3 gate.
    const level = makeLevel({ '2,3': W });
    const items = buildViewList(
      level,
      POSE,
      viewSpecFromSlotTable(makeSlots()),
      SEMANTICS,
      makeSlots(),
    );
    expect(framesOf(items)).toEqual(['side-L-3']);
  });

  it('skips a cell that projects out of bounds without throwing', () => {
    // Pose right at the west edge: lateral=-1 projects to x=-1, out of bounds.
    const edgePose: Pose = { level: 1, x: 0, y: 0, facing: 0 };
    const level = makeLevel({});
    expect(() =>
      buildViewList(level, edgePose, viewSpecFromSlotTable(makeSlots()), SEMANTICS, makeSlots()),
    ).not.toThrow();
  });

  it('is a no-op for a slot key the table does not define (missing, not an error)', () => {
    const level = makeLevel({ '2,1': N });
    const slots = makeSlots();
    delete slots.slots['front:0:1'];
    const items = buildViewList(level, POSE, viewSpecFromSlotTable(slots), SEMANTICS, slots);
    expect(items).toEqual([]);
  });

  it('forwards every PieceDraw field from the slot entry untouched', () => {
    const level = makeLevel({ '2,1': N });
    const slots = makeSlots();
    slots.slots['front:0:1'] = {
      draws: [
        {
          bank: 'b',
          frame: 'x',
          destX: 16,
          destY: 5,
          mirrorX: true,
          blend: 'replace',
          priority: 0x64,
          origin: 'cite',
        },
      ],
    };
    const items = buildViewList(level, POSE, viewSpecFromSlotTable(slots), SEMANTICS, slots);
    expect(items[0]).toMatchObject({
      bank: 'b',
      frame: 'x',
      destX: 16,
      destY: 5,
      mirrorX: true,
      blend: 'replace',
      priority: 0x64,
      origin: 'cite',
    });
  });
});
