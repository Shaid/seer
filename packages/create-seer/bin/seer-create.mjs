#!/usr/bin/env node
/**
 * create-seer — scaffold a new seer project.
 *
 * Run via: npx create-seer <project-name>
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scaffoldPath = pathToFileURL(resolve(__dirname, '../src/scaffold.ts')).href;
const { scaffold } = await import(scaffoldPath);

const projectName = process.argv[2];
if (!projectName || projectName === '--help' || projectName === '-h') {
  console.log(`Usage: npx create-seer <project-name> [options]

Options:
  --game <id>          Game ID (default: mygame)
  --platform <id>      Platform ID (default: amiga)
  --display-name <n>   Human-readable game name
  --viewer             Include the asset viewer tool

Example:
  npx create-seer my-rpg --game myrpg --platform amiga --viewer`);
  process.exit(0);
}

// Parse optional flags
let game;
let platform;
let displayName;
let viewer = false;
const args = process.argv.slice(3);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--game' && args[i + 1]) game = args[++i];
  else if (args[i] === '--platform' && args[i + 1]) platform = args[++i];
  else if (args[i] === '--display-name' && args[i + 1]) displayName = args[++i];
  else if (args[i] === '--viewer') viewer = true;
}

const targetDir = resolve(process.cwd(), projectName);
if (existsSync(targetDir)) {
  console.error(`Error: ${targetDir} already exists.`);
  process.exit(1);
}

try {
  scaffold(targetDir, { game, platform, displayName, viewer });
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
