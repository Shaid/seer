/**
 * Shared PixiJS rendering helpers.
 *
 * Generic viewport/atlas/label utilities with no game-specific logic —
 * reusable for any PixiJS-based 2D renderer regardless of what's being
 * reverse-engineered. If you're not using PixiJS, this file doesn't apply;
 * write equivalents for your renderer of choice.
 */

import { Graphics, TextStyle, Texture, Rectangle } from 'pixi.js';
import type { TextStyleFontWeight } from 'pixi.js';
import type { Camera } from './Camera.ts';

const VIEWPORT_CULL_MARGIN = 32;

/** Compute a UI scale factor based on viewport width (reference: 1280px). */
export function computeUIScale(): number {
  const baseWidth = 1280;
  return Math.max(1, Math.min(2.5, window.innerWidth / baseWidth));
}

/** Compute viewport bounds with a culling margin. */
export function computeViewportBounds(camera: Camera, margin = VIEWPORT_CULL_MARGIN) {
  return {
    left: camera.left - margin,
    top: camera.top - margin,
    right: camera.left + camera.visibleWidth + margin,
    bottom: camera.top + camera.visibleHeight + margin,
  };
}

/** Options for creating a label TextStyle. */
export interface LabelStyleOptions {
  fontSize: number;
  fill: number;
  fontWeight?: TextStyleFontWeight;
  strokeWidth?: number;
}

/** Create a PixiJS TextStyle for world-space labels with a standard font and stroke. */
export function makeLabelStyle(options: LabelStyleOptions): TextStyle {
  const scale = computeUIScale();
  return new TextStyle({
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: Math.round(options.fontSize * scale),
    ...(options.fontWeight ? { fontWeight: options.fontWeight } : {}),
    fill: options.fill,
    stroke: { color: 0x000000, width: Math.round((options.strokeWidth ?? 2.5) * scale) },
  });
}

/** Create a diamond/rhombus marker Graphics shape. */
export function createDiamondMarker(
  radius: number,
  color: number,
  alpha: number,
  strokeColor = 0x000000,
  strokeWidth = 1,
): Graphics {
  const g = new Graphics();
  g.moveTo(0, -radius);
  g.lineTo(radius, 0);
  g.lineTo(0, radius);
  g.lineTo(-radius, 0);
  g.closePath();
  g.fill({ color, alpha });
  g.stroke({ color: strokeColor, width: strokeWidth });
  return g;
}

/**
 * Slice a texture atlas into a grid of sub-textures.
 * Returns a flat array ordered left-to-right, top-to-bottom.
 */
export function sliceAtlas(
  atlas: Texture,
  cellWidth: number,
  cellHeight: number,
  columns: number,
  rows: number,
): Texture[] {
  const textures: Texture[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const frame = new Rectangle(col * cellWidth, row * cellHeight, cellWidth, cellHeight);
      textures.push(new Texture({ source: atlas.source, frame }));
    }
  }
  return textures;
}

/**
 * Slice a texture atlas into a keyed map (row_col format).
 * Useful when you need O(1) lookup by grid position.
 */
export function sliceAtlasKeyed(
  atlas: Texture,
  cellWidth: number,
  cellHeight: number,
  columns: number,
  rows: number,
): Map<string, Texture> {
  const map = new Map<string, Texture>();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const key = `${row}_${col}`;
      const frame = new Rectangle(col * cellWidth, row * cellHeight, cellWidth, cellHeight);
      map.set(key, new Texture({ source: atlas.source, frame }));
    }
  }
  return map;
}

/**
 * Convert screen coordinates (relative to the canvas top-left) to world
 * coordinates using the current camera.
 */
export function screenToWorld(
  camera: Camera,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: camera.left + screenX / camera.zoom,
    y: camera.top + screenY / camera.zoom,
  };
}

/** Find the nearest item within a hit radius using Euclidean distance. */
export function findNearestByWorldCoord<T>(
  items: T[],
  worldX: number,
  worldY: number,
  hitRadius: number,
  getPos: (item: T) => { x: number; y: number },
): { item: T; dist: number } | null {
  let closest: { item: T; dist: number } | null = null;
  for (const item of items) {
    const pos = getPos(item);
    const dx = pos.x - worldX;
    const dy = pos.y - worldY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= hitRadius && (!closest || dist < closest.dist)) {
      closest = { item, dist };
    }
  }
  return closest;
}
