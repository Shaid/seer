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

export { hexDump } from './hex-dump.js';

export { decompressLZEXE, type LZEXEResult } from './lzexe.js';

export {
  type ShardableEntry,
  type GroupIndexEntry,
  type CategoryIndexEntry,
  writeShardedManifest,
} from './manifest-sharding.js';
