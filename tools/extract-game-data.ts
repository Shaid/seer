/**
 * extract-game-data — Unified extraction pipeline orchestrator.
 *
 * Chains the offline pipeline stages: export-game-data → build-assets (see
 * docs/architecture-overview.md §6). Each step can fail gracefully without
 * stopping the others, and per-game scripts are resolved by convention from
 * `tools/<game>/export-game-data.ts` and `tools/<game>/build-assets.ts`.
 *
 * This orchestration *pattern* — CLI arg parsing with sensible defaults,
 * config-table-driven iteration over game×platform combos, per-step failure
 * tolerance, and a summary printout — is the reusable part. Add a third
 * stage (e.g. build-music-manifest, or anything else your project needs) by
 * following the same shape as `runStep`/`processGamePlatform` below.
 *
 * Usage:
 *   npx tsx tools/extract-game-data.ts --game <game> --platform <platform> [options]
 *
 * Options:
 *   --export-only    Only run game data export step
 *   --assets-only    Only run asset build step
 */

import { statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  GAME_IDS,
  PLATFORM_IDS,
  DEFAULT_GAME,
  getGameConfig,
  getSupportedPlatforms,
  resolveDataDir,
  findFileCI,
  type GameId,
  type PlatformId,
  type GamePlatformConfig,
} from './shared/game-config.ts';

interface Options {
  game: GameId | 'all';
  platform: PlatformId | 'all';
  exportOnly: boolean;
  assetsOnly: boolean;
}

const USAGE = `Usage: npx tsx tools/extract-game-data.ts --game <${GAME_IDS.join('|')}|all> --platform <${PLATFORM_IDS.join('|')}|all> [options]

Options:
  --export-only    Only run game data export step
  --assets-only    Only run asset build step`;

/** Parse CLI arguments into pipeline options. */
export function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  let game: GameId | 'all' | undefined;
  let platform: PlatformId | 'all' | undefined;
  let exportOnly = false;
  let assetsOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--game' && args[i + 1]) {
      const val = args[++i];
      if (val === 'all') {
        game = 'all';
      } else if (GAME_IDS.includes(val as GameId)) {
        game = val as GameId;
      } else {
        throw new Error(`Unknown game: ${val}. Choose from: ${GAME_IDS.join(', ')}, all`);
      }
    } else if (arg === '--platform' && args[i + 1]) {
      const val = args[++i];
      if (val === 'all') {
        platform = 'all';
      } else if (PLATFORM_IDS.includes(val as PlatformId)) {
        platform = val as PlatformId;
      } else {
        throw new Error(`Unknown platform: ${val}. Choose from: ${PLATFORM_IDS.join(', ')}, all`);
      }
    } else if (arg === '--export-only') {
      exportOnly = true;
    } else if (arg === '--assets-only') {
      assetsOnly = true;
    }
  }

  const resolvedGame: GameId | 'all' = game ?? DEFAULT_GAME;
  const resolvedPlatform: PlatformId | 'all' =
    platform ??
    (resolvedGame === 'all' ? 'all' : (getSupportedPlatforms(resolvedGame)[0] ?? PLATFORM_IDS[0]));

  return { game: resolvedGame, platform: resolvedPlatform, exportOnly, assetsOnly };
}

/** Run a pipeline step, returning true on success. */
export function runStep(name: string, fn: () => void, required = true): boolean {
  try {
    console.log(`\n── ${name} ──`);
    fn();
    return true;
  } catch (e) {
    if (required) {
      console.error(`  ✗ ${name} failed: ${(e as Error).message}`);
    } else {
      console.warn(`  ⚠ ${name} skipped: ${(e as Error).message}`);
    }
    return false;
  }
}

function runScript(script: string, args: string[]): void {
  const scriptPath = resolve('tools', script);
  const cmd = `npx tsx ${scriptPath} ${args.join(' ')}`;
  execSync(cmd, { stdio: 'inherit', cwd: resolve('.') });
}

