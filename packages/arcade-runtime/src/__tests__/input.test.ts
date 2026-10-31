import { describe, expect, it } from 'vitest';
import {
  ArcadeInput,
  applyGamepad,
  cleanOpposingDirections,
  defaultInputBindings,
  inputMask,
  inputNames,
  rebindKey,
  type GamepadLike,
} from '../input.js';
import { createInputMap } from '../input-map.js';

function key(type: 'keydown' | 'keyup', code: string): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, 'code', { value: code });
  return e;
}

function pad(index: number, pressed: number[], axes: number[] = [0, 0]): GamepadLike {
  return {
    index,
    connected: true,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
    axes,
  };
}

describe('input masks', () => {
  it('round-trips names and masks', () => {
    const m = inputMask('UP', 'BUTTON1', 'COIN');
    expect(m).toBe(ArcadeInput.UP | ArcadeInput.BUTTON1 | ArcadeInput.COIN);
    expect(inputNames(m)).toEqual(['UP', 'BUTTON1', 'COIN']);
  });

  it('all inputs fit in 16 bits with distinct bits', () => {
    const bits = Object.values(ArcadeInput);
    expect(new Set(bits).size).toBe(bits.length);
    expect(bits.reduce((a, b) => a | b, 0)).toBeLessThan(0x10000);
  });

  it('cleans opposing directions', () => {
    expect(cleanOpposingDirections(inputMask('LEFT', 'RIGHT', 'UP'))).toBe(ArcadeInput.UP);
    expect(cleanOpposingDirections(inputMask('UP', 'DOWN', 'BUTTON2'))).toBe(ArcadeInput.BUTTON2);
  });

  it('default bindings are JSON-serialisable', () => {
    const b = defaultInputBindings();
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });

  it('rebindKey replaces the previous key for that player+input', () => {
    const b = rebindKey(defaultInputBindings(), 'KeyZ', { player: 0, input: 'BUTTON1' });
    expect(b.keyboard.KeyZ).toEqual({ player: 0, input: 'BUTTON1' });
    expect(b.keyboard.ControlLeft).toBeUndefined();
    const both = rebindKey(defaultInputBindings(), 'KeyZ', { player: 0, input: 'BUTTON1' }, false);
    expect(both.keyboard.ControlLeft).toBeDefined();
  });

  it('applyGamepad reads buttons and the stick', () => {
    const masks = [0, 0];
    const binding = defaultInputBindings().gamepads[1]!;
    applyGamepad(masks, pad(1, [0, 9], [-0.9, 0.7]), binding);
    expect(masks[0]).toBe(0);
    expect(masks[1]).toBe(inputMask('BUTTON1', 'START', 'LEFT', 'DOWN'));
  });
});

describe('createInputMap', () => {
  it('samples held keys per player', () => {
    const target = new EventTarget();
    const map = createInputMap({ target, getGamepads: null });
    target.dispatchEvent(key('keydown', 'ArrowLeft'));
    target.dispatchEvent(key('keydown', 'KeyA'));
    expect(map.sample()).toEqual([ArcadeInput.LEFT, ArcadeInput.BUTTON1]);
    expect(map.sample()).toEqual([ArcadeInput.LEFT, ArcadeInput.BUTTON1]);
    target.dispatchEvent(key('keyup', 'ArrowLeft'));
    expect(map.sample()).toEqual([0, ArcadeInput.BUTTON1]);
    map.dispose();
  });

  it('a tap between samples is held for exactly one sample', () => {
    const target = new EventTarget();
    const map = createInputMap({ target, getGamepads: null });
    target.dispatchEvent(key('keydown', 'Digit5'));
    target.dispatchEvent(key('keyup', 'Digit5'));
    expect(map.sample()).toEqual([ArcadeInput.COIN, 0]);
    expect(map.sample()).toEqual([0, 0]);
  });

  it('prevents default only on bound keys and clears on blur', () => {
    const target = new EventTarget();
    const map = createInputMap({ target, getGamepads: null });
    const bound = key('keydown', 'Space');
    const unbound = key('keydown', 'KeyP');
    target.dispatchEvent(bound);
    target.dispatchEvent(unbound);
    expect(bound.defaultPrevented).toBe(true);
    expect(unbound.defaultPrevented).toBe(false);
    map.sample();
    target.dispatchEvent(new Event('blur'));
    expect(map.sample()).toEqual([0, 0]);
  });

  it('merges gamepads with keyboard and cleans opposing directions', () => {
    const target = new EventTarget();
    const map = createInputMap({ target, getGamepads: () => [pad(0, [15]), null] });
    target.dispatchEvent(key('keydown', 'ArrowLeft'));
    expect(map.sample()[0]).toBe(0); // left (key) + right (pad) cancel
    const raw = createInputMap({ target, getGamepads: () => [pad(0, [15])], cleanOpposing: false });
    target.dispatchEvent(key('keydown', 'ArrowUp'));
    expect(raw.sample()[0]).toBe(inputMask('UP', 'RIGHT'));
  });

  it('captureNextKey swallows the key it captures', async () => {
    const target = new EventTarget();
    const map = createInputMap({ target, getGamepads: null });
    const p = map.captureNextKey();
    target.dispatchEvent(key('keydown', 'ArrowUp'));
    expect(await p).toBe('ArrowUp');
    expect(map.sample()).toEqual([0, 0]);
  });

  it('setBindings remaps live', () => {
    const target = new EventTarget();
    const map = createInputMap({ target, getGamepads: null });
    map.setBindings(rebindKey(map.bindings, 'KeyZ', { player: 1, input: 'BUTTON4' }));
    target.dispatchEvent(key('keydown', 'KeyZ'));
    expect(map.sample()).toEqual([0, ArcadeInput.BUTTON4]);
  });
});
