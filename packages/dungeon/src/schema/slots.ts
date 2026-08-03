/**
 * `slots.json` — where each "slot" of the first-person view (a depth ×
 * lateral position, or a static piece like the ceiling/floor) draws its
 * art from, in named piece banks. This is the file M1 hand-authors from
 * Black Crypt's fully-numeric front-wall/side-wall placement tables (see
 * `docs/blackcrypt/amiga/data-structure.md:5208-5224` and `:5377-5389`).
 */

/** How a `PieceDraw`'s source pixels combine with the destination surface. */
export type BlendMode = 'replace' | 'mask' | 'or';

export interface PieceBankRef {
  id: string;
  atlas: string;
  image: string;
  indexed?: boolean;
  palette?: string;
}

/**
 * An animated decoration — M4, `walker-plan.md` "Animated decorations".
 * `fire-animation.json` (already extracted, 15 frames/`ticksPerFrame: 4`/
 * `periodTicks: 60`) is the proven real-data shape this mirrors exactly.
 *
 * `frames` are bank frame names, selected by tick: frame index =
 * `floor((tick + phaseOffset) mod period / ticksPerFrame) mod frames.length`.
 * `periodTicks` defaults to `frames.length * ticksPerFrame` (a clean single
 * loop) when omitted — set it explicitly when the real cycle is longer than
 * one straight pass through the frames (Black Crypt's torches: 15 frames *
 * 4 ticks = 60, which *is* the period, but a game with idle-hold frames
 * would set a longer `periodTicks`).
 *
 * `phase` picks how the per-instance offset is derived:
 * - `'fixed'` (default) uses `phaseTicks` (default 0) verbatim — Black
 *   Crypt's four real torch instances each hard-code their own `phaseTicks`
 *   so four identical torches don't flicker in lockstep.
 * - `'cell'` ignores `phaseTicks` and derives the offset deterministically
 *   from the piece's own cell coordinates (`raster/anim.ts`'s `cellSeed`) —
 *   zero stored state, so revisiting a corridor reproduces the exact same
 *   animation phase every time, and two different cells generally show
 *   different phases at the same tick.
 */
export interface AnimRef {
  frames: string[];
  ticksPerFrame: number;
  periodTicks?: number;
  phase?: 'fixed' | 'cell';
  phaseTicks?: number;
}

/**
 * A per-map door-lock frame template (`docs/blackcrypt/TODO.md`'s
 * `blackcrypt-doorlock-rendering`) — door-lock's art lives in the per-map
 * `wall-decorations` bank (`m{mapId}_decor{gfxIndex}_{near|mid|far}`), so a
 * fixed atlas frame name can't name it; the frame is only known once
 * `buildViewList` has the current pose's `LevelUnit.id` and the entity's own
 * `gfxNumber` in hand. `template` is a string with `{name}` placeholders —
 * `buildViewList`'s door-lock handling is the only substitution site, using
 * `{mapId}`, `{gfxIndex}`, `{depthLabel}` (see its module doc comment).
 * Never appears on a `DrawItem` — `buildViewList` always resolves this to a
 * plain string frame name before emitting the item, since `compositeSlotTable`/
 * `compositeDrawList` have no pose/entity context to resolve it with (see
 * `raster/anim.ts`'s `resolveFrameName`, which throws if it ever receives
 * one unresolved).
 */
export interface FrameTemplate {
  template: string;
}

/**
 * `PieceDraw.frame` is a plain bank frame name in the common case. `AnimRef`
 * (above) is the animated variant, and `FrameTemplate` (above) is the
 * per-map-substitution variant — a discriminated-by-shape union
 * (`typeof frame === 'string'` vs. an object with `frames` vs. an object
 * with `template`) rather than a `kind` tag, so a plain string stays the
 * zero-ceremony common case. `raster/anim.ts`'s `isAnimRef` guard only tests
 * for `frames`, so a `FrameTemplate` object safely falls through as "not
 * animated" instead of colliding, and vice versa.
 */
export type FrameRef = string | AnimRef | FrameTemplate;

