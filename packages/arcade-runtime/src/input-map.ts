/**
 * Live input source: keyboard events plus Gamepad API polling, sampled once
 * per sim step into one bitmask per player.
 */

import {
  applyGamepad,
  cleanOpposingDirections,
  defaultInputBindings,
  ArcadeInput,
  type GamepadLike,
  type InputBindings,
} from './input.js';

export interface InputMapOptions {
  /** Where keyboard events are listened for, default `window`. */
  target?: EventTarget;
  /** Default `defaultInputBindings()`. */
  bindings?: InputBindings;
  /** Number of player masks `sample()` returns, default `2`. */
  players?: number;
  /** Clear opposing directions held together (see `cleanOpposingDirections`), default `true`. */
  cleanOpposing?: boolean;
  /**
   * `preventDefault()` on bound keys, default `true` — stops arrows and Space
   * scrolling the page and Alt focusing the browser menu.
   */
  preventDefault?: boolean;
  /** Injectable for tests; defaults to `navigator.getGamepads()`. `null` disables gamepads. */
  getGamepads?: (() => readonly (GamepadLike | null)[]) | null;
}

export interface InputMap {
  /**
   * Reads the current state as one mask per player — call exactly once per
   * sim step. A key pressed and released between two samples still shows up
   * as held for one sample, so a quick coin tap is never lost.
   */
  sample(): number[];
  readonly bindings: InputBindings;
  setBindings(bindings: InputBindings): void;
  /**
   * Resolves the next key pressed to its `KeyboardEvent.code` without
   * feeding it to the game — for a "press a key to bind" UI.
   */
  captureNextKey(): Promise<string>;
  dispose(): void;
}

export function createInputMap(opts: InputMapOptions = {}): InputMap {
  const target = opts.target ?? globalThis.window;
  const players = opts.players ?? 2;
  const cleanOpposing = opts.cleanOpposing ?? true;
  const preventDefault = opts.preventDefault ?? true;
  const getGamepads =
    opts.getGamepads === undefined
      ? typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
        ? () => navigator.getGamepads()
        : null
      : opts.getGamepads;

  let bindings = opts.bindings ?? defaultInputBindings();
  const held = new Set<string>();
  // Keys that went down since the last sample — sampled as held even if
  // already released, so a tap shorter than one step still registers.
  const tapped = new Set<string>();
  let capture: ((code: string) => void) | null = null;

  const onKeyDown = (e: Event): void => {
    const ev = e as KeyboardEvent;
    if (capture) {
      ev.preventDefault();
      const resolve = capture;
      capture = null;
      resolve(ev.code);
      return;
    }
    if (!(ev.code in bindings.keyboard)) return;
    if (preventDefault) ev.preventDefault();
    held.add(ev.code);
    tapped.add(ev.code);
  };
  const onKeyUp = (e: Event): void => {
    const ev = e as KeyboardEvent;
    if (preventDefault && ev.code in bindings.keyboard) ev.preventDefault();
    held.delete(ev.code);
  };
  // Keys released while the page is unfocused never send keyup.
  const onBlur = (): void => {
    held.clear();
  };

  target?.addEventListener('keydown', onKeyDown);
  target?.addEventListener('keyup', onKeyUp);
  target?.addEventListener('blur', onBlur);

  const sample = (): number[] => {
    const masks = new Array<number>(players).fill(0);
    const addKey = (code: string): void => {
      const b = bindings.keyboard[code];
      if (b && b.player < players) masks[b.player] |= ArcadeInput[b.input];
    };
    for (const code of held) addKey(code);
    for (const code of tapped) addKey(code);
    tapped.clear();

    if (getGamepads) {
      for (const pad of getGamepads()) {
        if (!pad) continue;
        const binding = bindings.gamepads[pad.index];
        if (binding) applyGamepad(masks, pad, binding);
      }
    }
    return cleanOpposing ? masks.map(cleanOpposingDirections) : masks;
  };

  return {
    sample,
    get bindings() {
      return bindings;
    },
    setBindings(next) {
      bindings = next;
      held.clear();
      tapped.clear();
    },
    captureNextKey() {
      return new Promise((resolve) => {
        capture = resolve;
      });
    },
    dispose() {
      target?.removeEventListener('keydown', onKeyDown);
      target?.removeEventListener('keyup', onKeyUp);
      target?.removeEventListener('blur', onBlur);
      held.clear();
      tapped.clear();
    },
  };
}
