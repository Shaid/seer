/**
 * export-game-data.ts — Stage 1 template: parse the game executable/data
 * tables and write raw JSON to data/extracted/<game>/.
 *
 * Invoked by tools/extract-game-data.ts as:
 *   npx tsx tools/game1/export-game-data.ts <resolvedDataDir>
 *
 * Replace the body of `main()` with your actual reverse-engineered table
 * parsing once you've identified the executable's data layout (via
 * disassembly, hex-dump.ts inspection, etc).
 */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readBinary, writeJson } from '@seer-project/pipeline';
import { BinaryReader } from '@seer-project/core';

function main() {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error('Usage: npx tsx tools/game1/export-game-data.ts <dataDir>');
    process.exit(1);
  }

  // TODO: replace 'GAME.EXE' with your actual executable filename, and parse
  // its data tables using BinaryReader / your own format decoders below.
  const exePath = resolve(dataDir, 'GAME.EXE');
  const bytes = readBinary(exePath);
  const reader = new BinaryReader(bytes.buffer as ArrayBuffer);
  console.log(`(template) read ${reader.length} bytes from ${exePath}`);

  const outDir = resolve('data/extracted/game1');
  mkdirSync(outDir, { recursive: true });

  // TODO: replace with real extracted tables (entities, items, levels, etc).
  writeJson(resolve(outDir, 'entities.json'), []);

  console.log(`Wrote placeholder output to ${outDir}`);
}

main();
