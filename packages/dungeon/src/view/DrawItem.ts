/**
 * One resolved piece to draw for a specific pose — `buildViewList`'s output
 * element. Carries the same drawing fields as a `PieceDraw` (so a
 * compositor can draw it exactly the way `compositeSlotTable` draws a
 * `Slot`'s own `draws`) plus provenance (`kind`/`depth`/`lateral`) a debug
 * overlay or a painter's-order sort can use without re-parsing the slot key.
 */
import type { BlendMode } from '../schema/slots.ts';

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
  maskSource?: 'plane' | 'index';
  maskIndex?: number;
  priority?: number;
  hotspot?: { code: number };
  origin?: string;
}
