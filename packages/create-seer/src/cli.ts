import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { input, confirm } from '@inquirer/prompts';
import { scaffold, capitalize } from './scaffold.ts';
import type { ScaffoldOptions } from './scaffold.ts';

export interface CliFlags {
  game?: string;
  platform?: string;
  displayName?: string;
  viewer?: boolean;
}

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  const args = argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--game' && args[i + 1]) { flags.game = args[++i]; continue; }
    if (args[i] === '--platform' && args[i + 1]) { flags.platform = args[++i]; continue; }
    if (args[i] === '--display-name' && args[i + 1]) { flags.displayName = args[++i]; continue; }
    if (args[i] === '--viewer') { flags.viewer = true; continue; }
  }
  return flags;
}

export async function promptOrFallback(question: string, opts: { default?: string; required?: boolean }, isTTY: boolean): Promise<string> {
  if (isTTY) return await input({ message: question, ...opts });
  return opts.default ?? '';
}

export async function confirmOrFallback(question: string, isTTY: boolean): Promise<boolean> {
  if (isTTY) return await confirm({ message: question, default: false });
  return false;
}

export async function main(argv: string[]): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const flags = parseFlags(argv);

  const projectName = argv[2];
  if (!projectName) {
    if (isTTY) {
      const name = await promptOrFallback('Project name', { required: true }, isTTY);
      if (!name) {
        console.error('Error: project name is required.');
        process.exit(1);
        return;
      }
    } else {
      console.error('Error: project name is required. Usage: npx create-seer <project-name> [options]');
      process.exit(1);
      return;
    }
  }

  const game = flags.game || await promptOrFallback('Game ID', { default: 'mygame' }, isTTY);
  const platform = flags.platform || await promptOrFallback('Platform ID', { default: 'amiga' }, isTTY);
  const displayName = flags.displayName || await promptOrFallback('Display name', { default: capitalize(game) }, isTTY);

  let viewer = flags.viewer;
  if (viewer === undefined) {
    viewer = await confirmOrFallback('Include asset viewer?', isTTY);
  }

  const targetDir = resolve(process.cwd(), projectName);
  if (existsSync(targetDir)) {
    console.error(`Error: ${targetDir} already exists.`);
    process.exit(1);
    return;
  }

  try {
    scaffold(targetDir, { game, platform, displayName, viewer } satisfies ScaffoldOptions);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}
