/**
 * Barrel for `@seer-project/arcade` — the union of three unrelated arcade
 * hardware families. Each is also available on its own subpath, which is
 * what a single-family consumer should import:
 *
 *   `@seer-project/arcade/capcom`  CPS1/CPS2/CPS3 (incl. the SH-2 interpreter)
 *   `@seer-project/arcade/neogeo`  SNK Neo Geo
 *   `@seer-project/arcade/sega`    Sega System 16
 *
 * This root barrel re-exports all three so nothing that already imports from
 * the package root breaks; it exists for compatibility, not as the
 * recommended entry point.
 */
export { readMameZip } from './mame-zip.js';

export * from './capcom/index.js';
export * from './neogeo/index.js';
export * from './sega/index.js';
