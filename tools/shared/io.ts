/**
 * Re-export pipeline I/O utilities for backward compatibility.
 * Prefer importing from '@seer/pipeline' directly in new code.
 */
export {
  readBinary,
  writePNG,
  writeIndexedPNG,
  writeJson,
  resolveDataFile,
  scanFilesByExtension,
} from '@seer/pipeline';
