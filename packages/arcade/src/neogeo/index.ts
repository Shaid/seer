/**
 * `@seer-project/arcade/neogeo` — SNK Neo Geo: sprite/fix tile decode, the
 * CMC42/CMC50 graphics and S-fix decryption, and palette decode.
 *
 * A subpath, so a Neo Geo consumer does not pull Capcom's SH-2 interpreter
 * and decrypt tables into its graph. Also re-exported from the package root.
 */

export {
  decodeNeogeoSpriteTile,
  decodeNeogeoFixTile,
  neogeoSpriteTileCount,
  neogeoFixTileCount,
} from './gfx.js';
export { cmcGfxDecrypt, sfixDecrypt } from './cmc.js';
export {
  NEOGEO_PALETTE_SIZE,
  NEOGEO_PALETTE_BASE,
  decodeNeoGeoPaletteWord,
  decodeNeoGeoPaletteWords,
  scanNeoGeoPaletteBanks,
} from './palette.js';