export interface PieceDraw {
  bank: string;
  frame: FrameRef;
  destX: number;
  destY: number;
  srcX?: number;
  srcY?: number;
  srcW?: number;
  srcH?: number;
  mirrorX?: boolean;
  blend: BlendMode;
  /** For `blend: 'mask'` art whose mask isn't the source's own alpha/mask plane. */
  maskSource?: 'plane' | 'index';
  maskIndex?: number;
  /** The game's own descriptor priority byte, where applicable. */
  priority?: number;
  /** Makes this piece clickable; the code is a game-defined hotspot id. */
  hotspot?: { code: number };
  /** Provenance citation, e.g. "data-structure.md:5213 Wall 0 front face". */
  origin?: string;
}

export interface Slot {
  draws: PieceDraw[];
}

/**
 * `blackcrypt-floor-item-placement` (`docs/blackcrypt/TODO.md`) — where a
 * generic dungeon-floor item (an `EntityRecord` whose type isn't one of the
 * specifically-rendered structure classes above) draws from. Unlike
 * alcove/plaque/stairs/door-switch/door-lock, position depends on a *third*
 * axis beyond `(depth, lateral)` — the item's own `gfxNumber`-derived
 * "floor-graphics group" — so it doesn't fit the fixed `prop:*` slot-key
 * shape without enumerating hundreds of `(depth, lateral, group)` combos;
 * this small arithmetic table (mirroring the game's own `+0x218FA`) is
 * cheaper and just as data-driven. All three parts are decoded/verified
 * (`scripts/export_dungeon_props.py`): `gfxToGroup` (`+0x26FDE`, 236/236),
 * `anchor` (`+0x21992`, 9/9), `registration` (`+0x27774`, 147/147).
 * Deliberately **omits** the runtime scatter table (`+0x220CC`) — it cycles
 * a persistent global counter (`$498(A5)`) the walker has no equivalent
 * runtime state for; several items dropped on the same square may render
 * stacked exactly instead of jittered, a known, documented simplification.
 */
export interface FloorItemPlacement {
  /** `bank` id for `floor{group:02d}-d{depth}` frames (`sprites/floor-items.json`). */
  bank: string;
  /** `gfxNumber` -> floor-graphics group (index = gfxNumber). `noneGroup` (or a missing/out-of-range index) means "no floor sprite for this gfxNumber". */
  gfxToGroup: number[];
  noneGroup: number;
  /** `"<depth>:<lateral>"` -> `[x, y]` anchor position. */
  anchor: Record<string, [number, number]>;
  /** `"<group>:<depth>"` -> `[x, y]` registration offset, subtracted from the anchor. */
  registration: Record<string, [number, number]>;
}

export interface SlotTableFile {
  schemaVersion: 1;
  surface: { width: number; height: number };
  viewport: { x: number; y: number; width: number; height: number };
  depthCount: number;
  lateralOffsets: number[];
  frontWallMaxDepth: number;
  banks: PieceBankRef[];
  /**
   * Keyed `"front:<lateral>:<depth>"` / `"side:<L|R>:<depth>"` (walls), or
   * `"prop:<kind>:<lateral>:<depth>"` with an optional trailing segment for
   * a class that needs one more axis (`"prop:alcove:<lateral>:<depth>:<dir>"`,
   * `"prop:stairs-a|b:<lateral>:<depth>"` — M5, `walker-plan.md`). `null`
   * means "nothing drawn here".
   */
  slots: Record<string, Slot | null>;
  /** Unconditional pieces drawn every frame regardless of pose (Black Crypt: ceiling, floor). */
  staticSlots?: Slot[];
  /**
   * Draw order for `slots`. `'painter-back-to-front'` (the default a
   * compositor should assume when this is omitted) sorts by the depth
   * embedded in each slot key, farthest first, so nearer/larger pieces
   * correctly overwrite farther/smaller ones in their overlapping edge
   * regions. `'array'` draws `Object.keys(slots)` in their JS iteration
   * (insertion) order instead.
   */
  ordering?: 'array' | 'painter-back-to-front';
  /** M5 floor-item placement — see `FloorItemPlacement`'s doc comment. Absent for a level/fixture that doesn't model floor items. */
  floorItem?: FloorItemPlacement;
}
