/**
 * M4 — `Walker`, the thin facade composing `WalkerController` + `buildViewList`
 * + `PatchedCellQuery` + `view/Hotspot.ts` + the `AnimRef` tick clock.
 * Exercises the pieces together against a real wired prop class
 * (door-switch, `type 0x0f` — see `view/buildViewList.ts`'s `pushProps`):
 * picking fires `onInteract` with the right entity/handle, `setEntityState`
 * changes what the next `items`/`pick` read reports, and the animation clock
 * only marks the view dirty when a *visible* animated piece actually crosses
 * a frame boundary.
 */
import { describe, expect, it } from 'vitest';
import { Walker } from '../Walker.js';
import { PieceBank } from '../raster/PieceBank.js';
import { doorState } from '../model/EntityState.js';
import { DEFAULT_BINDINGS } from '../schema/bindings.js';
import type { CellQuery } from '../model/CellQuery.js';
import type { SlotTableFile } from '../schema/slots.js';
import type { SemanticsFile } from '../schema/semantics.js';
import type { PieceBankLookup } from '../raster/composite.js';
import type { EntityRecord } from '../schema/level.js';
import type { Pose, Dir4 } from '../model/Pose.js';
import type { KeyStateLike } from '../input/WalkerController.js';

const SEMANTICS = {
  schemaVersion: 1,
  confidence: 'confirmed',
  source: 'test',
  walls: {},
  features: {},
} as SemanticsFile;
const DOOR_SWITCH_HANDLE = '1:0:0:9';

// Pose starts at (0,0) facing E (1); depth 0 projects to the party's own
// cell, which carries a real door-switch (`type 0x0f`) entity. `raw[0x07]`
// bit 3 set satisfies `decoratesRightWall` for facing E (`rightOf(E) = S`,
// `bitIndex = (S+1)&3 = 3` — see `buildViewList.ts`'s `decoratesRightWall`).
function doorSwitchEntity(flags = 0): EntityRecord {
  const raw = new Array(20).fill(0);
  raw[0x07] = 0b1000;
  return { type: 0x0f, flags, raw };
}

function makeLevel(): CellQuery {
  return {
    inBounds: (x, y) => x >= 0 && x <= 1 && y === 0,
    wallAt: () => false,
    planeAt: () => 0,
    entitiesAt(x, y) {
      return x === 0 && y === 0 ? [doorSwitchEntity()] : [];
    },
    entityHandlesAt(x, y) {
      return x === 0 && y === 0 ? [{ handle: DOOR_SWITCH_HANDLE, entity: doorSwitchEntity() }] : [];
    },
  };
}

function makeSlots(): SlotTableFile {
  return {
    schemaVersion: 1,
    surface: { width: 320, height: 200 },
    viewport: { x: 0, y: 0, width: 208, height: 140 },
    depthCount: 1,
    lateralOffsets: [0],
    frontWallMaxDepth: 1,
    banks: [{ id: 'b', atlas: 'a.json', image: 'a.png' }],
    slots: {
      'prop:door-switch:0:0': {
        draws: [{ bank: 'b', frame: 'chain', destX: 10, destY: 20, blend: 'replace' }],
      },
    },
  };
}

function makeBanks(): PieceBankLookup {
  // 4x4 opaque atlas, one frame "chain" at (0,0,4,4) — matches destX/destY above.
  const rgba = new Uint8Array(4 * 4 * 4).fill(0);
  for (let i = 0; i < 4 * 4; i++) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 3] = 255;
  }
  const atlas = { width: 4, height: 4, frames: [{ name: 'chain', x: 0, y: 0, w: 4, h: 4 }] };
  return { b: PieceBank.fromRGBA(rgba, 4, 4, atlas) };
}

const START_POSE: Pose = { level: 1, x: 0, y: 0, facing: 1 as Dir4 };

function makeWalker(options: ConstructorParameters<typeof Walker>[6] = {}) {
  return new Walker(
    makeLevel(),
    makeSlots(),
    SEMANTICS,
    makeBanks(),
    START_POSE,
    DEFAULT_BINDINGS,
    options,
  );
}

const noKeys: KeyStateLike = { isDown: () => false };

describe('Walker.items', () => {
  it("builds the initial view lazily from the starting pose, carrying the door-switch's injected hotspot code", () => {
    const walker = makeWalker();
    expect(walker.items).toHaveLength(1);
    expect(walker.items[0]!.hotspot).toEqual({ code: 0x64 });
    expect(walker.items[0]!.entityHandle).toBe(DOOR_SWITCH_HANDLE);
  });
});

