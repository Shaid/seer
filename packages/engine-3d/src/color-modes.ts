import * as THREE from 'three';

/**
 * The four ways a polygon model's faces can be tinted. `'palette'` and
 * `'face'` need per-face data (a raw fill word, a face index) that only a
 * `PolygonModel` carries — a glTF mesh's real material/vertex colors are
 * already meaningful, so this package doesn't offer a way to override them
 * with a color mode (see `polygon.ts`'s `recolorPolygonModel`, the only
 * function in the package that ever applies one of these to real geometry —
 * it only ever touches a model's `polygon` data).
 */
export type ColorMode = 'palette' | 'face' | 'object' | 'height';

/** The Y range `'height'` mode maps to its hue gradient. Derived from a model's own bounding box rather than a hardcoded constant (hunter's original `±2000`). */
export interface HeightRange {
  min: number;
  max: number;
}

export interface ColorResolverContext {
  objectId: number;
  faceIndex: number;
  fill: number;
  y: number;
  /** Only consulted by `'height'` mode. Falls back to a fixed `±2000` range (hunter's original hardcoded constant) if omitted. */
  heightRange?: HeightRange;
}

/**
 * Resolves a raw per-game `fill` word to a color — the injection point the
 * original engine-3d proposal called for. A host's own palette/decode logic
 * (e.g. hunter's `PALETTE` array + its `fillToColor` bit-decode) never
 * enters this package; it's supplied via `createPaletteResolver` instead.
 */
export type ColorResolver = (ctx: ColorResolverContext) => THREE.Color;

/**
 * Builds a `ColorResolver` for `'palette'` mode from a caller-owned flat
 * palette (RGB `0xRRGGBB` entries) and a function extracting a palette index
 * out of a face's raw `fill` word. Generalizes hunter's
 * `fillToColor` (`viewer.ts:242-246`): `createPaletteResolver(PALETTE, f => (f>>8)&0xf)`
 * reproduces it exactly, with nothing Amiga-specific inside this package.
 */
export function createPaletteResolver(
  palette: readonly number[],
  decodeIndex: (fill: number) => number,
): ColorResolver {
  return (ctx) => {
    if (palette.length === 0) return new THREE.Color(FALLBACK_HEX);
    const raw = decodeIndex(ctx.fill);
    // Wrap negative/over-range indices into range rather than throwing —
    // a garbage fill word should render *something*, not crash the viewer.
    const idx = ((raw % palette.length) + palette.length) % palette.length;
    return new THREE.Color(palette[idx] ?? FALLBACK_HEX);
  };
}

const FALLBACK_HEX = 0x888888;
const DEFAULT_HEIGHT_RANGE: HeightRange = { min: -2000, max: 2000 };

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

/**
 * Resolves one face/vertex's color for `mode`, matching hunter's
 * `getColor3D` (`viewer.ts:248-257`) formula-for-formula for `'face'`/
 * `'object'`/`'height'`. `'palette'` mode defers entirely to `resolver`
 * (falling back to a flat grey if none was supplied, rather than throwing —
 * a model with no injected palette should still render, just uncolored).
 */
export function resolveColor(
  mode: ColorMode,
  ctx: ColorResolverContext,
  resolver?: ColorResolver,
): THREE.Color {
  switch (mode) {
    case 'palette':
      return resolver ? resolver(ctx) : new THREE.Color(FALLBACK_HEX);
    case 'face':
      return new THREE.Color().setHSL((ctx.faceIndex * 0.0618) % 1, 0.7, 0.5);
    case 'object':
      return new THREE.Color().setHSL((ctx.objectId * 0.0137) % 1, 0.6, 0.45);
    case 'height': {
      const range = ctx.heightRange ?? DEFAULT_HEIGHT_RANGE;
      const span = range.max - range.min;
      const t = span > 0 ? clamp01((ctx.y - range.min) / span) : 0.5;
      return new THREE.Color().setHSL(0.6 - t * 0.4, 0.8, 0.4 + t * 0.3);
    }
    default:
      return new THREE.Color(FALLBACK_HEX);
  }
}
