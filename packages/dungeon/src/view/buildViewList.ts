/**
 * The pure view-geometry walker: given a level, a pose, and where art comes
 * from, produce the list of pieces a compositor should draw. No DOM, no
 * PixiJS — this is "the layer middilgard never had and never tested"
 * (`walker-plan.md`).
 *
 * Reproduces Black Crypt's own `DrawViewport` Phase-1 sight-line walk
 * (`data-structure.md`, "3D Viewport Compositing" -> "Phase 1"): visits
 * `depth` 0..`spec.depthCount-1`, and at each depth every offset in
 * `spec.lateralOffsets` (Black Crypt: `[0, 1, -1]`, centre-first — order
 * doesn't matter for this pure list-building pass, only for a later
 * painter's sort). For each visited cell:
 *
 * - a **front-wall** piece is emitted only for `depth < spec.frontWallMaxDepth`
 *   (the `CMPI.W #3,D2 / BGE` gate) and only when that cell actually has a
 *   wall on its edge facing the pose's own facing;
 * - a **side-wall** piece (both left and right, independently) is emitted
 *   only at `lateral === 0` (the `TST.W D3 / BNE` gate — side walls are only
 *   ever drawn for the centre column) and only when that edge has a wall.
 *
 * Both gates and the wall-bit directions (front = `pose.facing`, left =
 * `leftOf(pose.facing)`, right = `rightOf(pose.facing)`) are the confirmed
 * facts from "3D Viewport Compositing" -> "Verification" and "Party
 * Movement" -> "Facing encoding" — not re-derived here, just applied.
 *
 * A missing slot table entry (`slots.slots[key]` is `null`/absent) is not an
 * error — it just means this milestone's `slots.json` doesn't cover that
 * placement yet (e.g. a prop-carrying square with no wall descriptor). This
 * function only ever looks up the 9 front-wall / 8 side-wall keys the M1
 * slot table already proves exist (`frontWallMaxDepth * lateralOffsets.length`
 * / `depthCount * 2`), so a well-formed `spec` can never reference a key
 * outside that already-verified range. The M5 `prop:*` keys (below) are
 * looked up the same defensive way — a level with no `entityHandlePlane`
 * (or a fixture trimmed to wall geometry only) simply never calls
 * `entitiesAt`, so this stays a no-op for anyone not opted in.
 *
 * ## M5 — non-wall structure props
 *
 * `docs/blackcrypt/amiga/data-structure.md` "M5 — prop placement tables"
 * confirms four of the seven non-wall structure classes render from static,
 * view-geometry-keyed slots exactly like the walls do (the actual pixels
 * never depend on *which* structure record it is, only on `(depth, lateral,
 * ...)`) — `alcove`, `plaque`, `stairs` and `door-switch` below. The other
 * three (`door-lock`, `floor-plate/trap`, `floor-item`) have their placement
 * tables decoded and verified in `scripts/export_dungeon_props.py` /
 * `dungeon/props.json` but are **not yet wired here** — door-lock's art is
 * per-map (needs a template resolved against the pose's own level unit,
 * not just a static atlas frame), floor-plate's art source is a still-
 * unidentified graphics-kernel slot, and floor-item placement needs the
 * entity's own `gfxNumber` threaded through a 3-table anchor/registration/
 * scatter chain. See `docs/blackcrypt/TODO.md`.
 *
 * Gating, all re-derived from disassembly this pass (not guessed):
 *
 * - **Alcove** (`type 0x16`) / **Plaque** (`type 0x20`/`0x21`): only on a
 *   single-wall square (`wallMask`'s high nibble has exactly one bit set —
 *   Black Crypt's own N/E/S/W convention, bit 0=N..3=W once shifted down 4),
 *   `depth < frontWallMaxDepth`. Party-relative `dir = (wallDir - facing -
 *   1) & 3` (`+0x02806`'s own formula).
 * - **Stairs** (`type 0x12`, sub-kind word at raw offset `0x10` — `2` =
 *   flight A/Up, `3` = flight B/Down; `0`/`1`/`4` render nothing or are
 *   procedural, out of scope here): free-standing, `depth < 3`.
 * - **Door switch** (`type 0x0F`, drawn as the Pull Chain): wall-mounted on
 *   an opposite-wall-pair square, but the confirmed engine off-by-one
 *   (`data-structure.md` "Kind 3 and the left-wall position tables") means
 *   only the wall on the party's own **right** is ever drawn — tested here
 *   as "does raw byte `0x07`'s bit for `rightOf(facing)` (via `wall =
 *   rightOf(facing)`, `bit = (wall+1)&3`) come up set", not via `wallMask`.
 */
import type { CellQuery } from '../model/CellQuery.ts';
import type { Pose } from '../model/Pose.ts';
import { leftOf, rightOf, project } from '../model/Direction.ts';
import type { Dir4 } from '../model/Pose.ts';
import type { ViewSpec } from './ViewSpec.ts';
import type { SemanticsFile } from '../schema/semantics.ts';
import type { SlotTableFile } from '../schema/slots.ts';
import type { EntityRecord } from '../schema/level.ts';
import type { DrawItem, DrawItemKind } from './DrawItem.ts';

function pushSlot(
  items: DrawItem[],
  slots: SlotTableFile,
  key: string,
  kind: DrawItemKind,
  depth: number,
  lateral: number,
  side?: 'L' | 'R',
  propType?: string,
): void {
  const slot = slots.slots[key];
  if (!slot) return;
  for (const draw of slot.draws) {
    items.push({ ...draw, kind, depth, lateral, side, propType });
  }
}

