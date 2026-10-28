export {
  type PlatformConfig,
  type GameConfig,
  defineGameConfig,
  getPlatformConfig,
  getAllSupportedPlatforms,
  getGameConfig,
  getSupportedPlatforms,
  flattenConfigs,
  resType,
  findFileCI,
  resolveDataDir,
} from './config.js';

export { type PipelineResult, runPipeline } from './pipeline.js';

export {
  readBinary,
  writePNG,
  writeIndexedPNG,
  writeWav,
  writeJson,
  resolveDataFile,
  scanFilesByExtension,
} from './io.js';

export { type Checkpoint, type CheckpointOptions, openCheckpoint } from './checkpoint.js';

export { hexDump } from './hex-dump.js';

export { decompressLZEXE, type LZEXEResult } from './lzexe.js';

export {
  type AncientContainer,
  type AncientDecompressOptions,
  detectAncientContainer,
  ancientDecompress,
  ancientDecompressFile,
  decompressRnc1,
  decompressRnc2,
  decrunchRenamedPp20,
} from './ancient.js';

export { writeShardedManifest } from './manifest-sharding.js';

export {
  readDecoderStamps,
  readDecoderStamp,
  manifestStampMatches,
  recordDecoderStamp,
} from './decoder-stamp.js';

// Also reachable on its own as `@seer-project/pipeline/manifest-types` —
// which is what a *browser* viewer has to import, since this barrel reaches
// `node:fs` through `config.js`, `io.js` and the sharder itself.
export {
  GROUP_SHARD_THRESHOLD,
  DECODER_STAMP_FILE,
  type ShardableEntry,
  type GroupIndexEntry,
  type CategoryIndexEntry,
  type DecoderStampFile,
} from './manifest-types.js';
