#!/usr/bin/env node
/**
 * seer-probe CLI entry point.
 *
 * Run via: npx seer-probe <command> [options]
 * Or directly: node packages/probe/bin/seer-probe.mjs <command>
 *
 * Delegates everything to the compiled packages/probe/dist/cli.js which
 * contains the real logic.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, '../dist/cli.js');
if (!existsSync(distEntry)) {
  console.error(
    'seer-probe: dist/cli.js not found. Run `npm run build` in packages/probe ' +
      '(or `npm run build:packages` from the repo root) before invoking this script directly.',
  );
  process.exit(1);
}

const cli = await import(pathToFileURL(distEntry).href);
process.exitCode = await cli.main(process.argv.slice(2));
