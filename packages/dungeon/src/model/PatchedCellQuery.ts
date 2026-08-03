/**
 * A `CellQuery` decorator holding an in-memory overlay of entity-state
 * patches (M4's `setEntityState`) — geometry (`inBounds`/`wallAt`/`planeAt`)
 * passes straight through to the wrapped level unchanged; `entitiesAt`/
 * `entityHandlesAt` apply each entity's stored patch (if any) to its
 * `flags` word before handing the record back, so `buildViewList` — which
 * only ever reads through `CellQuery` — sees the patched state without
 * knowing patches exist. This is exactly the "decorator, not a special
 * case" shape `AutomapState`/`CellQuery` already use for fog-of-war.
 *
 * No policy lives here (per the walker plan: opening a locked door is a
 * host decision) — `setPatch` applies whatever the host hands it,
 * unconditionally.
 */
import type { CellQuery } from './CellQuery.ts';
import type { Dir4 } from './Pose.ts';
import type { EntityRecord } from '../schema/level.ts';
import { applyEntityStatePatch, type EntityStatePatch } from './EntityState.ts';

export class PatchedCellQuery implements CellQuery {
  private readonly base: CellQuery;
  private readonly patches = new Map<string, EntityStatePatch>();

  constructor(base: CellQuery) {
    this.base = base;
  }

  inBounds(x: number, y: number): boolean {
    return this.base.inBounds(x, y);
  }

  wallAt(x: number, y: number, dir: Dir4): boolean {
    return this.base.wallAt(x, y, dir);
  }

  planeAt(name: string, x: number, y: number): number {
    return this.base.planeAt(name, x, y);
  }

  private applyPatch(handle: string, entity: EntityRecord): EntityRecord {
    const patch = this.patches.get(handle);
    if (!patch) return entity;
    return { ...entity, flags: applyEntityStatePatch(entity.flags ?? 0, patch) };
  }

  entityHandlesAt(x: number, y: number): Array<{ handle: string; entity: EntityRecord }> {
    if (this.base.entityHandlesAt) {
      return this.base.entityHandlesAt(x, y).map(({ handle, entity }) => ({ handle, entity: this.applyPatch(handle, entity) }));
    }
    // No handle-capable base (e.g. a geometry-only test `CellQuery`) —
    // synthesize a per-call, position-scoped handle rather than silently
    // dropping these entities: a caller (`buildViewList`) that only checks
    // "does this `CellQuery` have `entityHandlesAt`" must still see every
    // entity `entitiesAt` would have returned. This handle is stable across
    // repeated calls at the same `(x, y)` (same array order each time) but
    // is not a durable cross-session identity like `FlatGridLevel`'s.
    return this.base.entitiesAt(x, y).map((entity, i) => ({ handle: `unpatchable:${x}:${y}:${i}`, entity: this.applyPatch(`unpatchable:${x}:${y}:${i}`, entity) }));
  }

  entitiesAt(x: number, y: number): EntityRecord[] {
    return this.entityHandlesAt(x, y).map((e) => e.entity);
  }

  /** Merge `patch` onto whatever's already stored for `handle` (unset fields keep their previous value) and mark this overlay's held state dirty for the caller to notice (return value: the merged patch, so a caller doesn't have to re-read it). */
  setPatch(handle: string, patch: EntityStatePatch): EntityStatePatch {
    const merged = { ...this.patches.get(handle), ...patch };
    this.patches.set(handle, merged);
    return merged;
  }

  getPatch(handle: string): EntityStatePatch | undefined {
    return this.patches.get(handle);
  }

  clearPatch(handle: string): void {
    this.patches.delete(handle);
  }
}