/**
 * Party-relative direction of a single-wall square's wall, or `null` if
 * `wallMaskByte`'s high nibble doesn't have exactly one bit set (corner,
 * open, or opposite-pair squares don't use this — see the module doc
 * comment). `wallMaskByte` is `EntityRecord.wallMask` (the exporter's own
 * `raw[4]`), whose high nibble is the *square's* N/E/S/W wall bitmask
 * (`data-structure.md` "The Phase-1 object switch" finding), bit 0=N..3=W.
 */
function singleWallDir(wallMaskByte: number | undefined, facing: Dir4): number | null {
  if (wallMaskByte === undefined) return null;
  const nibble = (wallMaskByte >> 4) & 0xf;
  let wallDir = -1;
  let count = 0;
  for (let i = 0; i < 4; i++) {
    if ((nibble >> i) & 1) {
      wallDir = i;
      count++;
    }
  }
  if (count !== 1) return null;
  return (((wallDir - facing - 1) % 4) + 4) % 4;
}

/**
 * Whether a door-lock/door-switch entity's `raw[0x07]` bitmask carries a
 * decoration on the wall to the party's `rightOf(facing)` — the only wall
 * the confirmed off-by-one ever actually draws.
 */
function decoratesRightWall(raw: number[] | undefined, facing: Dir4): boolean {
  if (!raw || raw.length <= 0x07) return false;
  const bits = raw[0x07] ?? 0;
  const wall = rightOf(facing);
  const bitIndex = (wall + 1) & 3;
  return ((bits >> bitIndex) & 1) !== 0;
}

/** `EntityRecord.raw[0x10:0x12]` as a big-endian word — the stairs sub-kind
 * (`2` = flight A/Up, `3` = flight B/Down), not modelled as a typed field
 * since it's specific to one structure type. */
function stairsFlight(entity: EntityRecord): 'a' | 'b' | null {
  const raw = entity.raw;
  if (!raw || raw.length < 0x12) return null;
  const subKind = ((raw[0x10] ?? 0) << 8) | (raw[0x11] ?? 0);
  if (subKind === 2) return 'a';
  if (subKind === 3) return 'b';
  return null;
}

function pushProps(
  items: DrawItem[],
  slots: SlotTableFile,
  entities: EntityRecord[],
  facing: Dir4,
  depth: number,
  lateral: number,
  frontWallMaxDepth: number,
): void {
  for (const entity of entities) {
    if (entity.type === 0x16 || entity.type === 0x20 || entity.type === 0x21) {
      if (depth >= frontWallMaxDepth) continue;
      const dir = singleWallDir(entity.wallMask, facing);
      if (dir === null) continue;
      const kind = entity.type === 0x16 ? 'alcove' : 'plaque';
      pushSlot(items, slots, `prop:${kind}:${lateral}:${depth}:${dir}`, 'prop', depth, lateral, undefined, kind);
    } else if (entity.type === 0x12) {
      if (depth >= 3) continue;
      const flight = stairsFlight(entity);
      if (flight === null) continue;
      pushSlot(items, slots, `prop:stairs-${flight}:${lateral}:${depth}`, 'prop', depth, lateral, undefined, 'stairs');
    } else if (entity.type === 0x0f) {
      if (depth >= 3) continue;
      if (!decoratesRightWall(entity.raw, facing)) continue;
      pushSlot(items, slots, `prop:door-switch:${lateral}:${depth}`, 'prop', depth, lateral, undefined, 'door-switch');
    }
  }
}

/**
 * `semantics` is accepted per the walker plan's documented signature (a
 * future milestone's piece-kind/behaviour lookups need it) but not yet
 * consulted here — Black Crypt's plain wall geometry needs only the wall
 * bits themselves, nothing from `semantics.walls`/`features` (see
 * `docs/porting-guide.md`'s eventual write-up of this). Kept as an explicit
 * parameter now rather than added later so the signature doesn't change
 * shape out from under existing callers.
 */
export function buildViewList(
  level: CellQuery,
  pose: Pose,
  spec: ViewSpec,
  _semantics: SemanticsFile,
  slots: SlotTableFile,
): DrawItem[] {
  const items: DrawItem[] = [];

  for (let depth = 0; depth < spec.depthCount; depth++) {
    for (const lateral of spec.lateralOffsets) {
      const { x, y } = project(pose.x, pose.y, pose.facing, depth, lateral);
      if (!level.inBounds(x, y)) continue;

      if (depth < spec.frontWallMaxDepth && level.wallAt(x, y, pose.facing)) {
        pushSlot(items, slots, `front:${lateral}:${depth}`, 'front', depth, lateral);
      }

      if (lateral === 0) {
        if (level.wallAt(x, y, leftOf(pose.facing))) {
          pushSlot(items, slots, `side:L:${depth}`, 'side', depth, lateral, 'L');
        }
        if (level.wallAt(x, y, rightOf(pose.facing))) {
          pushSlot(items, slots, `side:R:${depth}`, 'side', depth, lateral, 'R');
        }
      }

      const entities = level.entitiesAt(x, y);
      if (entities.length > 0) {
        pushProps(items, slots, entities, pose.facing, depth, lateral, spec.frontWallMaxDepth);
      }
    }
  }

  return items;
}
