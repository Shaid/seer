#!/usr/bin/env node
/**
 * create-seer-website — scaffold a standalone seer docs site.
 *
 * Run via: npx create-seer-website <dir>
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const help = `Usage: npx create-seer-website <dir> [options]

Options:
  --game <id>                Game ID (default: mygame)
  --display-name <n>         Human-readable game name
  --description <text>       Site description (Starlight config + homepage tagline)
  --site <url>                Deployed site URL (default: blank)
  --favicon-frame <name>      Sprite atlas frame name to use as the favicon
  --favicon-atlas-dir <dir>   Atlas directory (under public/assets/<game>/) containing the favicon frame
  --favicon-manifest <file>   Manifest filename (under favicon-atlas-dir) containing the favicon frame

Example:
  npx create-seer-website www --game myrpg --display-name "My RPG"`;

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
