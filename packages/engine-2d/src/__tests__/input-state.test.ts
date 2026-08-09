/**
 * Tests for the camera-agnostic KeyState/PointerState primitives
 * (`@seer-project/engine-2d/input`).
 *
 * No jsdom is configured in this workspace (see vite.config.ts's `test`
 * block and the lack of a `jsdom`/`happy-dom` dependency), so these tests
 * use Node's native `EventTarget`/`Event` globals as a stand-in for
 * `HTMLElement`/`Window` — KeyState/PointerState only call
 * addEventListener/removeEventListener and read plain properties off the
 * dispatched event, so a bare EventTarget is a faithful enough fake.
 */
import { describe, it, expect } from 'vitest';
import { KeyState } from '../KeyState.js';
import { PointerState } from '../PointerState.js';

function fakeTarget() {
  return new EventTarget();
}

function keyEvent(type: string, code: string): Event {
  return Object.assign(new Event(type), { code });
}

function mouseEvent(
  type: string,
  props: Partial<{ clientX: number; clientY: number; buttons: number; button: number }>,
): Event {
  return Object.assign(new Event(type), {
    clientX: 0,
    clientY: 0,
    buttons: 0,
    button: 0,
    ...props,
  });
}

describe('KeyState', () => {
  it('isDown reflects held keys between keydown and keyup', () => {
    const target = fakeTarget();
    const keys = new KeyState(target as unknown as Window);

    expect(keys.isDown('KeyW')).toBe(false);
    target.dispatchEvent(keyEvent('keydown', 'KeyW'));
    expect(keys.isDown('KeyW')).toBe(true);
    target.dispatchEvent(keyEvent('keyup', 'KeyW'));
    expect(keys.isDown('KeyW')).toBe(false);
  });

  it('consumePress is edge-triggered and clears on read', () => {
    const target = fakeTarget();
    const keys = new KeyState(target as unknown as Window);

    target.dispatchEvent(keyEvent('keydown', 'Space'));
    expect(keys.consumePress('Space')).toBe(true);
    // Cleared after the first read — still held, but not a fresh press.
    expect(keys.consumePress('Space')).toBe(false);
    expect(keys.isDown('Space')).toBe(true);
  });

  it('does not re-arm consumePress on repeated keydowns while already held', () => {
    const target = fakeTarget();
    const keys = new KeyState(target as unknown as Window);

    target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    target.dispatchEvent(keyEvent('keydown', 'KeyA')); // simulated OS key-repeat
    expect(keys.consumePress('KeyA')).toBe(true);
    expect(keys.consumePress('KeyA')).toBe(false);
  });

  it('re-arms consumePress after a key is released and pressed again', () => {
    const target = fakeTarget();
    const keys = new KeyState(target as unknown as Window);

    target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    expect(keys.consumePress('KeyA')).toBe(true);
    target.dispatchEvent(keyEvent('keyup', 'KeyA'));
    target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    expect(keys.consumePress('KeyA')).toBe(true);
  });

  it('destroy stops updating state on further events', () => {
    const target = fakeTarget();
    const keys = new KeyState(target as unknown as Window);
    keys.destroy();
    target.dispatchEvent(keyEvent('keydown', 'KeyZ'));
    expect(keys.isDown('KeyZ')).toBe(false);
  });
});

describe('PointerState', () => {
  it('tracks position from move/down/up events', () => {
    const target = fakeTarget();
    const pointer = new PointerState(target as unknown as HTMLElement);

    expect(pointer.position).toEqual({ x: 0, y: 0 });
    target.dispatchEvent(mouseEvent('mousemove', { clientX: 42, clientY: 17 }));
    expect(pointer.position).toEqual({ x: 42, y: 17 });
  });

  it('tracks the held-buttons bitmask', () => {
    const target = fakeTarget();
    const pointer = new PointerState(target as unknown as HTMLElement);

    target.dispatchEvent(mouseEvent('mousedown', { buttons: 1 }));
    expect(pointer.buttons).toBe(1);
    target.dispatchEvent(mouseEvent('mouseup', { buttons: 0 }));
    expect(pointer.buttons).toBe(0);
  });

  it('consumeClick returns the click position once, then null, until the next mouseup', () => {
    const target = fakeTarget();
    const pointer = new PointerState(target as unknown as HTMLElement);

    expect(pointer.consumeClick()).toBeNull();
    target.dispatchEvent(mouseEvent('mousemove', { clientX: 5, clientY: 9 }));
    target.dispatchEvent(mouseEvent('mouseup', { clientX: 5, clientY: 9 }));
    expect(pointer.consumeClick()).toEqual({ x: 5, y: 9 });
    expect(pointer.consumeClick()).toBeNull();
  });

  it('destroy stops updating state on further events', () => {
    const target = fakeTarget();
    const pointer = new PointerState(target as unknown as HTMLElement);
    pointer.destroy();
    target.dispatchEvent(mouseEvent('mousemove', { clientX: 99, clientY: 99 }));
    expect(pointer.position).toEqual({ x: 0, y: 0 });
  });
});
