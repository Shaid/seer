/**
 * PointerState — low-level pointer position/buttons/one-shot-click primitive.
 *
 * Companion to `KeyState`: a camera- and `InputManager`-agnostic primitive
 * for tracking pointer position, held mouse buttons, and one-shot clicks,
 * for use cases that aren't "drag/wheel-zoom a 2D camera".
 */

export class PointerState {
  private _x = 0;
  private _y = 0;
  private _buttons = 0;
  private _pendingClick: { x: number; y: number } | null = null;
  private _target: HTMLElement;

  private _onMove: (e: Event) => void;
  private _onDown: (e: Event) => void;
  private _onUp: (e: Event) => void;

  constructor(target: HTMLElement) {
    this._target = target;

    this._onMove = (e: Event) => {
      const me = e as MouseEvent;
      this._x = me.clientX;
      this._y = me.clientY;
      this._buttons = me.buttons ?? this._buttons;
    };
    this._onDown = (e: Event) => {
      const me = e as MouseEvent;
      this._x = me.clientX;
      this._y = me.clientY;
      this._buttons = me.buttons ?? this._buttons;
    };
    this._onUp = (e: Event) => {
      const me = e as MouseEvent;
      this._x = me.clientX;
      this._y = me.clientY;
      this._buttons = me.buttons ?? 0;
      this._pendingClick = { x: this._x, y: this._y };
    };

    this._target.addEventListener('mousemove', this._onMove);
    this._target.addEventListener('mousedown', this._onDown);
    this._target.addEventListener('mouseup', this._onUp);
  }

  /** Current pointer position, in the coordinate space of the events received (typically client coords). */
  get position(): { x: number; y: number } {
    return { x: this._x, y: this._y };
  }

  /** Bitmask of currently held mouse buttons (same encoding as `MouseEvent.buttons`). */
  get buttons(): number {
    return this._buttons;
  }

  /**
   * One-shot click check: returns the pointer position at the most recent
   * mouseup, or null if there's been none since the last read. Clears on
   * read.
   */
  consumeClick(): { x: number; y: number } | null {
    const click = this._pendingClick;
    this._pendingClick = null;
    return click;
  }

  destroy(): void {
    this._target.removeEventListener('mousemove', this._onMove);
    this._target.removeEventListener('mousedown', this._onDown);
    this._target.removeEventListener('mouseup', this._onUp);
  }
}
