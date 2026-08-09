/**
 * Entity state patches — M4, `walker-plan.md` "Mouse interactivity":
 * "the walker only exposes `setEntityState(handle, patch)` to mark the view
 * dirty ... door open state is bit 0 of record `+0x0F`, locked is bit 1 of
 * word `+0x0E` ... the walker reports both without opining. Opening a locked
 * door is therefore a host policy."
 *
 * `EntityRecord.flags` is already exactly that word (big-endian `raw[0x0E:
 * 0x10]` — `export_dungeon_levels.py`'s own field-mapping table), so reading
 * door state needs no new export, just the two-bit decode below
 * (`docs/blackcrypt/amiga/data-structure.md` "Door State" / "Locked doors").
 * This module is generic across entity types — `doorState`/`DOOR_OPEN_BIT`/
 * `DOOR_LOCKED_BIT` only mean "door" for a Door frame (`type === 0x11`)
 * record; calling it on an unrelated type just decodes two bits of whatever
 * that type's `+0x0E` field actually holds, which is the caller's call to
 * make (this module has no opinion on `type`).
 */
import type { EntityRecord } from '../schema/level.js';

export const DOOR_OPEN_BIT = 0x1;
export const DOOR_LOCKED_BIT = 0x2;

export interface DoorState {
  open: boolean;
  locked: boolean;
}

/** Decode `entity.flags` (word `+0x0E`) as door open/locked state. Meaningful for `type === 0x11` (Door frame) records — see the module doc comment. */
export function doorState(entity: EntityRecord): DoorState {
  const flags = entity.flags ?? 0;
  return { open: (flags & DOOR_OPEN_BIT) !== 0, locked: (flags & DOOR_LOCKED_BIT) !== 0 };
}

/** A patch `setEntityState`/`PatchedCellQuery.setPatch` accepts — only the fields present are changed; `undefined` means "leave as-is." */
export interface EntityStatePatch {
  open?: boolean;
  locked?: boolean;
}

/** Apply `patch` to a raw `flags` word, touching only the bits the patch specifies. */
export function applyEntityStatePatch(flags: number, patch: EntityStatePatch): number {
  let f = flags;
  if (patch.open !== undefined) f = patch.open ? f | DOOR_OPEN_BIT : f & ~DOOR_OPEN_BIT;
  if (patch.locked !== undefined) f = patch.locked ? f | DOOR_LOCKED_BIT : f & ~DOOR_LOCKED_BIT;
  return f;
}
