import { describe, expect, it } from 'vitest';
import { turnLeft, turnRight, type Pose } from '../model/Pose.js';
import { rotate, leftOf, rightOf, step, project, FACING_DELTAS } from '../model/Direction.js';

// Black Crypt's confirmed facing convention (data-structure.md, "Party
// Movement / Facing State Machine"): 0=N, 1=E, 2=S, 3=W; Y increases
// northward, X increases eastward.
describe('FACING_DELTAS', () => {
  it("matches ApplyFacingDelta's confirmed jump table", () => {
    expect(FACING_DELTAS[0]).toEqual({ dx: 0, dy: 1 }); // N
    expect(FACING_DELTAS[1]).toEqual({ dx: 1, dy: 0 }); // E
    expect(FACING_DELTAS[2]).toEqual({ dx: 0, dy: -1 }); // S
    expect(FACING_DELTAS[3]).toEqual({ dx: -1, dy: 0 }); // W
  });
});

describe('rotate / leftOf / rightOf', () => {
  it('wraps mod 4 in both directions', () => {
    expect(rotate(0, 1)).toBe(1);
    expect(rotate(3, 1)).toBe(0); // W -> N
    expect(rotate(0, -1)).toBe(3); // N -> W
    expect(rotate(0, -5)).toBe(3); // large negative still wraps correctly
  });

  it('leftOf/rightOf are 90 degrees either way, and inverses of each other', () => {
    for (let f = 0; f < 4; f++) {
      const facing = f as 0 | 1 | 2 | 3;
      expect(rightOf(leftOf(facing))).toBe(facing);
      expect(leftOf(rightOf(facing))).toBe(facing);
    }
    // Facing N (0): left is W (3), right is E (1) -- matches the driver's
    // `(facing-1)&3` / `(facing+1)&3` wall-bit selection.
    expect(leftOf(0)).toBe(3);
    expect(rightOf(0)).toBe(1);
  });
});

describe('step / project', () => {
  it('steps one cell in the facing direction', () => {
    expect(step(5, 5, 0)).toEqual({ x: 5, y: 6 }); // N: y+1
    expect(step(5, 5, 1)).toEqual({ x: 6, y: 5 }); // E: x+1
    expect(step(5, 5, 2)).toEqual({ x: 5, y: 4 }); // S: y-1
    expect(step(5, 5, 3)).toEqual({ x: 4, y: 5 }); // W: x-1
  });

  it("projects forward+lateral facing north: lateral+ is east (party's right)", () => {
    // Facing N, forward is +Y, right is E (+X).
    expect(project(0, 0, 0, 2, 0)).toEqual({ x: 0, y: 2 });
    expect(project(0, 0, 0, 2, 1)).toEqual({ x: 1, y: 2 }); // right
    expect(project(0, 0, 0, 2, -1)).toEqual({ x: -1, y: 2 }); // left
  });

  it("projects forward+lateral facing east: lateral+ is south (party's right)", () => {
    // Facing E, forward is +X, right is S (-Y) -- matches the driver's
    // per-facing lateral-step table (data-structure.md, "Phase 1":
    // facing 1 (E) -> forward X += D2, lateral Y -= D3).
    expect(project(0, 0, 1, 2, 1)).toEqual({ x: 2, y: -1 });
    expect(project(0, 0, 1, 2, -1)).toEqual({ x: 2, y: 1 });
  });
});

describe('turnLeft / turnRight', () => {
  const pose: Pose = { level: 1, x: 0, y: 0, facing: 0 };

  it('turnLeft is delta=-1 (TurnParty delta=3), turnRight is delta=+1', () => {
    expect(turnLeft(pose).facing).toBe(3);
    expect(turnRight(pose).facing).toBe(1);
  });

  it('four turns the same way return to the original facing', () => {
    let p = pose;
    for (let i = 0; i < 4; i++) p = turnRight(p);
    expect(p.facing).toBe(pose.facing);
  });

  it('does not mutate the input pose', () => {
    const before = { ...pose };
    turnLeft(pose);
    expect(pose).toEqual(before);
  });
});
