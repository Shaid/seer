import {
  defineGameConfig,
  flattenConfigs,
  resolveDataDir,
  findFileCI,
  resType,
  getGameConfig as _getGameConfig,
  getSupportedPlatforms as _getSupportedPlatforms,
  type GameConfig as BaseGameConfig,
  type PlatformConfig as BasePlatformConfig,
} from '@seer/pipeline';
import {
  GAME_IDS,
  PLATFORM_IDS,
  DEFAULT_GAME,
  DEFAULT_PLATFORM,
  type GameId,
  type PlatformId,
} from '../../src/game-id.ts';

export { GAME_IDS, PLATFORM_IDS, DEFAULT_GAME, DEFAULT_PLATFORM, flattenConfigs, resolveDataDir, findFileCI, resType };
export type { GameId, PlatformId };

export interface PlatformConfig extends Omit<BasePlatformConfig, "platform"> {
  platform: PlatformId;
}

export interface GameConfig extends Omit<BaseGameConfig, "id" | "platforms"> {
  id: GameId;
  platforms: PlatformConfig[];
}

export const GAME_CONFIGS: GameConfig[] = defineGameConfig([{
  id: '<%= it.game %>',
  displayName: '<%= it.displayName %>',
  platforms: [{
    platform: '<%= it.platform %>',
    dataDirs: ['<%= it.game %>/<%= it.platform %>'],
    executable: undefined,
    expectedFiles: [],
    supported: false,
    assetDir: '<%= it.game %>',
    features: {},
  }],
}]);

export const GAME_PLATFORMS = flattenConfigs(GAME_CONFIGS);

export function getGameConfig(game: GameId, platform: PlatformId): PlatformConfig | undefined {
  return _getGameConfig(GAME_PLATFORMS, game, platform) as PlatformConfig | undefined;
}

export function getSupportedPlatforms(game: GameId): PlatformId[] {
  return _getSupportedPlatforms(GAME_PLATFORMS, game) as PlatformId[];
}
