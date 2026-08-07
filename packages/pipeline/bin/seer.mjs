#!/usr/bin/env node
/**
 * seer CLI entry point.
 *
 * Run via: npx seer <command> [options]
 * Or directly: node packages/pipeline/bin/seer.mjs <command>
 *
 * Delegates everything to the compiled packages/pipeline/dist/cli.js which
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
    'seer: dist/cli.js not found. Run `npm run build` in packages/pipeline ' +
      '(or `npm run build:packages` from the repo root) before invoking this script directly.',
  );
  process.exit(1);
}

const cliPath = pathToFileURL(distEntry).href;

const cli = await import(cliPath);

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h') {
  cli.printUsage();
  process.exit(0);
}

try {
  switch (command) {
    case 'hex-dump':
      cli.cmdHexDump(args.slice(1));
      break;
    case 'extract': {
      const { game, platform, dataDir } = cli.parseArgs(process.argv);
      const configs = await cli.loadConfig(process.cwd());
      await cli.cmdExtract(configs, game, platform, dataDir);
      break;
    }
    case 'doctor': {
      const { dataDir } = cli.parseArgs(process.argv);
      const configs = await cli.loadConfig(process.cwd());
      cli.cmdDoctor(configs, dataDir);
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      cli.printUsage();
      process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
