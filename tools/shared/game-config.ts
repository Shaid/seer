/**
 * Game and platform configuration for the extraction pipeline.
 *
 * Single source of truth for per-game, per-platform file mappings. Every
 * pipeline script imports from here instead of hardcoding file paths.
 *
 * Re-exports browser-safe identifiers from src/game-id.ts and adds
 * Node-only config data (this file uses `node:fs`/`node:path`, so it must
 * never be imported from browser-bundled code under src/).
 */

import {
  resolveDataDir,
  findFileCI,
  resType,
  getGameConfig as _getGameConfig,
  getSupportedPlatforms as _getSupportedPlatforms,
  type GamePlatformConfig,
} from '@seer/pipeline';
import {
  GAME_IDS,
  PLATFORM_IDS,
  DEFAULT_GAME,
  DEFAULT_PLATFORM,
  type GameId,
  type PlatformId,
} from '../../src/game-id.ts';

export {
  GAME_IDS,
  PLATFORM_IDS,
  DEFAULT_GAME,
  DEFAULT_PLATFORM,
  resolveDataDir,
  findFileCI,
  resType,
};
export type { GameId, PlatformId, GamePlatformConfig };

/**
 * The config table itself. This is the ONE place that should need editing
 * when you add a new game or a new platform port of an existing game.
 *
 * Delete this placeholder entry and add your own.
 */
export const GAME_PLATFORMS: GamePlatformConfig[] = [
  {
    game: 'game1',
    platform: 'platform1',
    displayName: 'Placeholder Game (Platform 1)',
    dataDirs: ['game1/platform1'],
    executable: undefined,
    expectedFiles: [],
    supported: false,
    assetDir: 'game1',
    features: {},
  },
];

/** Lookup a specific game+platform config. */
export function getGameConfig(game: GameId, platform: PlatformId): GamePlatformConfig | undefined {
  return _getGameConfig(GAME_PLATFORMS, game, platform);
}

/** Get all supported platforms for a game. */
export function getSupportedPlatforms(game: GameId): PlatformId[] {
  return _getSupportedPlatforms(GAME_PLATFORMS, game) as PlatformId[];
}
