/**
 * The shared texture-atlas metadata shape written by every offline
 * build-assets pipeline and read by both the browser runtime and the
 * viewer tooling.
 *
 * Sprites are shelf-packed at build time (rows/columns of a fixed cell size
 * would waste space and can't fit real extracted game art, which is almost
 * never uniformly sized) — so the shape is a flat list of named, arbitrarily
 * positioned/sized frames within one atlas image, not a grid.
 *
 * This lives in `@seer-project/core` specifically so there is exactly one
 * definition shared by runtime code and offline tooling alike — it used to
 * be independently redeclared in the `create-seer-app` scaffold's
 * `src/data/GameData.ts` (as a *different*, incompatible uniform-grid shape)
 * and `tools/viewer/shared.ts` (as this packed-frames shape), silently
 * disagreeing with each other in every project scaffolded from it. See
 * `docs/weaknesses.md` §6 for the full history.
 */

/** One packed sprite frame's position and size within its atlas image. */
export interface AtlasFrame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A shelf-packed texture atlas: one image, many named frames within it. */
export interface AtlasMeta {
  frames: AtlasFrame[];
  width: number;
  height: number;
}
