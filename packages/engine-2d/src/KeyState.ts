/**
 * KeyState — low-level held-key/one-shot-press primitive.
 *
 * `InputManager` already hardwires WASD→pan, edge-scroll, wheel-zoom, and
 * drag-to-pan against a `Camera`/`TopDownCamera`, with no public accessor
 * for "is this key currently down". `KeyState` is the camera-agnostic
 * primitive underneath that: attach it to any `EventTarget` (a canvas,
 * `window`, etc.) and query held/pressed keys directly, without depending
 * on `Camera` or `InputManager` at all — useful for first-person movement,
 * custom key bindings, or anything that isn't "pan a 2D camera".
 */

export class KeyState {
  private _down = new Set<string>();
  private _pressed = new Set<string>();
  private _target: EventTarget;

  private _onKeyDown: (e: Event) => void;
  private _onKeyUp: (e: Event) => void;

  constructor(target: HTMLElement | Window) {
    this._target = target;

    this._onKeyDown = (e: Event) => {
      const code = (e as KeyboardEvent).code;
      if (!this._down.has(code)) this._pressed.add(code);
      this._down.add(code);
    };
    this._onKeyUp = (e: Event) => {
      const code = (e as KeyboardEvent).code;
      this._down.delete(code);
    };

    this._target.addEventListener('keydown', this._onKeyDown);
    this._target.addEventListener('keyup', this._onKeyUp);
  }

  /** Is this key code currently held down? */
  isDown(code: string): boolean {
    return this._down.has(code);
  }

  /**
   * Edge-triggered, one-shot press check: true the first time it's queried
   * after the key went down, then false until the key is pressed again.
   * Clears on read.
   */
  consumePress(code: string): boolean {
    const wasPressed = this._pressed.has(code);
    this._pressed.delete(code);
    return wasPressed;
  }

  destroy(): void {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
  }
}
