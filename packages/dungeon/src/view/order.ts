/**
 * The single definition of `buildViewList`'s output painter's order — nearest
 * depth first / farthest last (so a farther, smaller piece draws on top of
 * the nearer, larger one it's nested inside — see `raster/composite.ts`'s
 * module doc comment for why), and at equal depth: side walls, then the
 * front-wall row, then non-wall props on top.
 *
 * Factored out of `raster/composite.ts` so `view/Hotspot.ts`'s topmost-first
 * picking can hit-test in *exactly* the order the compositor painted —
 * "topmost" for picking is just this same order, reversed. Both consumers
 * import one definition rather than risking two orderings drifting apart.
 */
import type { DrawItem } from './DrawItem.ts';

const KIND_ORDER: Record<'side' | 'front' | 'prop', number> = { side: 0, front: 1, prop: 2 };

/** Compare two `DrawItem`s by the painter's order `compositeDrawList` draws in (farthest/background first). */
export function comparePaintOrder(a: DrawItem, b: DrawItem): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}

/** `items`, stably sorted into the painter's order `compositeDrawList` draws them in (nearest/foreground last, i.e. on top). */
export function paintOrder(items: DrawItem[]): DrawItem[] {
  return [...items].sort(comparePaintOrder);
}

/** `items`, ordered topmost-first — the reverse of `paintOrder`, for hit-testing ("does the piece actually on top at this pixel carry this hotspot"). */
export function topmostFirst(items: DrawItem[]): DrawItem[] {
  return paintOrder(items).reverse();
}
