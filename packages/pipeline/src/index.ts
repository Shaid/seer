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
} from './config.ts';

export {
  type PipelineResult,
  runPipeline,
} from './pipeline.ts';

export {
  readBinary,
  writePNG,
  writeIndexedPNG,
  writeWav,
  writeJson,
  resolveDataFile,
  scanFilesByExtension,
} from './io.ts';

export { hexDump } from './hex-dump.ts';

export { decompressLZEXE, type LZEXEResult } from './lzexe.ts';

export {
  type ShardableEntry,
  type GroupIndexEntry,
  type CategoryIndexEntry,
  writeShardedManifest,
} from './manifest-sharding.ts';
