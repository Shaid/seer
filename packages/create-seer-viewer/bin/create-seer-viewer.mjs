#!/usr/bin/env node
/**
 * create-seer-viewer — scaffold a standalone seer asset viewer.
 *
 * Run via: npx create-seer-viewer <dir>
 */
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

const cliPath = pathToFileURL(resolve(__dirname, '../dist/cli.js')).href;
const { main } = await import(cliPath);

main(process.argv).catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
