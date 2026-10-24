/**
 * `@seer-project/arcade/capcom` — Capcom CPS1/CPS2/CPS3 hardware: tile and
 * palette decode, ROM region assembly, the CPS2 and CPS3 decryption, the
 * OKI/QSound audio chips and the CPS2 QSound sequence driver, plus the SH-2
 * interpreter CPS3 runs on.
 *
 * A subpath, so a Neo Geo or System 16 consumer does not pull 1188 lines of
 * SH-2 interpreter and the CPS decrypt tables into its graph. Everything
 * here is also re-exported from the package root for compatibility.
 */

export {
  type GfxLayout,
  CPS1_LAYOUT_16X16,
  CPS1_LAYOUT_8X8,
  CPS1_LAYOUT_8X8_2,
  CPS1_LAYOUT_32X32,
  cps2ScrollBankMap,
  cps2SpriteCode,
  scroll1GfxSetForColumn,
  decodeTile,
  tileCount,
  cps2UnshuffleGfx,
} from './gfx.js';
export {
  type Rgb,
  decodeCps1PaletteWord,
  decodeCps1PaletteWords,
  decodeCps1PaletteWordsForced,
  type CpsPaletteCopySite,
  scanCpsPaletteCopySites,
  scanCps2PaletteBankSites,
} from './palette.js';
export {
  swapWordBytes,
  loadWordSwapped,
  interleaveWords,
  allocRegion,
} from './rom-regions.js';
export {
  type Cps2KeyInfo,
  decodeCps2Key20,
  decodeCps2Key8,
  cps2Decrypt,
} from './decrypt.js';
export {
  cps3Mask,
  cps3DecryptProgram,
  assembleCps3User5,
  CPS3_DMA_XOR,
  Cps3CharDma,
} from './cps3.js';
export {
  Sh2,
  SR_T,
  SR_S,
  SR_I,
  SR_Q,
  SR_M,
  SR_FLAGS,
  IRQ_HOLD,
  IRQ_ACK,
  IRQ_NONE,
  type Sh2Bus,
} from './sh2.js';
export {
  OkiAdpcmState,
  decodeOkiAdpcm,
  CPS1_OKI_SAMPLE_RATE,
  CPS1_OKI_GAIN,
  type OkiPhrase,
  parseOkiPhraseTable,
} from './oki-adpcm.js';
export {
  decodeQsoundSample,
  decodeQsoundPcm,
  QSOUND_REG,
  QSOUND_PORT,
} from './qsound.js';
export {
  type QsoundNoteRecord,
  parseQsoundNoteTable,
  readQsoundNoteTableBase,
  qsoundNoteByteRange,
  type QsoundEnvelopeDispatchEntry,
  parseQsoundEnvelopeDispatch,
  type Cps2SongPointer,
  resolveCps2SeqTableLength,
  parseCps2SeqTable,
  type Cps2SeqHeader,
  parseCps2SeqHeader,
  type Cps2TrackEvent,
  type Cps2TrackDecodeResult,
  decodeCps2TrackV1,
  type QsoundSampleInfoRecord,
  parseQsoundSampleInfoTable,
  type Cps2InstrumentV115,
  cps2InstrumentAddressV115,
  parseCps2InstrumentV115,
  CPS2_DRIVER_RATE_HZ,
  CPS2_PPQN,
  cps2TempoToSecondsPerTick,
  CPS2_DEFAULT_SECONDS_PER_TICK,
  type Cps2EnvelopeRateTables,
  parseCps2EnvelopeRateTables,
  type Cps2EnvelopeTimes,
  computeCps2EnvelopeTimes,
  type Cps2PitchTables,
  parseCps2PitchTables,
  clampCps2PitchIndex,
  computeCps2PitchDelta,
} from './qsound-driver.js';
