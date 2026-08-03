/**
 * Expands an `IndexedSurface`'s palette-index framebuffer to interleaved
 * RGBA bytes, using whatever palette produced those indices (typically a
 * `PieceBank`'s derived local palette, but any `RGBAColor[]` works — e.g.
 * a future runtime accent-ramp palette per the walker plan's
 * `cyclePalette` integration).
 */

export interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Index 0 is reserved, by convention, as the surface-background sentinel:
 * every `IndexedSurface` starts cleared to 0, and `PieceBank.fromRGBA`
 * never assigns a real atlas color to it. Rendered as opaque black.
 */
export const BACKGROUND_COLOR: RGBAColor = { r: 0, g: 0, b: 0, a: 255 };

/**
 * Expand an index buffer to `Uint8ClampedArray` RGBA bytes (the shape both
 * `ImageData` and a PixiJS `BufferImageSource` want). An index with no
 * matching palette entry renders as opaque black — defensive; a correctly
 * built `PieceBank` palette never produces one.
 */
export function indicesToRGBA(indices: Uint8Array, palette: RGBAColor[]): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const c = palette[indices[i] as number] ?? BACKGROUND_COLOR;
    const o = i * 4;
    out[o] = c.r;
    out[o + 1] = c.g;
    out[o + 2] = c.b;
    out[o + 3] = c.a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// M4 — runtime accent-ramp selection (`walker-plan.md` "ramp-aware rendering").
//
// `scripts/export_dungeon_tileset_indexed.py` emits, per tileset, an atlas
// whose pixel values are the game's own raw EHB palette index (0-63,
// `PieceBank.fromIndexedRGBA`'s domain) plus `palettes/dungeon-<tileset>-
// ramp<N>.json` for *every* ramp that tileset serves (`{colors:[{r,g,b},…]}`,
// 64 entries) — not just its primary one. `bcdfx` serves ramps 0 and 3, so a
// baked single-palette atlas is provably wrong for levels 12-13 (ramp 3).

/** One `palettes/dungeon-<tileset>-ramp<N>.json` file, parsed to `indicesToRGBA`'s `RGBAColor[]` shape (alpha is always opaque — this format carries no transparency of its own). */
export interface RampPaletteFile {
  colors: Array<{ r: number; g: number; b: number }>;
}

export function parseRampPalette(file: RampPaletteFile): RGBAColor[] {
  return file.colors.map(({ r, g, b }) => ({ r, g, b, a: 255 }));
}

/** The asset-relative path (under a game's `platform/` asset root) `export_dungeon_tileset_indexed.py` writes a tileset's accent-ramp palette to. Pure string convention — no filesystem/fetch access — so it's usable from Node, a browser, or a test alike. */
export function rampPalettePath(tileset: string, ramp: number): string {
  return `palettes/dungeon-${tileset}-ramp${ramp}.json`;
}

/** Same convention for the three indexed-atlas assets a tileset exports (index atlas, its opacity mask, and the shared atlas-frame sidecar). */
export function indexedTilesetPaths(tileset: string): { indexPng: string; maskPng: string; atlasJson: string } {
  return {
    indexPng: `textures/dungeon-${tileset}-indexed.png`,
    maskPng: `textures/dungeon-${tileset}-indexed-mask.png`,
    atlasJson: `textures/dungeon-${tileset}-indexed.json`,
  };
}

/** Which accent ramp to render `unit` under — `LevelUnit.paletteRamp`, defaulting to `0` for a unit that (e.g. a trimmed test fixture) doesn't carry one. This is the one-line policy the walker plan means by "pick the correct ramp for the current pose's level." */
export function paletteRampForUnit(unit: { paletteRamp?: number }): number {
  return unit.paletteRamp ?? 0;
}
