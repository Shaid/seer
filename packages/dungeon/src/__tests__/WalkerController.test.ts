import { describe, expect, it } from 'vitest';
import { WalkerController, type KeyStateLike } from '../input/WalkerController.ts';
import { DEFAULT_BINDINGS } from '../schema/bindings.ts';
import type { Pose } from '../model/Pose.ts';

/** A trivial `KeyStateLike` fake — a fixed set of held codes, no DOM. */
class FakeKeys implements KeyStateLike {
  private readonly held: Set<string>;
  constructor(codes: string[] = []) {
    this.held = new Set(codes);
  }
  isDown(code: string): boolean {
    return this.held.has(code);
  }
}

const START: Pose = { level: 1, x: 5, y: 5, facing: 0 };

describe('WalkerController throttling', () => {
  it('emits null every frame while nothing is held', () => {
    const controller = new WalkerController(START, DEFAULT_BINDINGS);
    const keys = new FakeKeys();
    for (let i = 0; i < 10; i++) expect(controller.update(16, keys)).toBeNull();
  });

  it('does not step before stepIntervalMs has accumulated, even with the key held the whole time', () => {
    const controller = new WalkerController(START, DEFAULT_BINDINGS, { stepIntervalMs: 200 });
    const keys = new FakeKeys(['KeyW']);
    expect(controller.update(50, keys)).toBeNull();
    expect(controller.update(50, keys)).toBeNull();
    expect(controller.update(50, keys)).toBeNull();
    // 150ms accumulated, still under 200ms.
    expect(controller.pose).toEqual(START);
  });

  it('steps exactly once the interval is reached, not once per frame while held', () => {
    const controller = new WalkerController(START, DEFAULT_BINDINGS, { stepIntervalMs: 200 });
    const keys = new FakeKeys(['KeyW']);
    controller.update(50, keys);
    controller.update(50, keys);
    controller.update(50, keys);
    const result = controller.update(50, keys); // 200ms total -> should step
    expect(result).not.toBeNull();
    expect(result).toEqual({ level: 1, x: 5, y: 6, facing: 0 }); // facing N: y+1
    // Immediately after, the throttle has reset -- another 50ms call must not step again.
    expect(controller.update(50, keys)).toBeNull();
  });

  it('turning and stepping have independent throttles', () => {
    const controller = new WalkerController(START, DEFAULT_BINDINGS, { stepIntervalMs: 1000, turnIntervalMs: 100 });
    const keys = new FakeKeys(['KeyE']); // turnRight
    const result = controller.update(100, keys);
    expect(result).not.toBeNull();
    expect(result!.facing).toBe(1); // N -> E
    expect(result!.x).toBe(START.x);
    expect(result!.y).toBe(START.y);
  });

  it('only emits a new Pose on a real change, never as a side-effect of ticking', () => {
    const controller = new WalkerController(START, DEFAULT_BINDINGS, { stepIntervalMs: 100, turnIntervalMs: 100 });
    const keys = new FakeKeys();
    // Plenty of throttle-crossing ticks with nothing held: always null.
    for (let i = 0; i < 20; i++) expect(controller.update(37, keys)).toBeNull();
  });
});

describe('WalkerController movement directions', () => {
  it('forward moves in the facing direction, back moves opposite', () => {
    const forward = new WalkerController({ ...START, facing: 1 }, DEFAULT_BINDINGS, { stepIntervalMs: 10 });
    const fKeys = new FakeKeys(['KeyW']);
    const fResult = forward.update(10, fKeys);
    expect(fResult).toEqual({ level: 1, x: 6, y: 5, facing: 1 }); // E: x+1

    const back = new WalkerController({ ...START, facing: 1 }, DEFAULT_BINDINGS, { stepIntervalMs: 10 });
    const bKeys = new FakeKeys(['KeyS']);
    const bResult = back.update(10, bKeys);
    expect(bResult).toEqual({ level: 1, x: 4, y: 5, facing: 1 }); // opposite of E: x-1
  });

  it('strafeLeft/strafeRight move sideways without changing facing', () => {
    const controller = new WalkerController({ ...START, facing: 0 }, DEFAULT_BINDINGS, { stepIntervalMs: 10 });
    const keys = new FakeKeys(['KeyA']); // strafeLeft, facing N -> left is W
    const result = controller.update(10, keys);
    expect(result).toEqual({ level: 1, x: 4, y: 5, facing: 0 });
  });
});

describe('WalkerController collision integration', () => {
  it('does not move when the injected canStep predicate rejects the step, but still resets the throttle', () => {
    const controller = new WalkerController(START, DEFAULT_BINDINGS, { stepIntervalMs: 50, canStep: () => false });
    const keys = new FakeKeys(['KeyW']);
    expect(controller.update(50, keys)).toBeNull();
    expect(controller.pose).toEqual(START);
  });

  it('moves when the injected canStep predicate allows it', () => {
    const controller = new WalkerController(START, DEFAULT_BINDINGS, { stepIntervalMs: 50, canStep: () => true });
    const keys = new FakeKeys(['KeyW']);
    const result = controller.update(50, keys);
    expect(result).toEqual({ level: 1, x: 5, y: 6, facing: 0 });
  });
});

describe('WalkerController rebinding', () => {
  it('changing bindings.json-equivalent key codes actually changes what triggers movement', () => {
    const rebound = {
      ...DEFAULT_BINDINGS,
      bindings: { ...DEFAULT_BINDINGS.bindings, forward: ['KeyI'] },
    };
    const controller = new WalkerController(START, rebound, { stepIntervalMs: 10 });

    // The old default ('KeyW') no longer does anything.
    expect(controller.update(10, new FakeKeys(['KeyW']))).toBeNull();
    expect(controller.pose).toEqual(START);

    // The rebound key does.
    const result = controller.update(10, new FakeKeys(['KeyI']));
    expect(result).toEqual({ level: 1, x: 5, y: 6, facing: 0 });
  });
});

describe('WalkerController interact/automap code accessors', () => {
  it('exposes the bound codes for one-shot actions', () => {
    const controller = new WalkerController(START, DEFAULT_BINDINGS);
    expect(controller.interactCodes()).toEqual(['Space']);
    expect(controller.automapCodes()).toEqual(['Tab']);
  });
});
