/**
 * Barrel re-export for @seer-project/gfx.
 *
 * Browser-safe, zero-dependency planar bitmap decoding. The current
 * surface is the Amiga/Atari-ST slice of docs/common-tooling-candidates.md
 * §1; ST-specific, SNES, Megadrive and EGA decoders join when a consumer
 * needs them.
 */
export * from './planar.js';
export * from './palette.js';
export * from './rgba.js';
