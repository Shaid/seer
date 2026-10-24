/**
 * `@seer-project/arcade/sega` — Sega System 16: tile/sprite decode, the
 * resistor-network palette weighting, and the uPD7759 ADPCM chip.
 *
 * A subpath, so a System 16 consumer does not pull Capcom's SH-2
 * interpreter and decrypt tables into its graph. Also re-exported from the
 * package root.
 */

export {
  Upd7759AdpcmState,
  UPD7759_SLAVE_PREAMBLE_BYTES,
  UPD7759_STANDARD_CLOCK,
  UPD7759_NATIVE_RATE,
  UPD7759_DEFAULT_GAIN,
  type Upd7759DecodeResult,
  decodeUpd7759Slave,
} from './upd7759-adpcm.js';
export {
  type DecodedTileSheet,
  decodeSega16Tiles8x8,
  decodeSega16Sprites4bpp,
  type RGB,
  computeResistorWeights,
  combineWeights,
  decodeSega16PaletteWord,
} from './system16-gfx.js';
