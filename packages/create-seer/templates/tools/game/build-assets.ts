/**
 * Stage 2: decode resource files -> web-native PNG + JSON.
 * Replace the body with your format decoders.
 */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeJson } from '@seer/pipeline';
import { getGameConfig } from '../shared/game-config.ts';

function main() {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error('Usage: npx tsx tools/<%= it.game %>/build-assets.ts <dataDir>');
    process.exit(1);
  }

  const config = getGameConfig('<%= it.game %>', '<%= it.platform %>');
  if (!config) throw new Error('Missing <%= it.game %>/<%= it.platform %> config');

  const outDir = resolve('public/assets', config.assetDir, config.platform);
  mkdirSync(outDir, { recursive: true });

  writeJson(resolve(outDir, "atlas.json"), {
    imageUrl: "/assets/" + config.assetDir + "/" + config.platform + "/atlas.png",
    cellWidth: 16,
    cellHeight: 16,
    columns: 1,
    rows: 1,
  });

  console.log("Wrote placeholder manifest to " + outDir);
}

main();
