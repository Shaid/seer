/**
 * Composites a `SlotTableFile` into an `IndexedSurface`: draws
 * `staticSlots` (unconditional background pieces — ceiling, floor) first,
 * then every populated entry in `slots`.
 *
 * ## Draw order
 *
 * Black Crypt's own nine front-wall pieces genuinely nest in screen space
 * once every depth is populated simultaneously (as M1's hand-authored
 * `slots.json` does, to exercise every documented placement in one static
 * scene): each farther depth's face is smaller than, and centred inside,
 * the nearer depth's face (depth0 face is 176px wide at x16-192; depth1's
 * is 112px at x48-160, entirely inside depth0's; depth2's is 80px at
 * x64-144, entirely inside depth1's). The doc's own placement table only
 * proves each depth-row's own three pieces (left return + face + right
 * return) tile with zero gap/overlap — it says nothing about cross-depth
 * overlap, because in a real frame only one depth's front wall is ever
 * populated (wherever the sightline is actually blocked). With every
 * depth populated at once, the correct read is "three nested wall frames
 * closing off the corridor," matching the doc's "receding to a vanishing
 * point": each farther, smaller frame must be drawn *after* (on top of)
 * the nearer, larger one it sits inside, or the nearer frame would wrongly
 * paint over the farther one it's supposed to be framing.
 *
 * `ordering: 'painter-back-to-front'` (the default) sorts every `slots`
 * key by the depth embedded in its own key (`"front:<lateral>:<depth>"` /
 * `"side:<L|R>:<depth>"`), nearest first / farthest last; same-depth ties
 * put the side wall before the front-wall row, since a wall that blocks
 * the corridor at a given depth visually caps/overwrites that depth's
 * side-wall texture. `ordering: 'array'` instead draws `Object.keys(slots)`
 * in their JS insertion order, unsorted — for a slot table that's already
 * been authored/sorted by its producer.
 */
import type { PieceBank } from './PieceBank.js';
import type { IndexedSurface } from './IndexedSurface.js';
import type { PieceDraw, Slot, SlotTableFile } from '../schema/slots.js';
import type { DrawItem } from '../view/DrawItem.js';
import { paintOrder } from '../view/order.js';
import { resolveFrameName } from './anim.js';

/** Named piece banks a `SlotTableFile`'s draws reference by `PieceDraw.bank`. */
export type PieceBankLookup = Record<string, PieceBank>;

/**
 * Draw one `PieceDraw` (or `DrawItem`, which carries the same fields) at
 * `tick` — resolving an `AnimRef` `frame` to a concrete bank frame name
 * first (`resolveFrameName` is a no-op for the plain-string case, so
 * every existing non-animated caller is unaffected by `tick`). `cell` is
 * only meaningful for `phase: 'cell'` and is `undefined` for `staticSlots`
 * pieces (`compositeSlotTable`'s `PieceDraw`s carry no cell of their own —
 * see `DrawItem.cellX/cellY`'s doc comment).
 */
function drawPieceDraw(
  surface: IndexedSurface,
  banks: PieceBankLookup,
  draw: PieceDraw,
  context: string,
  tick: number,
  cell?: { x: number; y: number },
): void {
  const bank = banks[draw.bank];
  if (!bank) throw new Error(`${context} references unknown bank "${draw.bank}"`);
  const frameName = resolveFrameName(draw.frame, tick, cell);
  const rect = bank.frame(frameName);
  const sx = draw.srcX ?? rect.x;
  const sy = draw.srcY ?? rect.y;
  const sw = draw.srcW ?? rect.w;
  const sh = draw.srcH ?? rect.h;
  surface.blit(
    bank.source(),
    sx,
    sy,
    sw,
    sh,
    draw.destX,
    draw.destY,
    draw.mirrorX ?? false,
    draw.blend,
  );
}

function drawSlot(
  surface: IndexedSurface,
  banks: PieceBankLookup,
  slot: Slot | null | undefined,
  context: string,
  tick: number,
): void {
  if (!slot) return;
  for (const draw of slot.draws)
    drawPieceDraw(surface, banks, draw, `compositeSlotTable: ${context}`, tick);
}

