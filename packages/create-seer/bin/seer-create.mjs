#!/usr/bin/env node
/**
 * create-seer — scaffold a new seer project.
 *
 * Run via: npx create-seer <project-name>
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const help = `Usage: npx create-seer <project-name> [options]

Options:
  --game <id>          Game ID (default: mygame)
  --platform <id>      Platform ID (default: amiga)
  --display-name <n>   Human-readable game name
  --viewer             Include the asset viewer tool
  --docs-site          Include the Astro + Starlight docs site

Example:
  npx create-seer my-rpg --game myrpg --platform amiga --viewer --docs-site`;

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
