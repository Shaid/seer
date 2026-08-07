/**
 * TopDownCamera — Viewport management with pan, zoom, and bounds clamping.
 *
 * Formerly named `Camera`; `@seer-project/engine-2d`'s index still exports `Camera`
 * as a backward-compatible alias for this class (see `index.ts`).
 */

import type { BaseCamera } from './BaseCamera.ts';
import type { DisplayMode } from './DisplayMode.ts';

export interface CameraState {
  /** World X coordinate of the camera center */
  x: number;
  /** World Y coordinate of the camera center */
  y: number;
  /** Current zoom level (1 = original viewport size) */
  zoom: number;
}

export interface TopDownCameraOptions {
  /**
   * When true (default), the camera enforces a minimum zoom so the world
   * always fills the viewport, and clamps x/y so the visible area never
   * shows area outside the world bounds. Set to false to let the camera
   * move/zoom freely (e.g. for a camera whose "world" isn't a fixed-size
   * map to fully cover).
   */
  clampToWorld?: boolean;
}

export class TopDownCamera implements BaseCamera {
  readonly kind: string = 'top-down';

  private _x = 0;
  private _y = 0;
  private _zoom = 1;
  private _dirty = true;

  /** World bounds (in pixels) */
  private _worldWidth: number;
  private _worldHeight: number;

  /** Viewport size (screen pixels) */
  private _viewWidth: number;
  private _viewHeight: number;

  private _displayMode: DisplayMode;
  private _clampToWorld: boolean;

  constructor(
    worldWidth: number,
    worldHeight: number,
    viewWidth: number,
    viewHeight: number,
    displayMode: DisplayMode,
    options: TopDownCameraOptions = {},
  ) {
    this._worldWidth = worldWidth;
    this._worldHeight = worldHeight;
    this._viewWidth = viewWidth;
    this._viewHeight = viewHeight;
    this._displayMode = displayMode;
    this._clampToWorld = options.clampToWorld ?? true;
  }

  get x(): number {
    return this._x;
  }
  get y(): number {
    return this._y;
  }
  get zoom(): number {
    return this._zoom;
  }
  get dirty(): boolean {
    return this._dirty;
  }

  get state(): CameraState {
    return { x: this._x, y: this._y, zoom: this._zoom };
  }

  /** Visible world area width at current zoom */
  get visibleWidth(): number {
    return this._viewWidth / this._zoom;
  }

  /** Visible world area height at current zoom */
  get visibleHeight(): number {
    return this._viewHeight / this._zoom;
  }

  /** Top-left world X of visible area */
  get left(): number {
    return this._x - this.visibleWidth / 2;
  }

  /** Top-left world Y of visible area */
  get top(): number {
    return this._y - this.visibleHeight / 2;
  }

  setViewSize(width: number, height: number) {
    this._viewWidth = width;
    this._viewHeight = height;
    this._clamp();
    this._dirty = true;
  }

  /** Update world bounds (used when switching maps) */
  setWorldBounds(width: number, height: number) {
    this._worldWidth = width;
    this._worldHeight = height;
    this._clamp();
    this._dirty = true;
  }

  /** Pan by screen-space delta */
  pan(dx: number, dy: number) {
    this._x += dx / this._zoom;
    this._y += dy / this._zoom;
    this._clamp();
    this._dirty = true;
  }

  /** Move camera center to world position */
  moveTo(x: number, y: number) {
    this._x = x;
    this._y = y;
    this._clamp();
    this._dirty = true;
  }

  /**
   * Zoom toward a screen-space point.
   * @param delta Zoom amount (positive = zoom in)
   * @param screenX Screen X of zoom anchor
   * @param screenY Screen Y of zoom anchor
   */
  zoomAt(delta: number, screenX: number, screenY: number) {
    const config = this._displayMode.config;
    const oldZoom = this._zoom;
    let newZoom = this._zoom * (1 + delta);

    // Apply display mode constraints
    newZoom = Math.max(config.minZoom, Math.min(config.maxZoom, newZoom));

    if (this._clampToWorld) {
      // Compute the effective minimum zoom that _clamp() will enforce
      // (viewport-fill minimum, which may exceed config.minZoom). If we're
      // already at or below it, clamp newZoom to it so the equality check
      // below catches the no-change case and the cursor-anchored math
      // doesn't shift position at the visual zoom-out limit.
      const effectiveMin = Math.max(
        config.minZoom,
        this._viewWidth / this._worldWidth,
        this._viewHeight / this._worldHeight,
      );
      if (delta < 0 && newZoom < effectiveMin) {
        newZoom = effectiveMin;
      }
    }

    if (newZoom === oldZoom) return;

    // Anchor zoom to cursor position
    const worldBeforeX = this._x + (screenX - this._viewWidth / 2) / oldZoom;
    const worldBeforeY = this._y + (screenY - this._viewHeight / 2) / oldZoom;

    this._zoom = newZoom;

    const worldAfterX = this._x + (screenX - this._viewWidth / 2) / newZoom;
    const worldAfterY = this._y + (screenY - this._viewHeight / 2) / newZoom;

    this._x += worldBeforeX - worldAfterX;
    this._y += worldBeforeY - worldAfterY;

    this._clamp();
    this._dirty = true;
  }

  /** Set zoom directly (for programmatic use) */
  setZoom(zoom: number) {
    const config = this._displayMode.config;
    this._zoom = Math.max(config.minZoom, Math.min(config.maxZoom, zoom));
    this._clamp();
    this._dirty = true;
  }

  /** Mark as clean after rendering */
  markClean() {
    this._dirty = false;
  }

  private _clamp() {
    if (!this._clampToWorld) return;

    // Enforce minimum zoom so the world always fills the viewport
    const minZoomX = this._viewWidth / this._worldWidth;
    const minZoomY = this._viewHeight / this._worldHeight;
    const minZoomToFill = Math.max(minZoomX, minZoomY);
    if (this._zoom < minZoomToFill) {
      this._zoom = minZoomToFill;
    }

    const halfW = this.visibleWidth / 2;
    const halfH = this.visibleHeight / 2;

    // Keep camera center such that visible area stays within world bounds
    this._x = Math.max(halfW, Math.min(this._worldWidth - halfW, this._x));
    this._y = Math.max(halfH, Math.min(this._worldHeight - halfH, this._y));
  }
}
