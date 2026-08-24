/**
 * The single definition of `buildViewList`'s output painter's order —
 * **farthest depth first / nearest last**, i.e. the nearest, larger piece is
 * painted on top of the farther ones it overlaps — Black Crypt's confirmed
 * `AddRenderItem` display-list drain order (`data-structure.md` "AddRenderItem
 * and the display list": `depthKey` 0 = farthest … 11 = nearest, drained
 * non-decreasing in `depthKey`, "farthest square first, nearest last, i.e.
 * straightforward back-to-front painter's algorithm"). At equal depth: side
 * walls, then the front-wall row, then non-wall props on top (matching the
 * game's priority groups: walls `0x64` before props `0x3D`).
 *
 * > **Correction (2026-08-12):** this ordering was previously nearest-first /
 * > farthest-last, which is the *inverse* of the game — it put far walls and
 * > far floor items on top of nearer walls. Flipped to match the confirmed
 * > drain order; the M1 golden framebuffer was regenerated.
 *
 * Factored out of `raster/composite.ts` so `view/Hotspot.ts`'s topmost-first
 * picking can hit-test in *exactly* the order the compositor painted —
 * "topmost" for picking is just this same order, reversed. Both consumers
 * import one definition rather than risking two orderings drifting apart.
 */
import type { DrawItem } from './DrawItem.js';

const KIND_ORDER: Record<'side' | 'front' | 'prop', number> = { side: 0, front: 1, prop: 2 };

/** Compare two `DrawItem`s by the painter's order `compositeDrawList` draws in (farthest/background first). */
export function comparePaintOrder(a: DrawItem, b: DrawItem): number {
  if (a.depth !== b.depth) return b.depth - a.depth;
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}

/** `items`, stably sorted into the painter's order `compositeDrawList` draws them in (farthest/background first, nearest/foreground last i.e. on top). */
export function paintOrder(items: DrawItem[]): DrawItem[] {
  return [...items].sort(comparePaintOrder);
}

/** `items`, ordered topmost-first — the reverse of `paintOrder`, for hit-testing ("does the piece actually on top at this pixel carry this hotspot"). */
export function topmostFirst(items: DrawItem[]): DrawItem[] {
  return paintOrder(items).reverse();
}
