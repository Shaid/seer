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
 * confirms all seven non-wall structure classes render either from
 * static, view-geometry-keyed slots exactly like the walls do (`alcove`,
 * `plaque`, `stairs`, `door-switch`, `door-lock` — the pixels never depend
 * on *which* structure record it is, only on `(depth, lateral, ...)`), or
 * (floor-item and floor-plate, below) from small arithmetic tables keyed
 * additionally by the entity itself. Floor-plate's art source was the last
 * unresolved gap (`blackcrypt-floorplate-art-source`) and is now confirmed:
 * graphics-kernel slot `$00` is `bcdfa`'s UI panel bank
 * (`sprites/ui-panel.json`, frames `pressure_plate_{1,2}_{up,down}`).
 *
 * > **Documented renderer simplification (pre-existing, applies to every
 * > non-tileset prop bank):** the plate/floor-item/door-lock atlases are
 * > loaded via `PieceBank.fromRGBA`, whose *local* per-atlas palette
 * > indices diverge from the tileset's indexed (EHB) index space — the
 * > single-palette presenter (`tools/walker` presents the mixed surface
 * > with the tileset ramp palette) therefore maps these banks' exact
 * > colours through the wrong entries. Frame selection, mask, geometry and
 * > placement are exact; the prop banks' precise colours are not, until the
 * > banks are re-exported as indexed atlases sharing the tileset's EHB
 * > palette (a renderer task, tracked with the other walker-side gaps).
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
 * - **Door lock** (`type 0x22`): same wall-mounted/right-only gating as door
 *   switch (`docs/blackcrypt/amiga/data-structure.md` "Kind 3..." names both
 *   `0x22` and `0x0F` as affected), but its art is per-map — `sprites/
 *   wall-decorations.json`'s frames are named `m{mapId}_decor{gfxIndex}_
 *   {near|mid|far}` (`scripts/extract_bcdfbn_decor.py`). `slots.json`'s
 *   `prop:door-lock:<lateral>:<depth>` entries carry a `FrameTemplate`
 *   (`schema/slots.ts`) instead of a literal frame; `resolveDoorLockFrame`
 *   below substitutes `{mapId}` from `pose.level`, `{gfxIndex}` from the
 *   entity's own `gfxNumber` (`EntityRecord.gfx`, `0x51`/`0x52`/`0x53` →
 *   `0`/`1`/`2` — `scripts/export_dungeon_props.py`'s `read_door_lock`) and
 *   `{depthLabel}` from the geometric depth (`0`/`1`/`2` → `near`/`mid`/
 *   `far`, the same fixed mapping `read_door_lock` uses) — all three are
 *   known at `buildViewList` time, so the template is always fully resolved
 *   before the item is emitted (never reaches the compositor unresolved).
 * - **Floor item** (`blackcrypt-floor-item-placement`) — everything else
 *   that isn't a monster (`EntityRecord.type === 0x80`, the exporter's own
 *   sentinel — see `export_dungeon_levels.py`'s `EntityRecord` field
 *   mapping) or one of the structure types above. Position and frame are
 *   *computed*, not looked up in `slots.slots` — `+0x218FA`'s own formula,
 *   `destX/Y = anchor(depth, lateral) - registration(group, depth)`, where
 *   `group = floorItem.gfxToGroup[entity.gfx]`. `resolveFloorItem` below
 *   returns `null` (render nothing) for a `gfxNumber` with no floor group
 *   (`noneGroup`/out of range) — matching the game's own "bail on a negative
 *   result" gate — or when `slots.floorItem` is absent (a level/fixture that
 *   doesn't model floor items, e.g. `sweep.test.ts`'s wall-only M1 fixture).
 *   Free-standing at any `(depth, lateral)` the anchor table covers, unlike
 *   alcove/plaque/door-switch/door-lock's wall-adjacency gating — the anchor
 *   table has no wall-mask dependency, and level design places items on any
 *   square shape. Does not model the runtime scatter jitter (`+0x220CC`,
 *   `FloorItemPlacement`'s doc comment) or the wall-mounted `+0x21C84`
 *   variant (kind 0-3's default, a documented, out-of-scope simplification).
 */
import type { CellQuery } from '../model/CellQuery.js';
import type { Pose } from '../model/Pose.js';
import { leftOf, rightOf, project } from '../model/Direction.js';
import type { Dir4 } from '../model/Pose.js';
import type { ViewSpec } from './ViewSpec.js';
import type { SemanticsFile } from '../schema/semantics.js';
import type { SlotTableFile, FloorItemPlacement, FloorPlatePlacement } from '../schema/slots.js';
import type { EntityRecord } from '../schema/level.js';
import type { DrawItem, DrawItemKind } from './DrawItem.js';
import type { FrameRef } from '../schema/slots.js';
import { isFrameTemplate } from '../raster/anim.js';

/**
 * Extra, per-instance fields merged onto every `DrawItem` a `pushSlot` call
 * emits for one square — the cell it was resolved at (`AnimRef`'s
 * `phase: 'cell'` needs this — see `DrawItem.cellX`/`cellY`'s doc comment),
 * and, for an entity-sourced prop, that entity's record/handle/hotspot code
 * (M4, "Mouse interactivity" / "Clickable-hotspot globals").
 */
interface SlotExtras {
  x: number;
  y: number;
  entity?: EntityRecord;
  entityHandle?: string;
  hotspot?: { code: number };
}

function pushSlot(
  items: DrawItem[],
  slots: SlotTableFile,
  key: string,
  kind: DrawItemKind,
  depth: number,
  lateral: number,
  extras: SlotExtras,
  side?: 'L' | 'R',
  propType?: string,
  resolveFrame?: (frame: FrameRef) => FrameRef,
): void {
  const slot = slots.slots[key];
  if (!slot) return;
  for (const draw of slot.draws) {
    items.push({
      ...draw,
      frame: resolveFrame ? resolveFrame(draw.frame) : draw.frame,
      kind,
      depth,
      lateral,
      side,
      propType,
      cellX: extras.x,
      cellY: extras.y,
      entity: extras.entity,
      entityHandle: extras.entityHandle,
      // An entity-derived hotspot code (below) always wins over anything
      // baked into the slot's own static `PieceDraw` — geometry (`slots.json`)
      // doesn't know about entity semantics, only `buildViewList` does.
      hotspot: extras.hotspot ?? draw.hotspot,
    });
  }
}

/** `depth` (0 = nearest) → door-lock's fixed depth-label convention (`read_door_lock`'s own `depth_labels`). */
const DOOR_LOCK_DEPTH_LABELS = ['near', 'mid', 'far'] as const;

/**
 * Substitutes a door-lock `FrameTemplate`'s `{mapId}`/`{gfxIndex}`/
 * `{depthLabel}` placeholders — see the module doc comment's "Door lock"
 * paragraph. Returns a non-template frame unchanged (defensive: lets this
 * function be passed as `pushSlot`'s generic `resolveFrame` even if a
 * literal-string draw ever ends up sharing a door-lock slot).
 */
function resolveDoorLockFrame(
  frame: FrameRef,
  mapId: number,
  gfxIndex: number,
  depth: number,
): FrameRef {
  if (!isFrameTemplate(frame)) return frame;
  const depthLabel = DOOR_LOCK_DEPTH_LABELS[depth] ?? DOOR_LOCK_DEPTH_LABELS[0];
  return frame.template
    .replace('{mapId}', String(mapId))
    .replace('{gfxIndex}', String(gfxIndex))
    .replace('{depthLabel}', depthLabel);
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

/**
 * M4 — the real, confirmed hotspot codes (`data-structure.md` "Clickable-
 * hotspot globals") for the entity types `buildViewList` already renders as
 * props. Keyed by `EntityRecord.type`; a type with two distinct codes
 * (plaque `0x20`/`0x21`) is disambiguated below rather than in this table.
 * Fountain/panel (`0x6E`) and switch (`0x6D`) are known codes but have no
 * rendered prop yet (floor-plate, M5's one remaining class), so they're not
 * wired here — see the module doc comment. Floor items carry no hotspot —
 * they aren't in this table (`decorate`/pick-up is a host/inventory
 * concern, not a viewport click per `data-structure.md`'s hotspot list).
 */
const ALCOVE_HOTSPOT_CODE = 0x69;
const PLAQUE_HOTSPOT_CODES: Record<0x20 | 0x21, number> = { 0x20: 0x6a, 0x21: 0x6f };
const DOOR_SWITCH_HOTSPOT_CODE = 0x64;
const DOOR_LOCK_HOTSPOT_CODE = 0x6b;

/** `EntityRecord.type` sentinel for a monster record (`export_dungeon_levels.py`'s `EntityRecord` field mapping: `raw[0]&0x80` -> `0x80`). Not a floor item, not a structure — excluded from the floor-item fallback below. */
const MONSTER_TYPE_SENTINEL = 0x80;

/**
 * Door rendering (Black Crypt kind 11, `data-structure.md` "Kind 11"): a
 * doorway square (structure type `0x11`, gfx `0x35`/`0x36` = Door Type 0/1)
 * draws a **frame** (the jamb/lintel portal, `+0x25CAE`) at every depth
 * 1-3, plus a **leaf** (the door panels, `+0x2613E`) on top only while the
 * door is closed (`raw[0x0F]` bit 0 clear). Positions are the confirmed
 * literal values from the renderer's disassembly (lateral 0, straight
 * ahead). Frame art is in the tileset bank's `doorway-*` frames.
 *
 * > **Documented renderer simplification:** the disassembly only tabulates
 * > positions for local depths 1-3 (Black Crypt's own viewport never draws
 * > a door frame farther than that) — `pushDoor` clamps any deeper `depth`
 * > to the depth-3 art (`?? DOOR_FRAME_SLOTS[3]!` / `DOOR_LEAF_SLOTS[3]!`)
 * > rather than fabricating undisassembled positions. This only matters for
 * > a future consumer (e.g. Wizardry 6) whose `depthCount` exceeds 4 with a
 * > door visible past depth 3 — such a door still renders (at the depth-3
 * > size/position) instead of crashing, but the exact placement past depth
 * > 3 is not a confirmed fact the way depths 1-3 are.
 */
const DOOR_FRAME_SLOTS: Record<number, Array<{ frame: string; x: number; y: number }>> = {
  1: [
    { frame: 'doorway-1a', x: 26, y: 9 },
    { frame: 'doorway-1c', x: 134, y: 9 },
    { frame: 'doorway-1b', x: 64, y: 9 },
  ],
  2: [
    { frame: 'doorway-2a', x: 54, y: 20 },
    { frame: 'doorway-2b', x: 80, y: 20 },
    { frame: 'doorway-2c', x: 124, y: 20 },
  ],
  3: [{ frame: 'doorway-3', x: 64, y: 25 }],
};

const DOOR_LEAF_SLOTS: Record<number, { type0: string; type1: string; x: number; y: number }> = {
  1: { type0: 'door-type0-1', type1: 'door-type1-1', x: 64, y: 18 },
  2: { type0: 'door-type0-2', type1: 'door-type1-2', x: 73, y: 26 },
  3: { type0: 'door-type0-3', type1: 'door-type1-3', x: 80, y: 30 },
};

/** Emit the door frame + closed-leaf DrawItems for a doorway cell straight ahead (`lateral === 0`). */
function pushDoor(
  items: DrawItem[],
  bankId: string,
  doors: EntityRecord[],
  depth: number,
  cell: { x: number; y: number },
): void {
  const frameSlots = DOOR_FRAME_SLOTS[depth] ?? DOOR_FRAME_SLOTS[3]!;
  for (const door of doors) {
    const open = (door.raw?.[0x0f] ?? 0) & 1 ? true : false;
    for (const p of frameSlots) {
      items.push({
        bank: bankId,
        frame: p.frame,
        destX: p.x,
        destY: p.y,
        blend: 'mask',
        kind: 'prop',
        depth,
        lateral: 0,
        propType: 'door',
        cellX: cell.x,
        cellY: cell.y,
        entity: door,
        origin: 'bcdft S_1+0x25CAE (door frame, kind 11)',
      });
    }
    if (open) continue;
    const leaf = DOOR_LEAF_SLOTS[depth] ?? DOOR_LEAF_SLOTS[3]!;
    items.push({
      bank: bankId,
      frame: door.gfx === 0x36 ? leaf.type1 : leaf.type0,
      destX: leaf.x,
      destY: leaf.y,
      blend: 'mask',
      kind: 'prop',
      depth,
      lateral: 0,
      propType: 'door',
      cellX: cell.x,
      cellY: cell.y,
      entity: door,
      origin: 'bcdft S_1+0x2613E (door leaf, closed)',
    });
  }
}

/** Every structure type this file renders its own dedicated way — the floor-item fallback in `pushProps` applies to anything *not* in this set (and not a monster). */
const HANDLED_STRUCTURE_TYPES = new Set<number>([0x16, 0x20, 0x21, 0x12, 0x0f, 0x22, 0x1e]);

/**
 * `blackcrypt-floor-item-placement` — `+0x218FA`'s own formula:
 * `dest = anchor(depth, lateral) - registration(group, depth)`, `group =
 * floorItem.gfxToGroup[gfxNumber]`. Returns `null` (render nothing) exactly
 * when the game's own gate would: no `floorItem` table at all (a
 * fixture/level that doesn't model floor items), `gfxNumber` out of range or
 * mapping to `noneGroup` (`MOVE.B (A1,gfx.W),D1` returning negative — no
 * floor sprite for this item), or a missing anchor/registration entry for
 * this exact `(depth, lateral)`/`(group, depth)` (the anchor table only
 * covers `depth`/`lateral` in `{0,1,2}`×`{-1,0,1}`, matching
 * `frontWallMaxDepth`).
 */
function resolveFloorItem(
  floorItem: FloorItemPlacement | undefined,
  gfxNumber: number | undefined,
  depth: number,
  lateral: number,
): { frame: string; destX: number; destY: number } | null {
  if (!floorItem || gfxNumber === undefined) return null;
  const group = floorItem.gfxToGroup[gfxNumber];
  if (group === undefined || group === floorItem.noneGroup) return null;
  const anchor = floorItem.anchor[`${depth}:${lateral}`];
  const registration = floorItem.registration[`${group}:${depth}`];
  if (!anchor || !registration) return null;
  return {
    frame: `floor${String(group).padStart(2, '0')}-d${depth}`,
    destX: anchor[0] - registration[0],
    destY: anchor[1] - registration[1],
  };
}

/**
 * `blackcrypt-floorplate-placement-wiring` — the game's own floor-plate
 * renderer (`+0x21732`) and its caller (`+0x248E`, the kind-4/12 type-0x1E
 * case). Returns the fixed grid of viewport positions + the up/down frame
 * name for a visible floor plate, or `null` when the game would draw
 * nothing. Reproduced gate-for-gate:
 *
 * - `lateral !== 0` → nothing (the `TST.W D4 / BNE` gate — plates only
 *   render in the centre column).
 * - bit 1 of `raw[0x0B]` set → nothing (`BTST #1,$0B(A0)`).
 * - `depth === 1`, `word +0x0E == 0`, `byte +0x07 == 0` → **near** plate:
 *   `nearPositions` (13), frame `near.up` if `word +0x08 == 0` (unpressed)
 *   else `near.down`.
 * - `depth === 2`, same two field checks → **far** plate: `farPositions`
 *   (11), `far.up`/`far.down` likewise.
 * - `depth === 0` and `depth >= 3` render nothing (the caller's depth ladder
 *   never reaches the renderer there); the `word +0x0E == 1` trap variant is
 *   a runtime effect-`0x59` marker, not a sprite, so it renders nothing here
 *   either.
 *
 * The walker renders the `$48F == 0` direct near table (the mirror-flag
 * default — same simplification as the wall rows); the game's far path
 * ignores `$48F` entirely, so `farPositions` are unconditional.
 */