describe('Walker.pick', () => {
  it('hits the door-switch hotspot at its destination rect and fires onInteract with the entity + handle', () => {
    const walker = makeWalker();
    let received: unknown[] | null = null;
    walker.onInteract = (hotspot, entity, handle) => {
      received = [hotspot, entity, handle];
    };
    const result = walker.pick(11, 21); // inside destX=10,destY=20,4x4
    expect(result).not.toBeNull();
    expect(result!.hotspot).toEqual({ code: 0x64 });
    expect(result!.handle).toBe(DOOR_SWITCH_HANDLE);
    expect(result!.entity?.type).toBe(0x0f);
    expect(received).toEqual([{ code: 0x64 }, result!.entity, DOOR_SWITCH_HANDLE]);
  });

  it('divides container coordinates by scale before hit-testing (PixiPresenter-style integer upscale)', () => {
    const walker = makeWalker();
    // Rect is (10,20,4,4) in surface space; at scale 3 the container-space hit is (33,63).
    expect(walker.pick(33, 63, 3)).not.toBeNull();
    expect(walker.pick(999, 999, 3)).toBeNull();
  });

  it('returns null and does not call onInteract on a miss', () => {
    const walker = makeWalker();
    let called = false;
    walker.onInteract = () => {
      called = true;
    };
    expect(walker.pick(0, 0)).toBeNull();
    expect(called).toBe(false);
  });
});

describe('Walker.setEntityState', () => {
  it('marks the view dirty and the patched door state is visible on the next items/pick read', () => {
    const walker = makeWalker();
    walker.pick(11, 21); // populate items/cache once
    walker.setEntityState(DOOR_SWITCH_HANDLE, { open: true, locked: true });

    const hit = walker.pick(11, 21);
    expect(doorState(hit!.entity!)).toEqual({ open: true, locked: true });
  });

  it('applies no policy — opening a "locked" door is not refused here', () => {
    const walker = makeWalker();
    walker.setEntityState(DOOR_SWITCH_HANDLE, { locked: true });
    walker.setEntityState(DOOR_SWITCH_HANDLE, { open: true }); // no check against the locked flag
    const hit = walker.pick(11, 21);
    expect(doorState(hit!.entity!)).toEqual({ open: true, locked: true });
  });
});

describe('Walker.setPose / update — movement integration', () => {
  it('setPose jumps immediately, marking the view dirty (the door-switch entity is only at (0,0))', () => {
    const walker = makeWalker();
    expect(walker.items).toHaveLength(1); // cache populated at (0,0,E)
    walker.setPose({ level: 1, x: 1, y: 0, facing: 1 });
    expect(walker.items).toHaveLength(0);
  });

  it('update() returns the new pose only when movement actually changed it', () => {
    const walker = makeWalker();
    const forwardKeys: KeyStateLike = { isDown: (c) => c === 'KeyW' };
    const changed = walker.update(200, forwardKeys); // exceeds default 175ms step throttle
    expect(changed).not.toBeNull();
    expect(walker.pose.x).toBe(1);
  });

  it('a tiny dtMs with no keys held returns null and does not touch the view', () => {
    const walker = makeWalker();
    const itemsBefore = walker.items;
    expect(walker.update(1, noKeys)).toBeNull();
    expect(walker.items).toBe(itemsBefore); // same cached array reference -- no rebuild happened
  });
});

describe('Walker animation clock', () => {
  function makeAnimatedWalker() {
    const slots = makeSlots();
    slots.slots['prop:door-switch:0:0']!.draws[0]!.frame = {
      frames: ['chain', 'chain'],
      ticksPerFrame: 4,
    };
    return new Walker(makeLevel(), slots, SEMANTICS, makeBanks(), START_POSE, DEFAULT_BINDINGS, {
      ticksPerMs: 1,
    });
  }

  it('does not rebuild items on every update() when no animated piece crosses a frame boundary', () => {
    const walker = makeAnimatedWalker();
    const first = walker.items;
    walker.update(1, noKeys); // tick 0 -> 1, same frame window (ticksPerFrame: 4)
    expect(walker.items).toBe(first);
  });

  it('rebuilds items once a visible animated piece crosses a frame boundary', () => {
    const walker = makeAnimatedWalker();
    const first = walker.items;
    walker.update(4, noKeys); // tick 0 -> 4, crosses the ticksPerFrame:4 boundary
    expect(walker.items).not.toBe(first);
  });
});
