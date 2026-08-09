#!/usr/bin/env node
/**
 * create-seer-app — scaffold a seer project, or just its viewer or docs site.
 *
 * Run via: npm create seer-app <dir>
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const help = `Usage:
  npm create seer-app <project-name> [options]   scaffold a full project
  npm create seer-app viewer <dir> [options]     scaffold only the asset viewer
  npm create seer-app website <dir> [options]    scaffold only the docs site

Common options:
  --game <id>                 Game ID (default: mygame)
  --platform <id>             Platform ID (default: amiga) — project, viewer
  --display-name <name>       Human-readable game name

Project options:
  --viewer / --no-viewer      Include the asset viewer under tools/viewer
  --docs-site / --no-docs-site  Include the docs site under www

Website options:
  --description <text>        Site description (Starlight config + homepage tagline)
  --site <url>                Deployed site URL (default: blank)
  --site-dir <path>           Path used in the generated deploy workflow
  --favicon-frame <name>      Sprite atlas frame to use as the favicon
  --favicon-atlas-dir <dir>   Atlas directory under public/assets/<game>/
  --favicon-manifest <file>   Manifest filename under the atlas directory

Flags may appear before or after the target directory.

Examples:
  npm create seer-app my-rpg --game myrpg --viewer --docs-site
  npm create seer-app website www --game zonx --site https://zonx.example
  npm create seer-app viewer tools/viewer --game zonx --platform amiga`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(help);
  process.exit(0);
}

const distEntry = resolve(__dirname, '../dist/cli.js');
if (!existsSync(distEntry)) {
  console.error(
    'create-seer-app: dist/cli.js not found. Run `npm run build` in packages/create-seer-app ' +
      '(or `npm run build:packages` from the repo root) before invoking this script directly.',
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(distEntry).href);

main(process.argv).catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
