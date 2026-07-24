import { loadAssets } from '@seer/core';
import type { GameAssets } from './GameData.ts';
import type { GameId, PlatformId } from '../game-id.ts';

function assetBasePath(game: GameId, platform: PlatformId): string {
  return `/assets/${game}/${platform}`;
}

export async function loadGameAssets(game: GameId, platform: PlatformId): Promise<GameAssets> {
  const base = assetBasePath(game, platform);
  return loadAssets<GameAssets>(base, { atlas: 'atlas.json' });
}
