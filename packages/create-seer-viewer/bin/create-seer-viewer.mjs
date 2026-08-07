#!/usr/bin/env node
/**
 * create-seer-viewer — scaffold a standalone seer asset viewer.
 *
 * Run via: npx create-seer-viewer <dir>
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const help = `Usage: npx create-seer-viewer <dir> [options]

Options:
  --game <id>          Game ID (default: mygame)
  --platform <id>      Platform ID (default: amiga)
  --display-name <n>   Human-readable game name

Example:
  npx create-seer-viewer tools/viewer --game myrpg --platform amiga`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(help);
  process.exit(0);
}

const distEntry = resolve(__dirname, '../dist/cli.js');
if (!existsSync(distEntry)) {
  console.error(
    'create-seer-viewer: dist/cli.js not found. Run `npm run build` in packages/create-seer-viewer ' +
      '(or `npm run build:packages` from the repo root) before invoking this script directly.',
  );
  process.exit(1);
}

const cliPath = pathToFileURL(distEntry).href;
const { main } = await import(cliPath);

main(process.argv).catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
