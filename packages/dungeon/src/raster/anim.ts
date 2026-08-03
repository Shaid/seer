/**
 * Resolves an `AnimRef` (`schema/slots.ts`) to a concrete bank frame name for
 * a given tick — the runtime half of M4's "animated decorations"
 * (`walker-plan.md`). Pure and DOM-free like the rest of `raster/`: no
 * dependency on `PieceBank` or a compositor, so it's independently
 * unit-testable and reusable from both `compositeSlotTable`/
 * `compositeDrawList` and `view/Hotspot.ts`'s picking (which must resolve
 * the *currently displayed* frame to size its hit-rect correctly).
 */
import type { AnimRef, FrameRef, FrameTemplate } from '../schema/slots.ts';

/** Structural guard: an `AnimRef` is any non-string frame with a `frames` array — see `FrameRef`'s doc comment for why this is shape-based, not tag-based. */
export function isAnimRef(frame: FrameRef): frame is AnimRef {
  return typeof frame === 'object' && frame !== null && Array.isArray((frame as AnimRef).frames);
}

/** Structural guard: a `FrameTemplate` is any non-string frame with a `template` string — see `FrameRef`'s doc comment. */
export function isFrameTemplate(frame: FrameRef): frame is FrameTemplate {
  return typeof frame === 'object' && frame !== null && typeof (frame as FrameTemplate).template === 'string';
}

/**
 * Deterministic per-cell seed for `phase: 'cell'` — zero stored state, same
 * `(x, y)` always yields the same seed, and distinct cells generally yield
 * distinct seeds (a standard integer bit-mix, not cryptographic — this only
 * needs to *look* uncorrelated across adjacent cells, not resist attack).
 */
export function cellSeed(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x2545f491)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

function positiveMod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** The `anim.frames` index selected at `tick`, given an optional cell for `phase: 'cell'`. */
export function animFrameIndex(anim: AnimRef, tick: number, cell?: { x: number; y: number }): number {
  const period = anim.periodTicks ?? anim.frames.length * anim.ticksPerFrame;
  const phaseOffset = anim.phase === 'cell' ? cellSeed(cell?.x ?? 0, cell?.y ?? 0) % period : (anim.phaseTicks ?? 0);
  const t = positiveMod(tick + phaseOffset, period);
  return Math.floor(t / anim.ticksPerFrame) % anim.frames.length;
}

/**
 * The bank frame name selected at `tick` — the compositor's/picker's single
 * entry point, handling both plain strings and `AnimRef`s. A `FrameTemplate`
 * reaching here is a bug, not a runtime condition to handle gracefully:
 * `buildViewList` must resolve every `FrameTemplate` (door-lock's `{mapId}`/
 * `{gfxIndex}`/`{depthLabel}`) to a plain string before emitting a `DrawItem`,
 * since neither the compositor nor this function has the pose/entity
 * context a template needs — see `FrameRef`'s doc comment.
 */
export function resolveFrameName(frame: FrameRef, tick: number, cell?: { x: number; y: number }): string {
  if (isFrameTemplate(frame)) {
    throw new Error(`resolveFrameName: unresolved frame template "${frame.template}" — buildViewList must substitute this before the item reaches the compositor`);
  }
  if (!isAnimRef(frame)) return frame;
  return frame.frames[animFrameIndex(frame, tick, cell)]!;
}

/**
 * Whether crossing from `prevTick` to `nextTick` changes `anim`'s selected
 * frame for `cell` — the M4 "dirty flag driven by the tick, not an
 * unconditional 60Hz redraw loop" requirement. A host holding several
 * animated pieces only needs to recomposite when at least one of them
 * reports `true` here.
 */
export function animFrameChanges(anim: AnimRef, prevTick: number, nextTick: number, cell?: { x: number; y: number }): boolean {
  return animFrameIndex(anim, prevTick, cell) !== animFrameIndex(anim, nextTick, cell);
}
