import { resolve } from 'node:path';
import { input } from '@inquirer/prompts';
import { scaffoldWebsite, capitalize } from './scaffold.ts';
import type { WebsiteContext } from './scaffold.ts';

export interface CliFlags {
  game?: string;
  displayName?: string;
  description?: string;
  site?: string;
  faviconFrame?: string;
  faviconAtlasDir?: string;
  faviconManifest?: string;
}

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  const args = argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--game' && args[i + 1]) { flags.game = args[++i]; continue; }
    if (args[i] === '--display-name' && args[i + 1]) { flags.displayName = args[++i]; continue; }
    if (args[i] === '--description' && args[i + 1]) { flags.description = args[++i]; continue; }
    if (args[i] === '--site' && args[i + 1]) { flags.site = args[++i]; continue; }
    if (args[i] === '--favicon-frame' && args[i + 1]) { flags.faviconFrame = args[++i]; continue; }
    if (args[i] === '--favicon-atlas-dir' && args[i + 1]) { flags.faviconAtlasDir = args[++i]; continue; }
    if (args[i] === '--favicon-manifest' && args[i + 1]) { flags.faviconManifest = args[++i]; continue; }
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
      console.error('Error: target directory is required. Usage: npx create-seer-website <dir> [options]');
      process.exit(1);
      return;
    }
  }

  const game = flags.game || await promptOrFallback('Game ID', { default: 'mygame' }, isTTY);
  const displayName = flags.displayName || await promptOrFallback('Display name', { default: capitalize(game) }, isTTY);
  const description = flags.description || await promptOrFallback(
    'Site description',
    { default: `A reverse-engineering field guide to ${displayName}.` },
    isTTY,
  );
  const site = flags.site || await promptOrFallback('Deployed site URL (leave blank if unknown)', { default: '' }, isTTY);

  const targetDir = resolve(process.cwd(), targetArg ?? '.');

  try {
    scaffoldWebsite(targetDir, {
      game,
      displayName,
      description,
      site,
      faviconFrame: flags.faviconFrame,
      faviconAtlasDir: flags.faviconAtlasDir,
      faviconManifest: flags.faviconManifest,
    } satisfies WebsiteContext);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}
