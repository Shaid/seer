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
import type { PieceBank } from './PieceBank.ts';
import type { IndexedSurface } from './IndexedSurface.ts';
import type { PieceDraw, Slot, SlotTableFile } from '../schema/slots.ts';
import type { DrawItem } from '../view/DrawItem.ts';

/** Named piece banks a `SlotTableFile`'s draws reference by `PieceDraw.bank`. */
export type PieceBankLookup = Record<string, PieceBank>;

/** Draw one `PieceDraw` (or `DrawItem`, which carries the same fields). */
function drawPieceDraw(surface: IndexedSurface, banks: PieceBankLookup, draw: PieceDraw, context: string): void {
  const bank = banks[draw.bank];
  if (!bank) throw new Error(`${context} references unknown bank "${draw.bank}"`);
  const rect = bank.frame(draw.frame);
  const sx = draw.srcX ?? rect.x;
  const sy = draw.srcY ?? rect.y;
  const sw = draw.srcW ?? rect.w;
  const sh = draw.srcH ?? rect.h;
  surface.blit(bank.source(), sx, sy, sw, sh, draw.destX, draw.destY, draw.mirrorX ?? false, draw.blend);
}

function drawSlot(surface: IndexedSurface, banks: PieceBankLookup, slot: Slot | null | undefined, context: string): void {
  if (!slot) return;
  for (const draw of slot.draws) drawPieceDraw(surface, banks, draw, `compositeSlotTable: ${context}`);
}

const SLOT_KEY_RE = /^(front|side):(?:-?\d+|[LR]):(\d+)$/;

interface ParsedSlotKey {
  key: string;
  kind: 'front' | 'side';
  depth: number;
}

function parseSlotKey(key: string): ParsedSlotKey | null {
  const m = SLOT_KEY_RE.exec(key);
  if (!m) return null;
  return { key, kind: m[1] as 'front' | 'side', depth: Number(m[2]) };
}

export function compositeSlotTable(surface: IndexedSurface, banks: PieceBankLookup, table: SlotTableFile): void {
  (table.staticSlots ?? []).forEach((slot, i) => drawSlot(surface, banks, slot, `staticSlots[${i}]`));

  const keys = Object.keys(table.slots);

  if (table.ordering === 'array') {
    for (const key of keys) drawSlot(surface, banks, table.slots[key], `slots.${key}`);
    return;
  }

  const parsed = keys.map((key) => {
    const p = parseSlotKey(key);
    if (!p) throw new Error(`compositeSlotTable: slot key "${key}" doesn't match "front:<lateral>:<depth>" / "side:<L|R>:<depth>" — cannot painter-sort it. Use ordering: 'array' for non-standard keys.`);
    return p;
  });

  // Nearest depth first, farthest depth last (on top); at equal depth,
  // side walls before the front-wall row. See the module doc comment for why.
  parsed.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.kind !== b.kind) return a.kind === 'side' ? -1 : 1;
    return 0;
  });

  for (const { key } of parsed) drawSlot(surface, banks, table.slots[key], `slots.${key}`);
}

/**
 * Composites `buildViewList`'s pose-specific output: draws `table.staticSlots`
 * (ceiling, floor — unconditional, pose-independent) first, then every
 * `DrawItem`, painter-sorted nearest-first/farthest-last (on top) with side
 * walls before the front-wall row at equal depth — the identical rule
 * `compositeSlotTable`'s own `'painter-back-to-front'` ordering uses, since
 * a `DrawItem` already carries its own `depth`/`kind`.
 */
export function compositeDrawList(surface: IndexedSurface, banks: PieceBankLookup, table: SlotTableFile, items: DrawItem[]): void {
  (table.staticSlots ?? []).forEach((slot, i) => drawSlot(surface, banks, slot, `staticSlots[${i}]`));

  const sorted = [...items].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.kind !== b.kind) return a.kind === 'side' ? -1 : 1;
    return 0;
  });

  sorted.forEach((item, i) => drawPieceDraw(surface, banks, item, `compositeDrawList: items[${i}] (${item.kind}:${item.lateral}:${item.depth})`));
}
