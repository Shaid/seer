/**
 * Mouse-pick hit-testing — M4, `walker-plan.md` "Mouse interactivity".
 * Black Crypt's own hotspots are `{x, y, w, h}` + a code byte, rewritten
 * every frame by the same handlers that draw each piece; this package
 * doesn't have that per-frame register-block table, so it hit-tests against
 * whichever `DrawItem`s in the *last-built view* carry a `hotspot`, using
 * each item's own destination rectangle as its clickable area (the frame's
 * natural bounding box — `srcW`/`srcH` if given, else the bank frame's own
 * size). That's a deliberate simplification (the doc's separate hotspot
 * register blocks were never transcribed to an exact size/position table),
 * not a re-derivation of the game's own rects.
 *
 * Picking is topmost-first — `view/order.ts`'s `topmostFirst`, the exact
 * reverse of the order `compositeDrawList` paints in, so a click lands on
 * whichever piece is actually visible on top at that pixel rather than the
 * first one in list order.
 */
import type { DrawItem } from './DrawItem.js';
import type { PieceBankLookup } from '../raster/composite.js';
import { resolveFrameName } from '../raster/anim.js';
import { topmostFirst } from './order.js';

export interface HotspotHit {
  item: DrawItem;
  hotspot: { code: number };
}

/** The destination rectangle a `DrawItem` occupies on the surface, resolving its (possibly animated) frame at `tick` to get a concrete size. */
function destRect(
  banks: PieceBankLookup,
  item: DrawItem,
  tick: number,
): { x: number; y: number; w: number; h: number } | null {
  const bank = banks[item.bank];
  if (!bank) return null;
  const cell =
    item.cellX !== undefined && item.cellY !== undefined
      ? { x: item.cellX, y: item.cellY }
      : undefined;
  const frameName = resolveFrameName(item.frame, tick, cell);
  if (!bank.hasFrame(frameName)) return null;
  const rect = bank.frame(frameName);
  return {
    x: item.destX,
    y: item.destY,
    w: item.srcW ?? rect.w,
    h: item.srcH ?? rect.h,
  };
}

/**
 * Hit-test `(surfaceX, surfaceY)` (already mapped from container space
 * through the presenter's integer scale — see `render/*Presenter.ts`)
 * against `items`' hotspots, topmost-first. Returns `null` on a miss or when
 * nothing in `items` carries a `hotspot`.
 */
export function pickHotspot(
  items: DrawItem[],
  banks: PieceBankLookup,
  tick: number,
  surfaceX: number,
  surfaceY: number,
): HotspotHit | null {
  for (const item of topmostFirst(items)) {
    if (!item.hotspot) continue;
    const rect = destRect(banks, item, tick);
    if (!rect) continue;
    if (
      surfaceX >= rect.x &&
      surfaceX < rect.x + rect.w &&
      surfaceY >= rect.y &&
      surfaceY < rect.y + rect.h
    ) {
      return { item, hotspot: item.hotspot };
    }
  }
  return null;
}
