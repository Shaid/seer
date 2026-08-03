import { describe, expect, it } from 'vitest';
import {
  validateDungeonLevelFile,
  validateSlotTableFile,
  validateSemanticsFile,
} from '../schema/validate.ts';

const minimalLevel = {
  schemaVersion: 1,
  game: 'blackcrypt',
  platform: 'amiga',
  cellSpace: { kind: 'flat', width: 64, height: 64 },
  wallStorage: { kind: 'bitflags', plane: 'wallFlags', bits: [12, 13, 14, 15] },
  yAxisDown: false,
  units: [
    { id: 1, planes: { wallFlags: [0, 1, 2] } },
  ],
};

const minimalSlots = {
  schemaVersion: 1,
  surface: { width: 320, height: 200 },
  viewport: { x: 0, y: 0, width: 208, height: 140 },
  depthCount: 4,
  lateralOffsets: [0, 1, -1],
  frontWallMaxDepth: 3,
  banks: [{ id: 'dungeon-bcdfx', atlas: 'textures/dungeon-bcdfx.json', image: 'textures/dungeon-bcdfx.png' }],
  slots: {
    'front:0:0': { draws: [{ bank: 'dungeon-bcdfx', frame: 'wall0-face', destX: 16, destY: 5, blend: 'replace' }] },
    'front:-1:0': null,
  },
  staticSlots: [{ draws: [{ bank: 'dungeon-bcdfx', frame: 'ceiling', destX: 0, destY: 0, blend: 'replace' }] }],
};

const minimalSemantics = {
  schemaVersion: 1,
  confidence: 'confirmed',
  source: 'data-structure.md',
  walls: {
    '0x1000': { label: 'north wall', blocksMovement: true, blocksSight: true, pieceKind: 'wall' },
  },
  features: {
    door: { label: 'door', pieceKind: 'door-type0' },
  },
};

describe('validateDungeonLevelFile', () => {
  it('accepts a minimal valid fixture', () => {
    const result = validateDungeonLevelFile(minimalLevel);
    expect(result.schemaVersion).toBe(1);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.planes.wallFlags).toEqual([0, 1, 2]);
  });

  it('rejects a bad schemaVersion', () => {
    expect(() => validateDungeonLevelFile({ ...minimalLevel, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validateDungeonLevelFile({ ...minimalLevel, schemaVersion: undefined })).toThrow(/schemaVersion/);
  });

  it('rejects a non-object', () => {
    expect(() => validateDungeonLevelFile(null)).toThrow();
    expect(() => validateDungeonLevelFile('nope')).toThrow();
  });

  it('rejects a malformed wallStorage.kind', () => {
    expect(() => validateDungeonLevelFile({ ...minimalLevel, wallStorage: { kind: 'nonsense' } })).toThrow(/wallStorage.kind/);
  });
});

describe('validateSlotTableFile', () => {
  it('accepts a minimal valid fixture', () => {
    const result = validateSlotTableFile(minimalSlots);
    expect(result.schemaVersion).toBe(1);
    expect(result.slots['front:0:0']?.draws).toHaveLength(1);
    expect(result.slots['front:-1:0']).toBeNull();
    expect(result.staticSlots).toHaveLength(1);
  });

  it('rejects a bad schemaVersion', () => {
    expect(() => validateSlotTableFile({ ...minimalSlots, schemaVersion: '1' })).toThrow(/schemaVersion/);
  });

  it('rejects an invalid blend mode', () => {
    const bad = {
      ...minimalSlots,
      slots: { 'front:0:0': { draws: [{ bank: 'x', frame: 'y', destX: 0, destY: 0, blend: 'xor' }] } },
    };
    expect(() => validateSlotTableFile(bad)).toThrow(/blend/);
  });
});

describe('validateSemanticsFile', () => {
  it('accepts a minimal valid fixture', () => {
    const result = validateSemanticsFile(minimalSemantics);
    expect(result.schemaVersion).toBe(1);
    expect(result.walls['0x1000']?.blocksMovement).toBe(true);
    expect(result.features.door?.pieceKind).toBe('door-type0');
  });

  it('rejects a bad schemaVersion', () => {
    expect(() => validateSemanticsFile({ ...minimalSemantics, schemaVersion: 0 })).toThrow(/schemaVersion/);
  });

  it('rejects an invalid confidence level', () => {
    expect(() => validateSemanticsFile({ ...minimalSemantics, confidence: 'vibes' })).toThrow(/confidence/);
  });
});
