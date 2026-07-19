/**
 * seer CLI — entry point and subcommand implementations.
 *
 * Designed to be imported by `bin/seer.mjs` (the bin shim) and unit-tested
 * directly. All functions accept explicit parameters — no process.argv
 * coupling, so they're testable in isolation.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  runPipeline,
  hexDump,
  resolveDataDir,
  getSupportedPlatforms,
  type GameConfig,
} from './index.ts';

export const CONFIG_FILENAMES = ['seer.config.ts', 'seer.config.js', 'seer.config.mjs'];

/** Load a consumer's config file from `dir`, returning the GameConfig array. */
export async function loadConfig(dir: string): Promise<GameConfig[]> {
  for (const name of CONFIG_FILENAMES) {
    const filePath = resolve(dir, name);
    if (existsSync(filePath)) {
      const mod = await import(pathToFileURL(filePath).href);
      const config = mod.default ?? mod;
      return Array.isArray(config) ? config : [config];
    }
  }
  throw new Error(
    `No config file found. Create one of: ${CONFIG_FILENAMES.join(', ')}`,
  );
}

/** Parse `--game`, `--platform`, and `--data-dir` flags from raw CLI args. */
export function parseArgs(argv: string[]): { game?: string; platform?: string; dataDir?: string } {
  let game: string | undefined;
  let platform: string | undefined;
  let dataDir: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--game' && argv[i + 1]) game = argv[++i];
    else if (argv[i] === '--platform' && argv[i + 1]) platform = argv[++i];
    else if (argv[i] === '--data-dir' && argv[i + 1]) dataDir = argv[++i];
  }
  return { game, platform, dataDir };
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

export async function cmdExtract(
  configs: GameConfig[],
  game?: string,
  platform?: string,
  dataDir?: string,
): Promise<void> {
  const result = await runPipeline(configs, { game, platform, dataDir });
  if (result.length === 0) {
    console.error('No supported game+platform combinations found.');
    process.exit(1);
    return;
  }
  const allOk = result.every((r) => r.steps.every(([, ok]) => ok));
  if (!allOk) process.exit(1);
}

export function cmdHexDump(args: string[]): void {
  if (args.length === 0) {
    console.error('Usage: seer hex-dump <file> [offset] [length]');
    process.exit(1);
    return;
  }
  hexDump(args[0], args[1] ? parseInt(args[1], 0) : 0, args[2] ? parseInt(args[2], 0) : 256);
}

export function cmdDoctor(configs: GameConfig[], dataDir?: string): void {
  const gameIds = [...new Set(configs.map((c) => c.game))];
  console.log(`Found ${gameIds.length} game(s), ${configs.length} game+platform entr${configs.length === 1 ? 'y' : 'ies'} in config.\n`);

  for (const gameId of gameIds) {
    const entries = configs.filter((c) => c.game === gameId);
    console.log(`Game: ${gameId}`);
    console.log(`  Display name: ${entries[0]?.displayName ?? '(none)'}`);
    console.log(`  Supported platforms: ${getSupportedPlatforms(configs, gameId).join(', ') || '(none)'}`);

    for (const cfg of entries) {
      console.log(`  Platform: ${cfg.platform}${cfg.supported ? '' : ' (not marked supported)'}`);
      console.log(`    exportGameData: ${cfg.exportGameData ? 'registered' : 'not registered'}`);
      console.log(`    buildAssets:    ${cfg.buildAssets ? 'registered' : 'not registered'}`);

      const resolved = resolveDataDir(cfg, dataDir);
      if (resolved) {
        console.log(`    Data dir: found at ${resolved}`);
      } else {
        console.warn(`    Data dir: not found (searched ${cfg.dataDirs.join(', ')})`);
      }
    }
    console.log('');
  }
}

/** Print CLI usage to stdout. */
export function printUsage(): void {
  console.log(`Seer — browser-based game reverse-engineering CLI

Usage: seer <command> [options]

Commands:
  extract [--game <id>] [--platform <id>] [--data-dir <path>]
    Run the offline extraction pipeline. Reads seer.config.ts.
  hex-dump <file> [offset] [length]
    Inspect binary file contents as hex + ASCII.
  doctor [--data-dir <path>]
    Sanity-check the resolved config against disk.
  --help, -h
    Show this message.`);
}
