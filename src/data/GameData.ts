/**
 * GameData.ts — Type definitions for preprocessed runtime assets.
 *
 * This is a template. Replace the placeholder interfaces below with types
 * that match whatever your build pipeline (tools/) actually produces —
 * e.g. tile atlas metadata, level/map grids, entity tables, sprite frame
 * manifests. Keep exactly one `GameAssets` interface describing everything
 * `AssetLoader` fetches — this is the "one central manifest type" convention
 * from docs/architecture-overview.md §8.
 */

/** Example: metadata for a sprite/tile atlas PNG produced by the pipeline. */
export interface AtlasMeta {
  imageUrl: string;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
}

/**
 * Top-level bag of all assets a game/platform combination needs at runtime.
 * Extend this with whatever your reverse-engineered data actually contains.
 */
export interface GameAssets {
  atlas: AtlasMeta;
  // TODO: add your own fields, e.g.:
  // map: MapData
  // entities: EntityData[]
  // locations: LocationData[]
}
