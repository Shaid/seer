import { resolve } from 'node:path';
import { input } from '@inquirer/prompts';
import { scaffoldViewer, capitalize } from './scaffold.ts';
import type { ViewerContext } from './scaffold.ts';

export interface CliFlags {
  game?: string;
  platform?: string;
  displayName?: string;
}

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  const args = argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--game' && args[i + 1]) { flags.game = args[++i]; continue; }
    if (args[i] === '--platform' && args[i + 1]) { flags.platform = args[++i]; continue; }
    if (args[i] === '--display-name' && args[i + 1]) { flags.displayName = args[++i]; continue; }
  }
  return flags;
}

export async function promptOrFallback(question: string, opts: { default?: string; required?: boolean }, isTTY: boolean): Promise<string> {
  if (isTTY) return await input({ message: question, ...opts });
  return opts.default ?? '';
}

export async function main(argv: string[]): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const flags = parseFlags(argv);

  const targetArg = argv[2];
  if (!targetArg) {
    if (isTTY) {
      const name = await promptOrFallback('Target directory', { required: true }, isTTY);
      if (!name) {
        console.error('Error: target directory is required.');
        process.exit(1);
        return;
      }
    } else {
      console.error('Error: target directory is required. Usage: npx create-seer-viewer <dir> [options]');
      process.exit(1);
      return;
    }
  }

  const game = flags.game || await promptOrFallback('Game ID', { default: 'mygame' }, isTTY);
  const platform = flags.platform || await promptOrFallback('Platform ID', { default: 'amiga' }, isTTY);
  const displayName = flags.displayName || await promptOrFallback('Display name', { default: capitalize(game) }, isTTY);

  const targetDir = resolve(process.cwd(), targetArg ?? '.');

  try {
    scaffoldViewer(targetDir, { game, platform, displayName } satisfies ViewerContext);
    console.log('Scaffolded asset viewer at ' + targetDir);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}
