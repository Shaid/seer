/**
 * Generic palette-cycling utility.
 *
 * Rotates a contiguous sub-range of an array by one step, wrapping within
 * that range only — the rest of the array is untouched. This is the classic
 * "colour cycling" animation trick used by 8/16-bit era games (VGA palette
 * rotation, Amiga copper-list palette swaps, etc.): the underlying pixel
 * indices never change, only what colour each index currently maps to.
 *
 * Deliberately generic over `T` and free of any DOM/WebGL/canvas dependency
 * — callers own how the resulting array gets uploaded to a texture, drawn to
 * a canvas, or otherwise rendered. See docs/viewer.md for how the scaffold's
 * asset viewer uses this to drive its palette colour-cycling control.
 */

/** -1 (reverse) or 1 (forward). */
export type CycleDirection = 1 | -1;

/**
 * Rotate `colors[start..end]` (inclusive) by one step in `direction`,
 * wrapping within that range. Mutates `colors` in place and returns it for
 * convenience.
 *
 * - `direction: 1` (forward) — every entry shifts toward `end`; the color
 *   at `end` wraps around to `start`.
 * - `direction: -1` (reverse) — every entry shifts toward `start`; the
 *   color at `start` wraps around to `end`.
 *
 * No-op (returns `colors` unchanged) if the range is degenerate or out of
 * bounds: `start >= end`, `start < 0`, or `end >= colors.length`.
 */
export function cyclePalette<T>(
  colors: T[],
  start: number,
  end: number,
  direction: CycleDirection = 1,
): T[] {
  if (start >= end || start < 0 || end >= colors.length) return colors;

  if (direction === 1) {
    const last = colors[end] as T;
    for (let i = end; i > start; i--) {
      colors[i] = colors[i - 1] as T;
    }
    colors[start] = last;
  } else {
    const first = colors[start] as T;
    for (let i = start; i < end; i++) {
      colors[i] = colors[i + 1] as T;
    }
    colors[end] = first;
  }

  return colors;
}
