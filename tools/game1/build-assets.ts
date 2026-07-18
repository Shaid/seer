/**
 * build-assets.ts — Stage 2 template: decode resource files into web-native
 * PNG + JSON assets under public/assets/<game>/<platform>/.
 *
 * Invoked by tools/extract-game-data.ts as:
 *   npx tsx tools/game1/build-assets.ts <resolvedDataDir>
 *
 * Replace the body with calls to your own format decoders (bitmap, palette,
 * sprite-sheet, level/map data, etc — see docs/architecture-overview.md §6-7).
 * `tools/shared/io.ts` has generic PNG/JSON writers you can reuse regardless
 * of what container/bitmap format you end up decoding.
 */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeJson } from '../shared/io.ts';
import { getGameConfig } from '../shared/game-config.ts';

function main() {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error('Usage: npx tsx tools/game1/build-assets.ts <dataDir>');
    process.exit(1);
  }

  const config = getGameConfig('game1', 'platform1');
  if (!config) throw new Error('Missing game1/platform1 config in game-config.ts');

  const outDir = resolve('public/assets', config.assetDir, config.platform);
  mkdirSync(outDir, { recursive: true });

  console.log(`(template) would decode assets from ${dataDir} into ${outDir}`);

  // TODO: decode your bitmap/sprite/level formats here and write real output,
  // e.g. writePNG(resolve(outDir, 'atlas.png'), rgba, width, height).
  writeJson(resolve(outDir, 'atlas.json'), {
    imageUrl: `/assets/${config.assetDir}/${config.platform}/atlas.png`,
    cellWidth: 16,
    cellHeight: 16,
    columns: 1,
    rows: 1,
  });

  console.log(`Wrote placeholder manifest to ${outDir}`);
}

main();
