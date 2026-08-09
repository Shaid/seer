/**
 * M4 — entity state patching (`walker-plan.md` "Mouse interactivity"):
 * toggling a door's open/locked bits through `PatchedCellQuery` and
 * confirming `buildViewList`/`entitiesAt` sees the patched state, without
 * mutating the underlying level data.
 */
import { describe, expect, it } from 'vitest';
import { PatchedCellQuery } from '../model/PatchedCellQuery.js';
import {
  doorState,
  DOOR_OPEN_BIT,
  DOOR_LOCKED_BIT,
  applyEntityStatePatch,
} from '../model/EntityState.js';
import type { CellQuery } from '../model/CellQuery.js';
import type { EntityRecord } from '../schema/level.js';
import type { Dir4 } from '../model/Pose.js';

const DOOR_HANDLE = '1:2:3:7';
const DOOR_RECORD: EntityRecord = { type: 0x11, flags: 0, raw: new Array(20).fill(0) };

function makeLevel(): CellQuery {
  return {
    inBounds: () => true,
    wallAt: () => false,
    planeAt: () => 0,
    entitiesAt(x, y) {
      return x === 3 && y === 2 ? [DOOR_RECORD] : [];
    },
    entityHandlesAt(x, y) {
      return x === 3 && y === 2 ? [{ handle: DOOR_HANDLE, entity: DOOR_RECORD }] : [];
    },
  };
}

describe('doorState / applyEntityStatePatch — decoding record +0x0E', () => {
  it('bit 0 clear, bit 1 clear: closed, unlocked', () => {
    expect(doorState({ type: 0x11, flags: 0 })).toEqual({ open: false, locked: false });
  });

  it('bit 0 set: open', () => {
    expect(doorState({ type: 0x11, flags: DOOR_OPEN_BIT })).toEqual({ open: true, locked: false });
  });

  it('bit 1 set: locked (independent of open)', () => {
    expect(doorState({ type: 0x11, flags: DOOR_LOCKED_BIT })).toEqual({
      open: false,
      locked: true,
    });
    expect(doorState({ type: 0x11, flags: DOOR_OPEN_BIT | DOOR_LOCKED_BIT })).toEqual({
      open: true,
      locked: true,
    });
  });

  it('treats a missing flags field as 0', () => {
    expect(doorState({ type: 0x11 })).toEqual({ open: false, locked: false });
  });

  it('applyEntityStatePatch only touches the bits the patch specifies', () => {
    expect(applyEntityStatePatch(DOOR_LOCKED_BIT, { open: true })).toBe(
      DOOR_OPEN_BIT | DOOR_LOCKED_BIT,
    );
    expect(applyEntityStatePatch(DOOR_OPEN_BIT | DOOR_LOCKED_BIT, { locked: false })).toBe(
      DOOR_OPEN_BIT,
    );
    expect(applyEntityStatePatch(0xff00, {})).toBe(0xff00); // untouched high bits survive
  });
});

describe('PatchedCellQuery', () => {
  it('passes inBounds/wallAt/planeAt straight through, unpatched', () => {
    const base = makeLevel();
    const patched = new PatchedCellQuery(base);
    expect(patched.inBounds(0, 0)).toBe(true);
    expect(patched.wallAt(0, 0, 0 as Dir4)).toBe(false);
    expect(patched.planeAt('x', 0, 0)).toBe(0);
  });

  it('entitiesAt/entityHandlesAt reflect the base level unpatched, before any setPatch', () => {
    const patched = new PatchedCellQuery(makeLevel());
    expect(doorState(patched.entitiesAt(3, 2)[0]!)).toEqual({ open: false, locked: false });
  });

  it('setEntityState (via setPatch) changes what entitiesAt/entityHandlesAt report for that handle only', () => {
    const patched = new PatchedCellQuery(makeLevel());
    patched.setPatch(DOOR_HANDLE, { open: true });

    const [{ entity }] = patched.entityHandlesAt(3, 2);
    expect(doorState(entity)).toEqual({ open: true, locked: false });

    // entitiesAt (the read path buildViewList/CellQuery consumers actually use) agrees.
    expect(doorState(patched.entitiesAt(3, 2)[0]!)).toEqual({ open: true, locked: false });
  });

  it('never mutates the underlying record — the base level is untouched', () => {
    const patched = new PatchedCellQuery(makeLevel());
    patched.setPatch(DOOR_HANDLE, { open: true, locked: true });
    expect(DOOR_RECORD.flags).toBe(0); // the shared fixture object, unmodified
  });

  it('merges successive patches rather than replacing them', () => {
    const patched = new PatchedCellQuery(makeLevel());
    patched.setPatch(DOOR_HANDLE, { locked: true });
    patched.setPatch(DOOR_HANDLE, { open: true }); // should not clear locked
    expect(doorState(patched.entitiesAt(3, 2)[0]!)).toEqual({ open: true, locked: true });
  });

  it('getPatch/clearPatch round-trip', () => {
    const patched = new PatchedCellQuery(makeLevel());
    expect(patched.getPatch(DOOR_HANDLE)).toBeUndefined();
    patched.setPatch(DOOR_HANDLE, { open: true });
    expect(patched.getPatch(DOOR_HANDLE)).toEqual({ open: true });
    patched.clearPatch(DOOR_HANDLE);
    expect(patched.getPatch(DOOR_HANDLE)).toBeUndefined();
    expect(doorState(patched.entitiesAt(3, 2)[0]!)).toEqual({ open: false, locked: false });
  });

  it('a base CellQuery with no entityHandlesAt still surfaces entities (synthesized per-call handles), rather than silently dropping them', () => {
    const handleless: CellQuery = {
      inBounds: () => true,
      wallAt: () => false,
      planeAt: () => 0,
      entitiesAt: (x, y) => (x === 0 && y === 0 ? [{ type: 0x11, flags: 0 }] : []),
    };
    const patched = new PatchedCellQuery(handleless);
    expect(patched.entitiesAt(0, 0)).toHaveLength(1);
    const [{ handle, entity }] = patched.entityHandlesAt(0, 0);
    expect(entity.type).toBe(0x11);
    patched.setPatch(handle, { open: true });
    expect(doorState(patched.entitiesAt(0, 0)[0]!)).toEqual({ open: true, locked: false });
  });
});
