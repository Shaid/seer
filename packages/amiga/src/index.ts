/**
 * Barrel re-export for @seer-project/amiga.
 *
 * The current surface is HUNK executable/module parsing plus a synthetic
 * builder for test fixtures — the slice of docs/common-tooling-candidates.md
 * §9 that has consumers today. Overlay files and HUNK_EXT link data join
 * when a consumer needs them.
 */
export * from './hunk.js';
export * from './build.js';
export * from './adf.js';
export * from './whdload.js';
export * from './lha.js';
