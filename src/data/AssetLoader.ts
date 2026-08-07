/**
 * AssetLoader.ts — Fetches preprocessed assets produced by the offline
 * pipeline (tools/) from `public/assets/<game>/<platform>/` at runtime.
 *
 * Uses `loadAssets` from @seer-project/core (browser-safe — NOT @seer-project/pipeline,
 * which is Node-only and must never be imported by browser-bundled code
 * under src/, see docs/architecture-overview.md §8) — define the schema
 * mapping asset keys to file paths, and the loader handles parallel
 * fetching + JSON parsing. For texture loading (PNGs with nearest-neighbour
 * filtering), add that as a post-processing step in the consumer layer —
 * see docs/architecture-overview.md §8.
 */
import { loadAssets } from '@seer-project/core';
import type { GameAssets } from './GameData.ts';
import type { GameId, PlatformId } from '../game-id.ts';

function assetBasePath(game: GameId, platform: PlatformId): string {
  return `/assets/${game}/${platform}`;
}

/**
 * Load all runtime assets for a given game/platform combination.
 *
 * The schema below maps each asset key to its filename. Add new entries as
 * your pipeline produces more outputs — the returned object stays typed to
 * `GameAssets`.
 */
export async function loadGameAssets(game: GameId, platform: PlatformId): Promise<GameAssets> {
  const base = assetBasePath(game, platform);

  return loadAssets<GameAssets>(base, {
    atlas: 'atlas.json',
    // TODO: add more assets as your pipeline produces them:
    // map:   'map.json',
  });
}
