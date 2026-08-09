/**
 * create-seer-app CLI.
 *
 *   create-seer-app <dir>            full project
 *   create-seer-app viewer <dir>     just the asset viewer
 *   create-seer-app website <dir>    just the docs site
 *
 * Everything is flag-driven so it works non-interactively (CI, scripts); the
 * prompts are a convenience when stdout is a TTY, not the only path.
 */
import { resolve } from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import { scaffold } from './project.js';
import { scaffoldViewer } from './viewer.js';
import { scaffoldWebsite } from './website.js';
import { capitalize } from './render.js';

export type Mode = 'project' | 'viewer' | 'website';

/** Long-flag name -> the CliFlags key it fills. */
const FLAG_KEYS = {
  '--game': 'game',
  '--platform': 'platform',
  '--display-name': 'displayName',
  '--description': 'description',
  '--site': 'site',
  '--favicon-frame': 'faviconFrame',
  '--favicon-atlas-dir': 'faviconAtlasDir',
  '--favicon-manifest': 'faviconManifest',
  '--site-dir': 'siteDir',
} as const;

/** Flags that take no value. */
const BOOLEAN_FLAGS = {
  '--viewer': 'viewer',
  '--no-viewer': 'viewer',
  '--docs-site': 'docsSite',
  '--no-docs-site': 'docsSite',
} as const;

export interface CliFlags {
  game?: string;
  platform?: string;
  displayName?: string;
  description?: string;
  site?: string;
  faviconFrame?: string;
  faviconAtlasDir?: string;
  faviconManifest?: string;
  siteDir?: string;
  viewer?: boolean;
  docsSite?: boolean;
}

export interface ParsedArgs {
  mode: Mode;
  targetDir?: string;
  flags: CliFlags;
  unknown: string[];
}

/**
 * Parse `[mode] [dir]` and flags in a single pass.
 *
 * Deliberately order-insensitive: the previous implementation sliced argv at a
 * fixed index, so `--game foo mydir` parsed no flags at all *and* treated
 * `--game` as the target directory name.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: CliFlags = {};
  const positionals: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg in BOOLEAN_FLAGS) {
      flags[BOOLEAN_FLAGS[arg as keyof typeof BOOLEAN_FLAGS]] = !arg.startsWith('--no-');
      continue;
    }

    if (arg in FLAG_KEYS) {
      const value = args[i + 1];
      // A flag whose value is missing, or is itself the next flag, is a
      // mistake worth surfacing rather than silently dropping.
      if (value === undefined || value.startsWith('--')) {
        unknown.push(`${arg} (missing value)`);
        continue;
      }
      flags[FLAG_KEYS[arg as keyof typeof FLAG_KEYS]] = value;
      i++;
      continue;
    }

    if (arg.startsWith('-')) {
      unknown.push(arg);
      continue;
    }

    positionals.push(arg);
  }

  const mode: Mode =
    positionals[0] === 'viewer' ? 'viewer' : positionals[0] === 'website' ? 'website' : 'project';
  const targetDir = mode === 'project' ? positionals[0] : positionals[1];

  return { mode, targetDir, flags, unknown };
}

async function ask(
  question: string,
  opts: { default?: string; required?: boolean },
  isTTY: boolean,
): Promise<string> {
  if (!isTTY) return opts.default ?? '';
  return await input({ message: question, ...opts });
}

async function askYesNo(question: string, fallback: boolean, isTTY: boolean): Promise<boolean> {
  if (!isTTY) return fallback;
  return await confirm({ message: question, default: fallback });
}

const USAGE: Record<Mode, string> = {
  project: 'create-seer-app <project-name> [options]',
  viewer: 'create-seer-app viewer <dir> [options]',
  website: 'create-seer-app website <dir> [options]',
};

const PROMPT: Record<Mode, string> = {
  project: 'Project name',
  viewer: 'Viewer directory',
  website: 'Site directory',
};

export async function main(argv: string[]): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const { mode, targetDir: targetArg, flags, unknown } = parseArgs(argv);

  if (unknown.length) {
    console.error(`Error: unrecognised argument(s): ${unknown.join(', ')}`);
    console.error(`Usage: ${USAGE[mode]}`);
    process.exit(1);
    return;
  }

  // Prompting for the target directory then ignoring the answer is exactly the
  // bug this replaced: all three previous CLIs validated the prompted name and
  // then resolved the *unset* argv value, scaffolding into the cwd (or, in one
  // case, throwing on `resolve(cwd, undefined)`). Keep the answer.
  let targetDir = targetArg;
  if (!targetDir) {
    if (!isTTY) {
      console.error(`Error: target directory is required. Usage: ${USAGE[mode]}`);
      process.exit(1);
      return;
    }
    targetDir = (await ask(PROMPT[mode], { required: true }, isTTY)).trim();
    if (!targetDir) {
      console.error('Error: target directory is required.');
      process.exit(1);
      return;
    }
  }

  const resolved = resolve(process.cwd(), targetDir);

  try {
    if (mode === 'viewer') {
      const game = flags.game || (await ask('Game ID', { default: 'mygame' }, isTTY));
      const platform = flags.platform || (await ask('Platform ID', { default: 'amiga' }, isTTY));
      const displayName =
        flags.displayName || (await ask('Display name', { default: capitalize(game) }, isTTY));
      scaffoldViewer(resolved, { game, platform, displayName });
      return;
    }

    if (mode === 'website') {
      const game = flags.game || (await ask('Game ID', { default: 'mygame' }, isTTY));
      const displayName =
        flags.displayName || (await ask('Display name', { default: capitalize(game) }, isTTY));
      const description =
        flags.description ||
        (await ask(
          'Site description',
          { default: `A reverse-engineering field guide to ${displayName}.` },
          isTTY,
        ));
      const site =
        flags.site ||
        (await ask('Deployed site URL (leave blank if unknown)', { default: '' }, isTTY));
      scaffoldWebsite(resolved, {
        game,
        displayName,
        description,
        site,
        faviconFrame: flags.faviconFrame,
        faviconAtlasDir: flags.faviconAtlasDir,
        faviconManifest: flags.faviconManifest,
        siteDir: flags.siteDir,
      });
      return;
    }

    const game = flags.game || (await ask('Game ID', { default: 'mygame' }, isTTY));
    const platform = flags.platform || (await ask('Platform ID', { default: 'amiga' }, isTTY));
    const displayName =
      flags.displayName || (await ask('Display name', { default: capitalize(game) }, isTTY));
    const viewer = flags.viewer ?? (await askYesNo('Include asset viewer?', false, isTTY));
    const docsSite = flags.docsSite ?? (await askYesNo('Include docs site?', false, isTTY));

    scaffold(resolved, { game, platform, displayName, viewer, docsSite });
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}
