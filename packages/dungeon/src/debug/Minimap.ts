/**
 * A small top-down debug view: wall layout near the party, plus a view-cone
 * overlay showing current position + facing. Plain canvas 2D — no atlas, no
 * palette, no `IndexedSurface`; this is a debug aid (per the walker plan's
 * `debug/` directory), not game art, so the simplest thing that visually
 * confirms "where am I, which way am I facing, what's around me" is the
 * right amount of engineering.
 *
 * North is drawn up: since `Pose`'s `y` increases northward (confirmed
 * Black Crypt convention, `model/Direction.ts`), a cell's screen row
 * decreases as `y` increases.
 */
import type { CellQuery } from '../model/CellQuery.js';
import type { Pose, Dir4 } from '../model/Pose.js';

export interface MinimapOptions {
  /** Pixel size of one cell. Default 8. */
  cellPx?: number;
  /** Cells shown in each direction from the party. Default 6 (a 13x13 window). */
  radius?: number;
  wallColor?: string;
  floorColor?: string;
  bgColor?: string;
  coneColor?: string;
  partyColor?: string;
}

const DEFAULTS: Required<MinimapOptions> = {
  cellPx: 8,
  radius: 6,
  wallColor: '#7a8aa0',
  floorColor: '#20242c',
  bgColor: '#111318',
  coneColor: '#3fa7ff',
  partyColor: '#ffffff',
};

/** Screen-space unit vector for each facing, with north (0) pointing up (-row). */
const FACING_SCREEN_VECTOR: Record<Dir4, { dx: number; dy: number }> = {
  0: { dx: 0, dy: -1 }, // N -> up
  1: { dx: 1, dy: 0 }, // E -> right
  2: { dx: 0, dy: 1 }, // S -> down
  3: { dx: -1, dy: 0 }, // W -> left
};

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly options: Required<MinimapOptions>;

  constructor(ctx: CanvasRenderingContext2D, options: MinimapOptions = {}) {
    this.ctx = ctx;
    this.options = { ...DEFAULTS, ...options };
  }

  /** Redraws the minimap centred on `pose` within `level`. Resizes the backing canvas to fit. */
  render(level: CellQuery, pose: Pose): void {
    const { cellPx, radius, wallColor, floorColor, bgColor, coneColor, partyColor } = this.options;
    const span = radius * 2 + 1;
    const size = span * cellPx;
    const ctx = this.ctx;

    ctx.canvas.width = size;
    ctx.canvas.height = size;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size, size);
    ctx.lineWidth = Math.max(1, Math.round(cellPx / 4));
    ctx.strokeStyle = wallColor;
    ctx.fillStyle = floorColor;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = pose.x + dx;
        const y = pose.y + dy;
        if (!level.inBounds(x, y)) continue;

        const col = dx + radius;
        const row = radius - dy; // north (larger y) draws toward row 0
        const px = col * cellPx;
        const py = row * cellPx;

        ctx.fillStyle = floorColor;
        ctx.fillRect(px, py, cellPx, cellPx);

        ctx.strokeStyle = wallColor;
        ctx.beginPath();
        if (level.wallAt(x, y, 0)) {
          ctx.moveTo(px, py);
          ctx.lineTo(px + cellPx, py);
        }
        if (level.wallAt(x, y, 1)) {
          ctx.moveTo(px + cellPx, py);
          ctx.lineTo(px + cellPx, py + cellPx);
        }
        if (level.wallAt(x, y, 2)) {
          ctx.moveTo(px, py + cellPx);
          ctx.lineTo(px + cellPx, py + cellPx);
        }
        if (level.wallAt(x, y, 3)) {
          ctx.moveTo(px, py);
          ctx.lineTo(px, py + cellPx);
        }
        ctx.stroke();
      }
    }

    // View cone: a triangle from the party's cell centre, pointing toward `pose.facing`.
    const cx = radius * cellPx + cellPx / 2;
    const cy = radius * cellPx + cellPx / 2;
    const v = FACING_SCREEN_VECTOR[pose.facing];
    const perp = { dx: -v.dy, dy: v.dx };
    const len = cellPx * radius * 0.9;
    const spread = cellPx * 0.8;

    ctx.fillStyle = coneColor;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + v.dx * len - perp.dx * spread, cy + v.dy * len - perp.dy * spread);
    ctx.lineTo(cx + v.dx * len + perp.dx * spread, cy + v.dy * len + perp.dy * spread);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = partyColor;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, cellPx / 3), 0, Math.PI * 2);
    ctx.fill();
  }
}
