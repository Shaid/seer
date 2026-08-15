/**
 * Barrel re-export for @seer-project/probe's programmatic API.
 *
 * The pure analysis halves of each command are exported so tools and
 * tests can call them without touching the filesystem; the CLI wrappers
 * live behind bin/seer-probe.mjs.
 */
export { analyzeMap, renderMap, REGION_COLORS, type MapResult } from './map.js';
export {
  sweepGfx,
  renderContactSheet,
  renderCandidate,
  SWEEP_WIDTHS,
  type GfxCandidate,
  type GfxRangeResult,
  type GfxResult,
  type GfxSweepOptions,
} from './gfx.js';
export {
  analyzeStride,
  renderRecordGrid,
  stringGapHistogram,
  type StrideCandidate,
  type StrideResult,
} from './stride.js';
export {
  scanContainers,
  modSizeClosure,
  sweepAudio,
  sweepEncodings,
  decodePcm,
  spectrogram,
  fft,
  renderSpectrogramGrid,
  type AudioCandidate,
  type AudioResult,
  type AudioRangeResult,
  type ContainerHit,
  type PcmEncoding,
} from './audio.js';
export {
  parseCnf,
  auditCnf,
  dcxRatio,
  generateCnf,
  carveIslands,
  type AuditResult,
  type CnfFile,
  type DataIsland,
  type GeneratedCnf,
  type HunkCoverage,
} from './cnf.js';
export {
  tosecTitle,
  triageFile,
  triageDirectory,
  type TriageFileInfo,
  type TriageReport,
  type GroupSummary,
  type ExtSummary,
  type SlaveInfo,
  type TriageOptions,
} from './triage.js';
export {
  isZipFile,
  listZip,
  listZipFromSource,
  readZipEntry,
  readZipEntryFromSource,
  crc32,
  type ZipEntry,
} from './zip.js';
export { fileSource, bufferSource, type ByteSource } from './source.js';
export {
  classifyRegions,
  classifyWindows,
  classifyWindow,
  m68kOpcodeFraction,
  type Region,
  type RegionClass,
  type WindowInfo,
} from './classify.js';
export * from './score.js';
export { parseRange, rangesFromMapJson, resolveRanges, type ByteRange } from './range.js';
