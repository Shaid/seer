/**
 * InputManager — Unified mouse + keyboard input handling.
 */

import type { Camera } from './Camera.ts';
import { screenToWorld } from '../utils/pixi-helpers.ts';

export interface InputConfig {
  /** Pan speed in pixels/frame when using keyboard */
  panSpeed: number;
  /** Edge scroll zone width in pixels */
  edgeScrollZone: number;
  /** Edge scroll speed multiplier */
  edgeScrollSpeed: number;
  /** Zoom sensitivity (wheel delta multiplier) */
  zoomSensitivity: number;
}

const DEFAULT_CONFIG: InputConfig = {
  panSpeed: 8,
  edgeScrollZone: 32,
  edgeScrollSpeed: 6,
  zoomSensitivity: 0.15,
};

export type ClickHandler = (worldX: number, worldY: number, button: number) => void;

export class InputManager {
  private _camera: Camera;
  private _config: InputConfig;
  private _canvas: HTMLCanvasElement;

  private _keys = new Set<string>();
  private _mouseX = 0;
  private _mouseY = 0;
  private _clickHandlers: ClickHandler[] = [];
  private _keyActions = new Map<string, () => void>();

  // Drag-to-scroll state
  private _dragging = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _dragMoved = false;

  private _boundKeyDown: (e: KeyboardEvent) => void;
  private _boundKeyUp: (e: KeyboardEvent) => void;
  private _boundMouseMove: (e: MouseEvent) => void;
  private _boundWheel: (e: WheelEvent) => void;
  private _boundMouseDown: (e: MouseEvent) => void;
  private _boundMouseUp: (e: MouseEvent) => void;
  private _boundContextMenu: (e: Event) => void;

  constructor(canvas: HTMLCanvasElement, camera: Camera, config: Partial<InputConfig> = {}) {
    this._canvas = canvas;
    this._camera = camera;
    this._config = { ...DEFAULT_CONFIG, ...config };

    this._boundKeyDown = (e) => this._onKeyDown(e);
    this._boundKeyUp = (e) => this._onKeyUp(e);
    this._boundMouseMove = (e) => this._onMouseMove(e);
    this._boundWheel = (e) => this._onWheel(e);
    this._boundMouseDown = (e) => this._onMouseDown(e);
    this._boundMouseUp = (e) => this._onMouseUp(e);
    this._boundContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this._boundKeyDown);
    window.addEventListener('keyup', this._boundKeyUp);
    canvas.addEventListener('mousemove', this._boundMouseMove);
    canvas.addEventListener('wheel', this._boundWheel, { passive: false });
    canvas.addEventListener('mousedown', this._boundMouseDown);
    window.addEventListener('mouseup', this._boundMouseUp);
    canvas.addEventListener('contextmenu', this._boundContextMenu);
  }

  onClick(handler: ClickHandler) {
    this._clickHandlers.push(handler);
    return () => {
      this._clickHandlers = this._clickHandlers.filter((h) => h !== handler);
    };
  }

  /** Register a one-shot action for a key code (e.g., 'F2') */
  onKey(code: string, action: () => void) {
    this._keyActions.set(code, action);
  }

  /** Called every frame to process continuous inputs (keyboard pan, edge scroll) */
  update() {
    let dx = 0;
    let dy = 0;

    // Keyboard panning
    if (this._keys.has('ArrowLeft') || this._keys.has('KeyA')) dx -= this._config.panSpeed;
    if (this._keys.has('ArrowRight') || this._keys.has('KeyD')) dx += this._config.panSpeed;
    if (this._keys.has('ArrowUp') || this._keys.has('KeyW')) dy -= this._config.panSpeed;
    if (this._keys.has('ArrowDown') || this._keys.has('KeyS')) dy += this._config.panSpeed;

    // Edge scrolling
    const rect = this._canvas.getBoundingClientRect();
    const relX = this._mouseX - rect.left;
    const relY = this._mouseY - rect.top;
    const zone = this._config.edgeScrollZone;

    if (relX >= 0 && relX < zone) dx -= this._config.edgeScrollSpeed;
    if (relX > rect.width - zone && relX <= rect.width) dx += this._config.edgeScrollSpeed;
    if (relY >= 0 && relY < zone) dy -= this._config.edgeScrollSpeed;
    if (relY > rect.height - zone && relY <= rect.height) dy += this._config.edgeScrollSpeed;

    if (dx !== 0 || dy !== 0) {
      this._camera.pan(dx, dy);
    }
  }

  destroy() {
    window.removeEventListener('keydown', this._boundKeyDown);
    window.removeEventListener('keyup', this._boundKeyUp);
    this._canvas.removeEventListener('mousemove', this._boundMouseMove);
    this._canvas.removeEventListener('wheel', this._boundWheel);
    this._canvas.removeEventListener('mousedown', this._boundMouseDown);
    window.removeEventListener('mouseup', this._boundMouseUp);
    this._canvas.removeEventListener('contextmenu', this._boundContextMenu);
  }

  private _onKeyDown(e: KeyboardEvent) {
    this._keys.add(e.code);

    // Registered key actions
    const action = this._keyActions.get(e.code);
    if (action) {
      e.preventDefault();
      action();
    }
  }

  private _onKeyUp(e: KeyboardEvent) {
    this._keys.delete(e.code);
  }

  private _onMouseMove(e: MouseEvent) {
    const prevX = this._mouseX;
    const prevY = this._mouseY;
    this._mouseX = e.clientX;
    this._mouseY = e.clientY;

    // Drag-to-scroll
    if (this._dragging) {
      const dx = prevX - e.clientX;
      const dy = prevY - e.clientY;
      if (
        Math.abs(e.clientX - this._dragStartX) > 3 ||
        Math.abs(e.clientY - this._dragStartY) > 3
      ) {
        this._dragMoved = true;
      }
      this._camera.pan(dx, dy);
    }
  }

  private _onWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -this._config.zoomSensitivity : this._config.zoomSensitivity;
    const rect = this._canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    this._camera.zoomAt(delta, screenX, screenY);
  }

  private _onMouseDown(e: MouseEvent) {
    // Start drag on left or middle button
    if (e.button === 0 || e.button === 1) {
      this._dragging = true;
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
      this._dragMoved = false;
      this._canvas.style.cursor = 'grabbing';
    }
  }

  private _onMouseUp(e: MouseEvent) {
    if (!this._dragging) return;
    this._dragging = false;
    this._canvas.style.cursor = '';

    // Only fire click if we didn't drag
    if (!this._dragMoved && this._clickHandlers.length > 0 && (e.button === 0 || e.button === 2)) {
      const rect = this._canvas.getBoundingClientRect();
      const { x: worldX, y: worldY } = screenToWorld(
        this._camera,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      for (const handler of this._clickHandlers) {
        handler(worldX, worldY, e.button);
      }
    }
  }
}
