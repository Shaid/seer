/**
 * Game and platform configuration for the extraction pipeline.
 *
 * Single source of truth for per-game, per-platform file mappings. Every
 * pipeline script imports from here instead of hardcoding file paths.
 *
 * Re-exports browser-safe identifiers from src/game-id.ts and adds
 * Node-only config data (this file uses `node:fs`/`node:path`, so it must
 * never be imported from browser-bundled code under src/).
 *
 * The config table is defined via defineGameConfig() from @seer-project/pipeline —
 * the nested GameConfig[] shape that runPipeline() and create-seer templates
 * target.
 */

import {
  defineGameConfig,
  flattenConfigs,
  resolveDataDir,
  findFileCI,
  resType,
  getGameConfig as _getGameConfig,
  getSupportedPlatforms as _getSupportedPlatforms,
  type PlatformConfig as BasePlatformConfig,
  type GameConfig as BaseGameConfig,
} from '@seer-project/pipeline';
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
  flattenConfigs,
  resolveDataDir,
  findFileCI,
  resType,
};
export type { GameId, PlatformId };

/**
 * Consumer-narrowed platform type. `@seer-project/pipeline`'s PlatformConfig uses
 * bare `string` for `platform` since the library can't know this project's
 * specific IDs. Narrowing here restores compile-time typo checking.
 */
export interface PlatformConfig extends Omit<BasePlatformConfig, 'platform'> {
  platform: PlatformId;
}

/**
 * Consumer-narrowed game config. The `id` is narrowed to `GameId`, and
 * platforms are narrowed to `PlatformConfig[]`.
 */
export interface GameConfig extends Omit<BaseGameConfig, 'id' | 'platforms'> {
  id: GameId;
  platforms: PlatformConfig[];
}

/**
 * The config table itself. This is the ONE place that should need editing
 * when you add a new game or a new platform port of an existing game.
 *
 * Delete this placeholder entry and add your own. Register pipeline step
 * functions (exportGameData, buildAssets) directly on platform entries —
 * runPipeline() calls them via the flattened config.
 */
export const GAME_CONFIGS: GameConfig[] = defineGameConfig([
  {
    id: 'game1',
    displayName: 'Placeholder Game',
    platforms: [
      {
        platform: 'platform1',
        dataDirs: ['game1/platform1'],
        executable: undefined,
        expectedFiles: [],
        supported: false,
        assetDir: 'game1',
        features: {},
      },
    ],
  },
]);

/** Flat array of all platform entries, with game back-references set. */
export const GAME_PLATFORMS = flattenConfigs(GAME_CONFIGS) as PlatformConfig[];

/** Lookup a specific game+platform config. */
export function getGameConfig(game: GameId, platform: PlatformId): PlatformConfig | undefined {
  return _getGameConfig(GAME_PLATFORMS, game, platform) as PlatformConfig | undefined;
}

/** Get all supported platforms for a game. */
export function getSupportedPlatforms(game: GameId): PlatformId[] {
  return _getSupportedPlatforms(GAME_PLATFORMS, game) as PlatformId[];
}
