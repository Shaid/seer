/**
 * `canStep` unit tests, plus the M3 loop-closure proof: a real 2x2 open
 * block in map 1 (`bcdfb`, dungeon level 2) at cells `(35,1)`, `(36,1)`,
 * `(36,2)`, `(35,2)` (x,y) — found by scanning `data/blackcrypt/amiga/bcdfs`
 * (via `bclib.bcdfs`) for a 2x2 block where all 4 cells are non-wall and all
 * 4 connecting edges are open, then independently confirmed against
 * `scripts/automap_tiles.py`'s own wall-bit reads (see the crawl-side
 * session notes; the exact `wallFlags` values used below —
 * `(1,35)=0xc, (1,36)=0x4, (2,36)=0x0, (2,35)=0x9` — are reproduced in this
 * repo's `fixtures/levels-trimmed.json`, itself a real
 * `export_dungeon_levels.py` export). Walking east, north, west, south and
 * turning to match returns to the *exact* start pose — a genuine circuit,
 * not the there-and-back substitute the walker plan allows when no loop can
 * be found.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canStep } from '../model/collision.js';
import { FlatGridLevel } from '../model/FlatGridLevel.js';
import { validateDungeonLevelFile } from '../schema/validate.js';
import type { CellQuery } from '../model/CellQuery.js';
import type { Pose, Dir4 } from '../model/Pose.js';
import { turnLeft } from '../model/Pose.js';
import { step } from '../model/Direction.js';
import type { SemanticsFile } from '../schema/semantics.js';

const SEMANTICS: SemanticsFile = {
  schemaVersion: 1,
  confidence: 'confirmed',
  source: 'collision.test.ts',
  walls: {},
  features: {},
};

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function loadRealLevel() {
  const raw = JSON.parse(readFileSync(`${FIXTURES}levels-trimmed.json`, 'utf8'));
  const file = validateDungeonLevelFile(raw);
  const unit = file.units.find((u) => u.id === 1);
  if (!unit) throw new Error('fixture is missing unit 1');
  return new FlatGridLevel(file, unit);
}

/** A tiny hand-built 2x2 world for exercising `canStep`'s own logic in isolation from real map data. */
class TinyWorld implements CellQuery {
  // wallFlags per (x,y), bit 1=N,2=E,4=S,8=W — same convention as Black Crypt.
  private readonly walls: Record<string, number>;
  constructor(walls: Record<string, number>) {
    this.walls = walls;
  }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < 2 && y >= 0 && y < 2;
  }
  wallAt(x: number, y: number, dir: Dir4): boolean {
    const bits = this.walls[`${x},${y}`] ?? 0;
    return (bits & [1, 2, 4, 8][dir]!) !== 0;
  }
  planeAt(): number {
    return 0;
  }
  entitiesAt(): [] {
    return [];
  }
}

/** A `CellQuery` whose `wallAt` throws for one specific edge, simulating an unmapped/unknown wall value. */
class ThrowingWorld implements CellQuery {
  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < 4 && y >= 0 && y < 4;
  }
  wallAt(): boolean {
    throw new Error('unmapped wall value');
  }
  planeAt(): number {
    return 0;
  }
  entitiesAt(): [] {
    return [];
  }
}

describe('canStep', () => {
  it('blocks on a known wall', () => {
    const world = new TinyWorld({ '0,0': 2 }); // E wall at (0,0)
    const pose: Pose = { level: 1, x: 0, y: 0, facing: 0 };
    expect(canStep(world, SEMANTICS, pose, 1)).toBe(false); // moving E is blocked
  });

  it('allows a known-open edge', () => {
    const world = new TinyWorld({}); // no walls anywhere
    const pose: Pose = { level: 1, x: 0, y: 0, facing: 0 };
    expect(canStep(world, SEMANTICS, pose, 1)).toBe(true); // E is open, and (1,0) is in bounds
  });

  it('blocks stepping out of bounds even with no wall bit set', () => {
    const world = new TinyWorld({});
    const pose: Pose = { level: 1, x: 1, y: 1, facing: 0 };
    expect(canStep(world, SEMANTICS, pose, 1)).toBe(false); // (2,1) is out of bounds
  });

  it('fails closed on an unmapped/unknown wall value (wallAt throws)', () => {
    const world = new ThrowingWorld();
    const pose: Pose = { level: 1, x: 1, y: 1, facing: 0 };
    // Destination is in bounds, so the only reason to block is the fail-closed contract.
    expect(canStep(world, SEMANTICS, pose, 1)).toBe(false);
  });
});

describe('canStep against real Black Crypt map data', () => {
  const level = loadRealLevel();

  it('matches the known wallFlags values for the loop cells', () => {
    // (1,35)=0xc, (1,36)=0x4, (2,36)=0x0, (2,35)=0x9 -- see module doc comment.
    expect(level.wallAt(35, 1, 1)).toBe(false); // E open from (35,1)
    expect(level.wallAt(36, 1, 0)).toBe(false); // N open from (36,1)
    expect(level.wallAt(36, 2, 3)).toBe(false); // W open from (36,2)
    expect(level.wallAt(35, 2, 2)).toBe(false); // S open from (35,2)
  });

  it('walks a full circuit of a real corridor loop and returns to the exact start pose', () => {
    let pose: Pose = { level: 1, x: 35, y: 1, facing: 1 }; // facing E
    const start = { ...pose };

    // E -> N -> W -> S is exactly the `turnLeft` cycle (rotate by -1 each
    // time), so turning to face each leg of the loop is a plain turnLeft.
    const moves: Dir4[] = [1, 0, 3, 2]; // E, N, W, S
    for (const dir of moves) {
      while (pose.facing !== dir) pose = turnLeft(pose);
      expect(canStep(level, SEMANTICS, pose, dir)).toBe(true);
      const { x, y } = step(pose.x, pose.y, dir);
      pose = { ...pose, x, y };
    }
    // One more turnLeft closes the facing cycle back to the start (S -> E).
    pose = turnLeft(pose);

    expect(pose).toEqual(start);
  });
});
