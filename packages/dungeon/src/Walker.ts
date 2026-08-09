/**
 * `Walker` — the M4 convenience facade `walker-plan.md`'s "Runtime" section
 * describes (`walker.pick(...)`, `walker.setEntityState(...)`): a thin
 * composition of already-independently-tested pieces (`WalkerController` for
 * input/movement, `PatchedCellQuery` for the entity-state overlay,
 * `view/Hotspot.ts` for picking, `raster/anim.ts` for the tick clock), not a
 * reimplementation of any of them. A host that wants finer-grained control
 * (its own render loop, its own dirty-tracking) can keep composing those
 * pieces directly instead — see `tools/walker/walker.ts` — `Walker` exists
 * for the common case of "just own pose + view + interaction for me."
 *
 * Owns: pose (via an internal `WalkerController`), the last-built
 * `DrawItem[]` view (rebuilt lazily on a dirty flag), an entity-state patch
 * overlay, and an animation tick clock. Does **not** own art decode, a
 * `Container`, or any door-opening policy — those stay the host's.
 */
import {
  WalkerController,
  type WalkerControllerOptions,
  type KeyStateLike,
} from './input/WalkerController.js';
import { PatchedCellQuery } from './model/PatchedCellQuery.js';
import type { EntityStatePatch } from './model/EntityState.js';
import type { CellQuery } from './model/CellQuery.js';
import type { Pose } from './model/Pose.js';
import { buildViewList } from './view/buildViewList.js';
import { viewSpecFromSlotTable, type ViewSpec } from './view/ViewSpec.js';
import { pickHotspot } from './view/Hotspot.js';
import type { DrawItem } from './view/DrawItem.js';
import { isAnimRef, animFrameChanges } from './raster/anim.js';
import type { PieceBankLookup } from './raster/composite.js';
import type { SlotTableFile } from './schema/slots.js';
import type { SemanticsFile } from './schema/semantics.js';
import type { BindingsFile } from './schema/bindings.js';
import type { EntityRecord } from './schema/level.js';

export type InteractHandler = (
  hotspot: { code: number },
  entity: EntityRecord | null,
  handle: string | null,
) => void;

export interface WalkerPickResult {
  hotspot: { code: number };
  entity: EntityRecord | null;
  handle: string | null;
}

export interface WalkerOptions extends WalkerControllerOptions {
  /**
   * Animation-clock ticks to advance per millisecond of real time passed to
   * `update()`. Default `1` (1 tick == 1 ms). Black Crypt's own tick rate
   * isn't needed for M4 — `fire-animation.json`'s `ticksPerFrame`/
   * `periodTicks` are just numbers in whatever tick unit the host's clock
   * uses; override this to match a host that ticks on a different cadence
   * (e.g. a fixed 50 Hz sim step would pass `0.05`).
   */
  ticksPerMs?: number;
}

export class Walker {
  private readonly level: PatchedCellQuery;
  private readonly controller: WalkerController;
  private readonly spec: ViewSpec;
  private readonly slots: SlotTableFile;
  private readonly semantics: SemanticsFile;
  private readonly banks: PieceBankLookup;
  private readonly ticksPerMs: number;

  private tick = 0;
  private dirty = true;
  private cachedItems: DrawItem[] = [];

  /** Set by a host to receive `pick()` hits. `null` (the default) means picking is a no-op beyond returning the hit. */
  onInteract: InteractHandler | null = null;

  constructor(
    level: CellQuery,
    slots: SlotTableFile,
    semantics: SemanticsFile,
    banks: PieceBankLookup,
    initialPose: Pose,
    bindings: BindingsFile,
    options: WalkerOptions = {},
  ) {
    this.level = new PatchedCellQuery(level);
    this.slots = slots;
    this.semantics = semantics;
    this.banks = banks;
    this.spec = viewSpecFromSlotTable(slots);
    this.ticksPerMs = options.ticksPerMs ?? 1;
    this.controller = new WalkerController(initialPose, bindings, options);
  }

  get pose(): Pose {
    return this.controller.pose;
  }

  /** The animation clock's current tick (whole real ticks elapsed since construction, per `ticksPerMs`). */
  get currentTick(): number {
    return this.tick;
  }

  /** Jump to `pose` without throttling (see `WalkerController.setPose`) and mark the view dirty. */
  setPose(pose: Pose): void {
    this.controller.setPose(pose);
    this.dirty = true;
  }

  /**
   * Advance input/movement and the animation clock by `dtMs`. Returns the
   * new `Pose` iff movement actually changed it (identical contract to
   * `WalkerController.update`) — the animation clock advancing alone never
   * shows up in this return value, only in whether `items` recomputes.
   */
  update(dtMs: number, keys: KeyStateLike): Pose | null {
    const newPose = this.controller.update(dtMs, keys);
    if (newPose) this.dirty = true;

    const prevTick = this.tick;
    this.tick += dtMs * this.ticksPerMs;
    if (!this.dirty && this.anyVisibleAnimationCrossedFrameBoundary(prevTick, this.tick))
      this.dirty = true;

    return newPose;
  }

  interactCodes(): string[] {
    return this.controller.interactCodes();
  }

  automapCodes(): string[] {
    return this.controller.automapCodes();
  }

  /**
   * The last-built `DrawItem[]` for the current pose — rebuilt lazily, only
   * when something marked the view dirty (a pose change, `setEntityState`,
   * or `update()` finding a *visible* animated piece crossed a frame
   * boundary). Never an unconditional per-call rebuild.
   */
  get items(): DrawItem[] {
    if (this.dirty) {
      this.cachedItems = buildViewList(
        this.level,
        this.pose,
        this.spec,
        this.semantics,
        this.slots,
      );
      this.dirty = false;
    }
    return this.cachedItems;
  }

  private anyVisibleAnimationCrossedFrameBoundary(prevTick: number, nextTick: number): boolean {
    for (const item of this.cachedItems) {
      if (!isAnimRef(item.frame)) continue;
      const cell =
        item.cellX !== undefined && item.cellY !== undefined
          ? { x: item.cellX, y: item.cellY }
          : undefined;
      if (animFrameChanges(item.frame, prevTick, nextTick, cell)) return true;
    }
    return false;
  }

  /**
   * Hit-test a click already mapped to *container* space (a presenter's own
   * local coordinate space — e.g. a Pixi pointer event's `getLocalPosition`,
   * or a `<canvas>` click already converted from CSS to canvas pixels) down
   * to surface pixels via `scale` (a `PixiPresenter`'s own integer `.scale`;
   * `1`, the default, for a 1:1 `CanvasPresenter`). Fires `onInteract` on a
   * hit and also returns it; `null` on a miss.
   */
  pick(containerX: number, containerY: number, scale = 1): WalkerPickResult | null {
    const surfaceX = Math.floor(containerX / scale);
    const surfaceY = Math.floor(containerY / scale);
    const hit = pickHotspot(this.items, this.banks, this.tick, surfaceX, surfaceY);
    if (!hit) return null;
    const result: WalkerPickResult = {
      hotspot: hit.hotspot,
      entity: hit.item.entity ?? null,
      handle: hit.item.entityHandle ?? null,
    };
    this.onInteract?.(result.hotspot, result.entity, result.handle);
    return result;
  }

  /**
   * Patch an entity's open/locked state and mark the view dirty for the
   * next `items` read — no "is this allowed" policy (see `EntityStatePatch`'s
   * doc comment); a host that wants to refuse opening a locked door checks
   * that itself before ever calling this.
   */
  setEntityState(handle: string, patch: EntityStatePatch): void {
    this.level.setPatch(handle, patch);
    this.dirty = true;
  }
}
