/**
 * Shared scanline polygon fill + Bresenham line rasterizer.
 *
 * Both algorithms are parameterized over a pixel-write callback
 * (`plot(x, y)`) so a caller can draw into whichever buffer shape it
 * needs — a palette-index byte array, an RGB triple buffer, RGBA, a
 * canvas API — without this module knowing anything about pixel formats.
 * Bounds clipping to `[0, width) x [0, height)` happens inside the shared
 * core (not in the callback), so every caller gets identical clipping
 * behaviour.
 *
 * Ported from Drakkhen's Atari ST vector-graphics rasteriser (spec'd from
 * `Vector.cs`'s `Draw`), which existed as two byte-for-byte-identical
 * copies of this same scanline-fill/Bresenham-line pair — one drawing
 * into a palette-index buffer for vector monsters, one into an RGB canvas
 * for the world-map renderer.
 */

export interface Edge {
  yMin: number;
  yMax: number;
  xAtMin: number;
  dx: number;
}

/**
 * Build the non-horizontal edge list for one polygon (`points`, in
 * winding order). Horizontal edges contribute nothing to a scanline fill
 * and are dropped.
 */
export function polygonEdges(points: readonly (readonly [number, number])[]): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    if (y1 === y2) continue;
    if (y1 < y2) edges.push({ yMin: y1, yMax: y2, xAtMin: x1, dx: (x2 - x1) / (y2 - y1) });
    else edges.push({ yMin: y2, yMax: y1, xAtMin: x2, dx: (x1 - x2) / (y1 - y2) });
  }
  return edges;
}

/**
 * Even-odd scanline polygon fill, clipped to `[0, width) x [0, height)`.
 * `points` are in output pixel space (floats ok, at least 3 non-collinear
 * points to produce any fill). Calls `plot(x, y)` once per filled pixel,
 * already clipped in bounds.
 */
export function scanlineFillPolygon(
  points: readonly (readonly [number, number])[],
  width: number,
  height: number,
  plot: (x: number, y: number) => void,
): void {
  const edges = polygonEdges(points);
  if (edges.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of edges) {
    if (e.yMin < minY) minY = e.yMin;
    if (e.yMax > maxY) maxY = e.yMax;
  }
  const y0 = Math.max(0, Math.ceil(minY));
  const y1 = Math.min(height - 1, Math.floor(maxY) - 1);
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (const e of edges) {
      if (y >= e.yMin && y < e.yMax) xs.push(e.xAtMin + e.dx * (y + 0.5 - e.yMin));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(width - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) plot(x, y);
    }
  }
}

/**
 * Bresenham line from `(x0,y0)` to `(x1,y1)` (endpoints rounded to
 * integer pixels), clipped to `[0, width) x [0, height)`. Calls
 * `plot(x, y)` once per pixel on the line that lands in bounds
 * (endpoints included).
 */
export function bresenhamLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  height: number,
  plot: (x: number, y: number) => void,
): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const x2 = Math.round(x1);
  const y2 = Math.round(y1);
  const dx = Math.abs(x2 - x);
  const dy = Math.abs(y2 - y);
  const sx = x < x2 ? 1 : -1;
  const sy = y < y2 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (x >= 0 && y >= 0 && x < width && y < height) plot(x, y);
    if (x === x2 && y === y2) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}