/** Prints a helpful "couldn't find the data" message listing what was searched for. */
function printDataDirNotFound(config: GamePlatformConfig): void {
  console.error(
    `Could not find game data under: ${config.dataDirs.map((d) => resolve('data', d)).join(', ')}`,
  );
  console.error(
    `Place your game files anywhere inside data/${config.game}/${config.platform}/ — files may be`,
  );
  console.error(`flat, in a subfolder, or nested however you like. Looked for:`);
  if (config.executable) console.error(`  - executable: ${config.executable}`);
  console.error(`  - any of: ${config.expectedFiles.join(', ')}`);
}

function getGamePlatformConfigs(
  game: GameId | 'all',
  platform: PlatformId | 'all',
): GamePlatformConfig[] {
  const configs: GamePlatformConfig[] = [];

  const games = game === 'all' ? [...GAME_IDS] : [game];
  for (const g of games) {
    const platforms = platform === 'all' ? getSupportedPlatforms(g) : [platform];
    for (const p of platforms) {
      const config = getGameConfig(g, p);
      if (config && config.supported) {
        configs.push(config);
      }
    }
  }

  return configs;
}

function processGamePlatform(config: GamePlatformConfig, opts: Options): void {
  const dataDir = resolveDataDir(config);
  if (!dataDir) {
    printDataDirNotFound(config);
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(config.displayName);
  console.log(`  Source: ${dataDir}`);
  console.log(`${'='.repeat(60)}`);

  const results: [string, boolean][] = [];
  const runAllSteps = !opts.exportOnly && !opts.assetsOnly;

  // Step 1: Export game data tables (reads the executable, if any)
  if (runAllSteps || opts.exportOnly) {
    const hasExe =
      config.executable &&
      statSync(resolve(dataDir, findFileCI(dataDir, config.executable)), {
        throwIfNoEntry: false,
      });
    const exportScript = `tools/${config.game}/export-game-data.ts`;
    if (hasExe && existsSync(resolve(exportScript))) {
      results.push([
        'export-game-data',
        runStep('Export game data', () => {
          runScript(`${config.game}/export-game-data.ts`, [dataDir]);
        }),
      ]);
    } else {
      console.log('\n── export-game-data ──');
      console.warn(
        `  ⚠ ${config.executable ? `${config.executable} not found, or ` : ''}` +
          `tools/${config.game}/export-game-data.ts not implemented yet — skipping`,
      );
      results.push(['export-game-data (skipped)', true]);
    }
  }

  // Step 2: Build runtime assets
  if (runAllSteps || opts.assetsOnly) {
    const buildScript = `tools/${config.game}/build-assets.ts`;
    if (existsSync(resolve(buildScript))) {
      results.push([
        'build-assets',
        runStep('Build assets', () => {
          runScript(`${config.game}/build-assets.ts`, [dataDir]);
        }),
      ]);
    } else {
      console.log('\n── build-assets ──');
      console.warn(`  ⚠ tools/${config.game}/build-assets.ts not implemented yet — skipping`);
      results.push(['build-assets (skipped)', true]);
    }
  }

  // Summary
  console.log('\n── Summary ──');
  for (const [name, ok] of results) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  }

  const failed = results.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} step(s) had issues. Check warnings above.`);
  } else {
    console.log('\nAll steps complete.');
  }
}

function main() {
  const opts = parseArgs(process.argv);
  const configs = getGamePlatformConfigs(opts.game, opts.platform);

  if (configs.length === 0) {
    console.error('No supported game+platform combinations found.');
    console.error('Edit tools/shared/game-config.ts to mark a config as supported: true.');
    process.exit(1);
  }

  console.log('Seer Data Extractor');
  console.log(`  Processing ${configs.length} game+platform combination(s)`);

  for (const config of configs) {
    processGamePlatform(config, opts);
  }

  console.log('\n' + '='.repeat(60));
  console.log('All games/platforms processed.');
}

// Standalone CLI mode
const isStandalone =
  process.argv[1] &&
  (process.argv[1].endsWith('extract-game-data.ts') ||
    process.argv[1].endsWith('extract-game-data'));

if (isStandalone) {
  main();
}