function resolveFloorPlate(
  floorPlate: FloorPlatePlacement | undefined,
  raw: number[] | undefined,
  depth: number,
  lateral: number,
): { positions: [number, number][]; frame: string } | null {
  if (!floorPlate || !raw || raw.length < 0x10) return null;
  if (lateral !== 0) return null;
  if (((raw[0x0b] ?? 0) >> 1) & 1) return null;
  const w0e = ((raw[0x0e] ?? 0) << 8) | (raw[0x0f] ?? 0);
  const w08 = ((raw[0x08] ?? 0) << 8) | (raw[0x09] ?? 0);
  if (w0e !== 0 || (raw[0x07] ?? 0) !== 0) return null;
  if (depth === 1) {
    return {
      positions: floorPlate.nearPositions,
      frame: w08 === 0 ? floorPlate.near.up : floorPlate.near.down,
    };
  }
  if (depth === 2) {
    return {
      positions: floorPlate.farPositions,
      frame: w08 === 0 ? floorPlate.far.up : floorPlate.far.down,
    };
  }
  return null;
}

interface EntityHandle {
  handle?: string;
  entity: EntityRecord;
}

function pushProps(
  items: DrawItem[],
  slots: SlotTableFile,
  entries: EntityHandle[],
  facing: Dir4,
  depth: number,
  lateral: number,
  frontWallMaxDepth: number,
  cell: { x: number; y: number },
  mapId: number,
): void {
  for (const { handle, entity } of entries) {
    if (entity.type === 0x16 || entity.type === 0x20 || entity.type === 0x21) {
      if (depth >= frontWallMaxDepth) continue;
      const dir = singleWallDir(entity.wallMask, facing);
      if (dir === null) continue;
      const kind = entity.type === 0x16 ? 'alcove' : 'plaque';
      const hotspot = {
        code: entity.type === 0x16 ? ALCOVE_HOTSPOT_CODE : PLAQUE_HOTSPOT_CODES[entity.type],
      };
      pushSlot(
        items,
        slots,
        `prop:${kind}:${lateral}:${depth}:${dir}`,
        'prop',
        depth,
        lateral,
        { ...cell, entity, entityHandle: handle, hotspot },
        undefined,
        kind,
      );
    } else if (entity.type === 0x12) {
      if (depth >= 3) continue;
      const flight = stairsFlight(entity);
      if (flight === null) continue;
      pushSlot(
        items,
        slots,
        `prop:stairs-${flight}:${lateral}:${depth}`,
        'prop',
        depth,
        lateral,
        { ...cell, entity, entityHandle: handle },
        undefined,
        'stairs',
      );
    } else if (entity.type === 0x0f) {
      // The position table (`+0x25E5A`) is keyed by *local* depth (0-2 =
      // door one/two/three squares away), so the slot key uses `depth - 1`.
      // A lock/switch on the party's own square (depth 0) isn't rendered.
      if (depth < 1 || depth > 3) continue;
      if (!decoratesRightWall(entity.raw, facing)) continue;
      const local = depth - 1;
      const hotspot = { code: DOOR_SWITCH_HOTSPOT_CODE };
      pushSlot(
        items,
        slots,
        `prop:door-switch:${lateral}:${local}`,
        'prop',
        depth,
        lateral,
        { ...cell, entity, entityHandle: handle, hotspot },
        undefined,
        'door-switch',
      );
    } else if (entity.type === 0x22) {
      // Same local-depth convention as door-switch (`+0x25E12`).
      if (depth < 1 || depth > 3) continue;
      if (!decoratesRightWall(entity.raw, facing)) continue;
      // gfxNumber 0x51/0x52/0x53 -> gfxIndex 0/1/2 (read_door_lock); a
      // gfxNumber outside that range has no per-map decor art, so skip
      // rather than resolve a template that can't name a real frame.
      if (entity.gfx === undefined) continue;
      const gfxIndex = entity.gfx - 0x51;
      if (gfxIndex < 0 || gfxIndex > 2) continue;
      const local = depth - 1;
      const hotspot = { code: DOOR_LOCK_HOTSPOT_CODE };
      pushSlot(
        items,
        slots,
        `prop:door-lock:${lateral}:${local}`,
        'prop',
        depth,
        lateral,
        { ...cell, entity, entityHandle: handle, hotspot },
        undefined,
        'door-lock',
        (frame) => resolveDoorLockFrame(frame, mapId, gfxIndex, local),
      );
    } else if (entity.type === 0x1e) {
      // Floor plate / trap (`blackcrypt-floorplate-placement-wiring`) --
      // centre column only, and only the renderable plate variant
      // (`word +0x0E == 0`, `byte +0x07 == 0`) at `depth` 1 (near, 13
      // positions) or 2 (far, 11); the `word +0x0E == 1` trap is a runtime
      // effect marker, not a sprite. The game stamps the same sliver at
      // *every* grid position -- no per-plate sub-position selection.
      const plate = resolveFloorPlate(slots.floorPlate, entity.raw, depth, lateral);
      if (!plate) continue;
      const plateBank = slots.floorPlate!.bank; // resolveFloorPlate returned non-null
      for (const [destX, destY] of plate.positions) {
        items.push({
          bank: plateBank,
          frame: plate.frame,
          destX,
          destY,
          blend: 'mask',
          kind: 'prop',
          depth,
          lateral,
          propType: 'floor-plate',
          cellX: cell.x,
          cellY: cell.y,
          entity,
          entityHandle: handle,
          origin: `bcdft S_1+0x21732 (floor plate grid, depth=${depth} lateral=${lateral}, gfxNumber=${entity.gfx})`,
        });
      }
    } else if (entity.type !== MONSTER_TYPE_SENTINEL && !HANDLED_STRUCTURE_TYPES.has(entity.type)) {
      if (depth >= frontWallMaxDepth) continue;
      const resolved = resolveFloorItem(slots.floorItem, entity.gfx, depth, lateral);
      if (!resolved) continue;
      const bank = slots.floorItem!.bank; // resolveFloorItem returned non-null, so floorItem exists
      items.push({
        bank,
        frame: resolved.frame,
        destX: resolved.destX,
        destY: resolved.destY,
        blend: 'mask',
        kind: 'prop',
        depth,
        lateral,
        propType: 'floor-item',
        cellX: cell.x,
        cellY: cell.y,
        entity,
        entityHandle: handle,
        origin: `bcdft S_1+0x218FA (floor-item anchor+registration, gfxNumber=${entity.gfx}, depth=${depth} lateral=${lateral})`,
      });
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
      const cell = { x, y };

      if (depth < spec.frontWallMaxDepth && level.wallAt(x, y, pose.facing)) {
        pushSlot(items, slots, `front:${lateral}:${depth}`, 'front', depth, lateral, cell);
      }

      // Doorway square straight ahead (kind 11): frame at depths 1-3, leaf
      // only while closed. Uses the tileset bank's `doorway-*`/`door-type*`
      // frames — the door renders even at depth 3 (the front-wall gate
      // above is `frontWallMaxDepth`-bounded, but doors aren't).
      if (lateral === 0 && depth >= 1) {
        const doors = level.entitiesAt(x, y).filter((e) => e.type === 0x11);
        if (doors.length > 0) {
          const bank = slots.banks[0];
          if (!bank) {
            throw new Error(
              'buildViewList: slot table has no banks (banks: []) -- cannot resolve door art for the doorway cell in view',
            );
          }
          pushDoor(items, bank.id, doors, depth, cell);
        }
      }

      if (lateral === 0) {
        if (level.wallAt(x, y, leftOf(pose.facing))) {
          pushSlot(items, slots, `side:L:${depth}`, 'side', depth, lateral, cell, 'L');
        }
        if (level.wallAt(x, y, rightOf(pose.facing))) {
          pushSlot(items, slots, `side:R:${depth}`, 'side', depth, lateral, cell, 'R');
        }
      }

      const entries: EntityHandle[] = level.entityHandlesAt
        ? level.entityHandlesAt(x, y)
        : level.entitiesAt(x, y).map((entity) => ({ entity }));
      if (entries.length > 0) {
        pushProps(
          items,
          slots,
          entries,
          pose.facing,
          depth,
          lateral,
          spec.frontWallMaxDepth,
          cell,
          pose.level,
        );
      }
    }
  }

  return items;
}
