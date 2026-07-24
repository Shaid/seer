/**
 * Stage 1: parse game executable/data tables -> JSON.
 * Replace the body with your reverse-engineered parsing.
 */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeJson } from '@seer/pipeline';

function main() {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error('Usage: npx tsx tools/<%= it.game %>/export-game-data.ts <dataDir>');
    process.exit(1);
  }

  // TODO: parse your game data tables here.
  const outDir = resolve('data/extracted/<%= it.game %>');
  mkdirSync(outDir, { recursive: true });
  writeJson(resolve(outDir, 'entities.json'), []);
  console.log("Wrote placeholder output to " + outDir);
}

main();
