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
  type GameConfig,
  getAllSupportedPlatforms,
  resolveDataDir,
} from './config.ts';
import { runPipeline } from './pipeline.ts';
import { hexDump } from './hex-dump.ts';

export const CONFIG_FILENAMES = ['seer.config.ts', 'seer.config.js', 'seer.config.mjs'];

/**
 * Load a consumer's config file from `dir`, returning the nested GameConfig
 * array. Handles both nested (`{ games: [...] }` / `[{ id, platforms }]`)
 * and legacy flat (`[{ platform, ... }]`) formats.
 */
export async function loadConfig(dir: string): Promise<GameConfig[]> {
  for (const name of CONFIG_FILENAMES) {
    const filePath = resolve(dir, name);
    if (existsSync(filePath)) {
      const mod = await import(pathToFileURL(filePath).href);
      const raw = mod.default ?? mod;

      // Nested: `[{ id, displayName, platforms }]` or `{ games: [...] }`
      if (Array.isArray(raw) && raw.length > 0 && raw[0].id && raw[0].platforms) {
        return raw as GameConfig[];
      }
      if (raw.games && Array.isArray(raw.games)) {
        return raw.games as GameConfig[];
      }

      // Legacy flat: `[{ platform, ... }]` — wrap in synthetic GameConfig
      if (Array.isArray(raw) && raw.length > 0 && raw[0].platform) {
        const grouped = new Map<string, Record<string, unknown>[]>();
        for (const entry of raw) {
          const game = (entry.game as string) ?? 'default';
          const list = grouped.get(game) ?? [];
          list.push(entry);
          grouped.set(game, list);
        }
        return [...grouped.entries()].map(([id, platforms]) => ({
          id,
          displayName: (platforms[0]?.displayName as string) ?? id,
          platforms: platforms as unknown as GameConfig['platforms'],
        }));
      }

      // Single object (non-array) — treat as one game with one platform
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.platform) {
        return [
          {
            id: (raw.game as string) ?? 'default',
            displayName: (raw.displayName as string) ?? (raw.game as string) ?? 'default',
            platforms: [raw] as unknown as GameConfig['platforms'],
          },
        ];
      }
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
  const totalPlatforms = configs.reduce((n, g) => n + g.platforms.length, 0);
  console.log(
    `Found ${configs.length} game(s), ${totalPlatforms} game+platform entr${totalPlatforms === 1 ? 'y' : 'ies'} in config.\n`,
  );

  for (const game of configs) {
    console.log(`Game: ${game.id}`);
    console.log(`  Display name: ${game.displayName}`);
    console.log(
      `  Supported platforms: ${getAllSupportedPlatforms(configs, game.id).join(', ') || '(none)'}`,
    );

    for (const platform of game.platforms) {
      console.log(
        `  Platform: ${platform.platform}${platform.supported ? '' : ' (not marked supported)'}`,
      );
      console.log(`    exportGameData: ${platform.exportGameData ? 'registered' : 'not registered'}`);
      console.log(`    buildAssets:    ${platform.buildAssets ? 'registered' : 'not registered'}`);

      const resolved = resolveDataDir(
        { ...platform, game: game.id },
        dataDir,
      );
      if (resolved) {
        console.log(`    Data dir: found at ${resolved}`);
      } else {
        console.warn(`    Data dir: not found (searched ${platform.dataDirs.join(', ')})`);
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
