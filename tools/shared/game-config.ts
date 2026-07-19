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
 * The config table is defined via defineGameConfig() from @seer/pipeline —
 * the canonical shape that runPipeline() and create-seer templates target.
 */

import {
  defineGameConfig,
  resolveDataDir,
  findFileCI,
  resType,
  getGameConfig as _getGameConfig,
  getSupportedPlatforms as _getSupportedPlatforms,
  type GameConfig as BaseGameConfig,
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
export type { GameId, PlatformId };

/**
 * Consumer-narrowed config type. `@seer/pipeline`'s GameConfig uses bare
 * `string` for `game`/`platform` since the library can't know this project's
 * specific IDs. Narrowing here restores compile-time typo checking (e.g.
 * `game: 'gam1'` below would now fail to compile) against
 * GAME_IDS/PLATFORM_IDS — see docs/architecture-overview.md §5 for the
 * rationale behind keeping this narrowing at the consumer boundary rather
 * than making the library type generic.
 */
export interface GameConfig extends Omit<BaseGameConfig, 'game' | 'platform'> {
  game: GameId;
  platform: PlatformId;
}

/**
 * The config table itself. This is the ONE place that should need editing
 * when you add a new game or a new platform port of an existing game.
 *
 * Delete this placeholder entry and add your own. Register pipeline step
 * functions (exportGameData, buildAssets) directly on each entry —
 * runPipeline() calls them instead of resolving script paths by convention.
 */
export const GAME_PLATFORMS: GameConfig[] = defineGameConfig([
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
]);

/** Lookup a specific game+platform config. */
export function getGameConfig(game: GameId, platform: PlatformId): GameConfig | undefined {
  return _getGameConfig(GAME_PLATFORMS, game, platform) as GameConfig | undefined;
}

/** Get all supported platforms for a game. */
export function getSupportedPlatforms(game: GameId): PlatformId[] {
  return _getSupportedPlatforms(GAME_PLATFORMS, game) as PlatformId[];
}
