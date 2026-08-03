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

export interface PieceDraw {
  bank: string;
  frame: string;
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
}
