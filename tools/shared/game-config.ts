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
  type GamePlatformConfig as BaseGamePlatformConfig,
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
 * Consumer-narrowed config type. `@seer/pipeline`'s GamePlatformConfig uses
 * bare `string` for `game`/`platform` since the library can't know this
 * project's specific IDs. Narrowing here restores compile-time typo
 * checking (e.g. `game: 'gam1'` below would now fail to compile) against
 * GAME_IDS/PLATFORM_IDS — see docs/architecture-overview.md §5 for the
 * rationale behind keeping this narrowing at the consumer boundary rather
 * than making the library type generic.
 */
export interface GamePlatformConfig extends Omit<BaseGamePlatformConfig, 'game' | 'platform'> {
  game: GameId;
  platform: PlatformId;
}

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
  // Cast is safe: GAME_PLATFORMS is statically typed against the narrowed
  // GamePlatformConfig above, so anything the library hands back already
  // satisfies it — the library's own return type just can't express that.
  return _getGameConfig(GAME_PLATFORMS, game, platform) as GamePlatformConfig | undefined;
}

/** Get all supported platforms for a game. */
export function getSupportedPlatforms(game: GameId): PlatformId[] {
  return _getSupportedPlatforms(GAME_PLATFORMS, game) as PlatformId[];
}
