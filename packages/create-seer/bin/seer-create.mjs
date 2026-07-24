#!/usr/bin/env node
/**
 * create-seer — scaffold a new seer project.
 *
 * Run via: npx create-seer <project-name>
 */
import 'tsx/esm';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { input, confirm } from '@inquirer/prompts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scaffoldPath = pathToFileURL(resolve(__dirname, '../src/scaffold.ts')).href;
const { scaffold, capitalize } = await import(scaffoldPath);

const isTTY = process.stdout.isTTY;

function showHelp() {
  console.log(`Usage: npx create-seer <project-name> [options]

Options:
  --game <id>          Game ID (default: mygame)
  --platform <id>      Platform ID (default: amiga)
  --display-name <n>   Human-readable game name
  --viewer             Include the asset viewer tool

Example:
  npx create-seer my-rpg --game myrpg --platform amiga --viewer`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showHelp();
  process.exit(0);
}

function parseFlags() {
  const flags = {};
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--game' && args[i + 1]) { flags.game = args[++i]; continue; }
    if (args[i] === '--platform' && args[i + 1]) { flags.platform = args[++i]; continue; }
    if (args[i] === '--display-name' && args[i + 1]) { flags.displayName = args[++i]; continue; }
    if (args[i] === '--viewer') { flags.viewer = true; continue; }
  }
  return flags;
}

async function promptOrFallback(question, opts) {
  if (isTTY) return await input({ message: question, ...opts });
  return opts.default ?? '';
}

async function main() {
  const flags = parseFlags();

  const projectName = process.argv[2];
  if (!projectName) {
    if (isTTY) {
      const name = await promptOrFallback('Project name', { required: true });
      if (!name) {
        console.error('Error: project name is required.');
        process.exit(1);
      }
    } else {
      console.error('Error: project name is required. Usage: npx create-seer <project-name> [options]');
      process.exit(1);
    }
  }

  const game = flags.game || await promptOrFallback('Game ID', { default: 'mygame' });
  const platform = flags.platform || await promptOrFallback('Platform ID', { default: 'amiga' });
  const displayName = flags.displayName || await promptOrFallback('Display name', { default: capitalize(game) });

  let viewer = flags.viewer;
  if (viewer === undefined) {
    viewer = isTTY ? await confirm({ message: 'Include asset viewer?', default: false }) : false;
  }

  const targetDir = resolve(process.cwd(), projectName);
  if (existsSync(targetDir)) {
    console.error(`Error: ${targetDir} already exists.`);
    process.exit(1);
  }

  try {
    scaffold(targetDir, { game, platform, displayName, viewer });
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}

main();
