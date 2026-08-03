/**
 * `semantics.json` — binds a game's raw wall/feature values to behaviour
 * and piece kinds, carrying a `confidence` rating that's surfaced in the
 * debug harness rather than silently trusted.
 *
 * Not consumed by anything in M0/M1 (`buildViewList` is a later
 * milestone) — defined now for the schema/validator contract.
 */
import type { Dir4 } from './level.ts';

export interface WallMeaning {
  label: string;
  blocksMovement: boolean;
  blocksSight: boolean;
  pieceKind: string | null;
  /** Piece kind to use once this wall has been discovered (e.g. a secret door). */
  discoveredPieceKind?: string | null;
}

export interface FeatureMeaning {
  label: string;
  pieceKind: string | null;
  orientationGated?: boolean;
  blocksMovement?: boolean;
  tag?: string;
}

export interface SemanticsFile {
  schemaVersion: 1;
  confidence: 'confirmed' | 'rendered' | 'hypothesis';
  source: string;
  walls: Record<string, WallMeaning>;
  features: Record<string, FeatureMeaning>;
  facingMap?: [Dir4, Dir4, Dir4, Dir4];
  yAxisDown?: boolean;
}
