/**
 * `levels.json` — the map data a game provides: cell space, wall storage
 * convention, load units (a Black Crypt "map" holding many logical
 * sub-levels; a Wizardry 6 level is a load unit of one), and entity
 * records for doors/props/etc.
 *
 * This file is NOT consumed by anything in M0/M1 — `model/` (CellQuery,
 * Pose, buildViewList) is a later milestone. The shape is defined now so
 * the validator and schemaVersion contract exist from the start.
 */

/** Walker-canonical facing: 0 = north, 1 = east, 2 = south, 3 = west. */
export type Dir4 = 0 | 1 | 2 | 3;

export type CellSpace =
  | { kind: 'flat'; width: number; height: number }
  | { kind: 'regions'; regionCount: number; regionSize: number; worldWidth: number; worldHeight: number };

export type WallStorage =
  | { kind: 'bitflags'; plane: string; bits: [number, number, number, number] }
  | { kind: 'shared-edge'; planes: [string, string]; planeDirs: [Dir4, Dir4]; offMapValue: number }
  | { kind: 'per-cell-4'; planes: [string, string, string, string] };

export interface EntityRecord {
  type: number;
  gfx?: number;
  wallMask?: number;
  slotNibble?: number;
  chainNext?: number;
  flags?: number;
  /** Opaque raw bytes for fields the schema doesn't model yet. */
  raw?: number[];
}

export interface LevelUnit {
  id: number;
  name?: string;
  /** Densified flat planes, e.g. Black Crypt's wallFlags/type/sublevel/handle. */
  planes: Record<string, number[]>;
  /** For load units that carry multiple logical levels (Black Crypt's per-square sublevel nibble). */
  sublevelPlane?: string;
  sublevels?: { id: number; label?: string; tileset?: string; paletteRamp?: number }[];
  tileset?: string;
  paletteRamp?: number;
}

export interface DungeonLevelFile {
  schemaVersion: 1;
  game: string;
  platform: string;
  cellSpace: CellSpace;
  wallStorage: WallStorage;
  /** true if +Y is south (down on a conventional map); Black Crypt is false — +Y is north. */
  yAxisDown: boolean;
  units: LevelUnit[];
  entities?: Record<string, EntityRecord>;
  provenance?: Record<string, string>;
}