// `front:<lateral>:<depth>` / `side:<L|R>:<depth>` (walls) or
// `prop:<kind>:<lateral>:<depth>(:<extra>)?` (M5 non-wall structures, e.g.
// `prop:alcove:0:1:2`, `prop:stairs-a:1:0`) — depth is always the segment
// right after the lateral/side field in both shapes.
const SLOT_KEY_RE = /^(front|side):(?:-?\d+|[LR]):(\d+)$/;
const PROP_SLOT_KEY_RE = /^prop:[^:]+:-?\d+:(\d+)(?::.+)?$/;

interface ParsedSlotKey {
  key: string;
  kind: 'front' | 'side' | 'prop';
  depth: number;
}

function parseSlotKey(key: string): ParsedSlotKey | null {
  const m = SLOT_KEY_RE.exec(key);
  if (m) return { key, kind: m[1] as 'front' | 'side', depth: Number(m[2]) };
  const p = PROP_SLOT_KEY_RE.exec(key);
  if (p) return { key, kind: 'prop', depth: Number(p[1]!) };
  return null;
}

/**
 * Same-depth draw order: side walls first, then the front-wall row, then
 * non-wall props on top (an alcove/plaque/door-switch/stairs piece is
 * always foreground detail relative to the corridor geometry it sits in).
 * This is a simple, stable total order, **not** a port of the game's own
 * priority-byte painter's sort (`priority & 0x80` etc., documented in
 * `walker-plan.md` but not yet consumed here) — see `PieceDraw.priority`
 * for the field this would use if/when that's implemented.
 */
// Kind order for the key-parsed (`SlotTableFile.slots`) sort below — kept
// local since it operates on parsed slot keys, not `DrawItem`s; see
// `view/order.ts` for the `DrawItem`-based equivalent `compositeDrawList` uses.
const KIND_ORDER: Record<'side' | 'front' | 'prop', number> = { side: 0, front: 1, prop: 2 };

export function compositeSlotTable(
  surface: IndexedSurface,
  banks: PieceBankLookup,
  table: SlotTableFile,
  tick = 0,
): void {
  (table.staticSlots ?? []).forEach((slot, i) =>
    drawSlot(surface, banks, slot, `staticSlots[${i}]`, tick),
  );

  const keys = Object.keys(table.slots);

  if (table.ordering === 'array') {
    for (const key of keys) drawSlot(surface, banks, table.slots[key], `slots.${key}`, tick);
    return;
  }

  const parsed = keys.map((key) => {
    const p = parseSlotKey(key);
    if (!p)
      throw new Error(
        `compositeSlotTable: slot key "${key}" doesn't match "front:<lateral>:<depth>" / "side:<L|R>:<depth>" — cannot painter-sort it. Use ordering: 'array' for non-standard keys.`,
      );
    return p;
  });

  // Nearest depth first, farthest depth last (on top); at equal depth,
  // side walls, then front wall, then props. See the module doc comment for why.
  parsed.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });

  for (const { key } of parsed) drawSlot(surface, banks, table.slots[key], `slots.${key}`, tick);
}

/**
 * Composites `buildViewList`'s pose-specific output: draws `table.staticSlots`
 * (ceiling, floor — unconditional, pose-independent) first, then every
 * `DrawItem` in `view/order.ts`'s shared `paintOrder` (nearest-first/
 * farthest-last, side walls before the front-wall row at equal depth).
 * `tick` (default 0, so every pre-M4 caller is unaffected) resolves any
 * `AnimRef` frames via each item's own `cellX`/`cellY` for `phase: 'cell'`.
 */
export function compositeDrawList(
  surface: IndexedSurface,
  banks: PieceBankLookup,
  table: SlotTableFile,
  items: DrawItem[],
  tick = 0,
): void {
  (table.staticSlots ?? []).forEach((slot, i) =>
    drawSlot(surface, banks, slot, `staticSlots[${i}]`, tick),
  );

  const sorted = paintOrder(items);

  sorted.forEach((item, i) => {
    const cell =
      item.cellX !== undefined && item.cellY !== undefined
        ? { x: item.cellX, y: item.cellY }
        : undefined;
    drawPieceDraw(
      surface,
      banks,
      item,
      `compositeDrawList: items[${i}] (${item.kind}:${item.lateral}:${item.depth})`,
      tick,
      cell,
    );
  });
}
