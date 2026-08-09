/**
 * One resolved piece to draw for a specific pose — `buildViewList`'s output
 * element. Carries the same drawing fields as a `PieceDraw` (so a
 * compositor can draw it exactly the way `compositeSlotTable` draws a
 * `Slot`'s own `draws`) plus provenance (`kind`/`depth`/`lateral`) a debug
 * overlay or a painter's-order sort can use without re-parsing the slot key.
 */
import type { BlendMode, FrameRef } from '../schema/slots.js';
import type { EntityRecord } from '../schema/level.js';

export type DrawItemKind = 'front' | 'side' | 'prop';

export interface DrawItem {
  kind: DrawItemKind;
  /** The depth this item was resolved at (0 = nearest). */
  depth: number;
  /** The lateral offset this item was resolved at (+ = party's right). */
  lateral: number;
  /** For `kind: 'side'`, which side of the corridor this piece is on. */
  side?: 'L' | 'R';
  /** For `kind: 'prop'`, which structure class this is (e.g. `'alcove'`, `'door-switch'`) — a debug/inspector convenience, not consumed by the compositor. */
  propType?: string;
  /**
   * The absolute world cell this item was resolved at (`project()`'s own
   * output) — distinct from `depth`/`lateral`, which are pose-relative and
   * change every time the party moves. `AnimRef`'s `phase: 'cell'` needs
   * this: seeding from `(depth, lateral)` would make a torch's animation
   * phase depend on which direction the party is looking at it from, which
   * is not what "revisiting reproduces identically" means. Present on
   * every item `buildViewList` emits (both wall and prop items).
   */
  cellX?: number;
  cellY?: number;
  /**
   * M4 — for a `prop` item resolved from an `EntityRecord` (alcove, plaque,
   * door-switch...), the source record and a stable identifying `handle`
   * (`FlatGridLevel`'s `"<unitId>:<y>:<x>:<slot>"`, the same key
   * `DungeonLevelFile.entities` is keyed by) a host can hold from
   * `onInteract` and later pass to a `setEntityState`-style patch call.
   * Absent for wall items and for props not sourced from a single entity.
   */
  entity?: EntityRecord;
  entityHandle?: string;

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
  maskSource?: 'plane' | 'index';
  maskIndex?: number;
  priority?: number;
  hotspot?: { code: number };
  origin?: string;
}
