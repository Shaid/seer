/**
 * AssetLoader.ts — Fetches preprocessed assets produced by the offline
 * pipeline (tools/) from `public/assets/<game>/<platform>/` at runtime.
 *
 * This is a template demonstrating the "one loader function, one GameAssets
 * interface, parallel fetch" pattern from docs/architecture-overview.md §8.
 * Replace the fetched filenames with whatever your build-assets script
 * actually writes.
 */
import type { GameAssets, AtlasMeta } from './GameData.ts';
import type { GameId, PlatformId } from '../game-id.ts';

function assetBasePath(game: GameId, platform: PlatformId): string {
  return `/assets/${game}/${platform}`;
}

/** Load all runtime assets for a given game/platform combination. */
export async function loadGameAssets(game: GameId, platform: PlatformId): Promise<GameAssets> {
  const base = assetBasePath(game, platform);

  const [atlas] = await Promise.all([
    fetch(`${base}/atlas.json`).then((r) => r.json() as Promise<AtlasMeta>),
    // TODO: fetch additional manifests in parallel, e.g.:
    // fetch(`${base}/map.json`).then((r) => r.json() as Promise<MapData>),
  ]);

  return { atlas };
}
