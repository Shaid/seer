/**
 * Pipeline orchestration: runPipeline.
 *
 * The bridge between a consumer's GameConfig[] and the reusable orchestration
 * loop (step execution, error tolerance, summary reporting). Consumers
 * register step functions (exportGameData, buildAssets) directly on their
 * platform entries — no flattening required.
 *
 * Node-only: uses node:fs. Never import from browser-bundled code.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type GameConfig,
  type PlatformConfig,
  flattenConfigs,
  getGameConfig,
  getSupportedPlatforms,
  resolveDataDir,
  findFileCI,
} from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pipeline result for a single game+platform combination. */
export interface PipelineResult {
  game: string;
  platform: string;
  steps: [string, boolean][];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface PipelineOptions {
  game?: string;
  platform?: string;
  verbose?: boolean;
  /** Override the data root directory (default: <cwd>/data). */
  dataDir?: string;
}

/**
 * Run a named step, catching errors (sync throws or rejected promises) and
 * returning true on success. Always awaits `fn()` — required so that
 * exceptions thrown after an `await` inside an async step are actually
 * caught here rather than becoming an unhandled rejection.
 */
async function runStep(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try {
    console.log(`\n── ${name} ──`);
    await fn();
    return true;
  } catch (e) {
    console.error(`  ✗ ${name} failed: ${(e as Error).message}`);
    return false;
  }
}

/** Print a helpful error when the data directory can't be found. */
function printDataDirNotFound(config: PlatformConfig & { game: string }, dataRoot: string): void {
  console.error(
    `Could not find game data under: ${config.dataDirs.map((d) => resolve(dataRoot, d)).join(', ')}`,
  );
  console.error(
    `Place your game files anywhere inside ${dataRoot}/${config.game}/${config.platform}/ — files may be`,
  );
  console.error(`flat, in a subfolder, or nested however you like. Looked for:`);
  if (config.executable) console.error(`  - executable: ${config.executable}`);
  console.error(`  - any of: ${config.expectedFiles.join(', ')}`);
}

/**
 * Run the full extraction pipeline for one or more game+platform combinations.
 *
 * Accepts the nested GameConfig[] directly — no pre-flattening required.
 * Step functions (exportGameData, buildAssets) are read from each platform
 * entry in the config.
 *
 * Per-step failure is tolerated: a failed step is logged but does not
 * prevent subsequent steps from running.
 *
 * @param configs - The nested GameConfig[] array (e.g. from defineGameConfig).
 * @param options - Which game+platform to process. When both are omitted,
 *   the first supported entry in the array is used.
 */
export async function runPipeline(
  configs: GameConfig[],
  options: PipelineOptions = {},
): Promise<PipelineResult[]> {
  const entries = flattenConfigs(configs);

  const game = options.game ?? entries[0]?.game;
  const platform = options.platform ?? entries[0]?.platform;

  if (!game || !platform) {
    console.error('No game+platform specified and none found in config.');
    return [];
  }

  const games = game === 'all' ? [...new Set(entries.map((e) => e.game))] : [game];
  const results: PipelineResult[] = [];

  for (const gameId of games) {
    const platforms = platform === 'all' ? getSupportedPlatforms(entries, gameId) : [platform];

    for (const platformId of platforms) {
      const config = getGameConfig(entries, gameId, platformId);
      if (!config || !config.supported) continue;

      const dataDir = resolveDataDir(config, options.dataDir);
      if (!dataDir) {
        printDataDirNotFound({ ...config, game: gameId }, options.dataDir ?? resolve('data'));
        results.push({ game: gameId, platform: platformId, steps: [] });
        continue;
      }

      const flatConfig = { ...config, game: gameId };

      console.log(`\n${'='.repeat(60)}`);
      console.log(`${gameId} — ${platformId}`);
      console.log(`  Source: ${dataDir}`);
      console.log(`${'='.repeat(60)}`);

      const steps: [string, boolean][] = [];

      if (config.exportGameData) {
        const hasExe =
          config.executable &&
          statSync(resolve(dataDir, findFileCI(dataDir, config.executable)), {
            throwIfNoEntry: false,
          });
        if (hasExe) {
          steps.push([
            'export-game-data',
            await runStep('Export game data', () => config.exportGameData!(flatConfig, dataDir)),
          ]);
        } else {
          console.log('\n── export-game-data ──');
          console.warn(`  ⚠ ${config.executable ?? 'executable'} not found — skipping`);
          steps.push(['export-game-data (skipped)', true]);
        }
      } else {
        console.log('\n── export-game-data ──');
        console.warn('  ⚠ not registered in config — skipping');
        steps.push(['export-game-data (skipped)', true]);
      }

      if (config.buildAssets) {
        steps.push([
          'build-assets',
          await runStep('Build assets', () => config.buildAssets!(flatConfig, dataDir)),
        ]);
      } else {
        console.log('\n── build-assets ──');
        console.warn('  ⚠ not registered in config — skipping');
        steps.push(['build-assets (skipped)', true]);
      }

      console.log('\n── Summary ──');
      for (const [name, ok] of steps) {
        console.log(`  ${ok ? '✓' : '✗'} ${name}`);
      }

      const failed = steps.filter(([, ok]) => !ok);
      if (failed.length > 0) {
        console.log(`\n${failed.length} step(s) had issues. Check warnings above.`);
      } else {
        console.log('\nAll steps complete.');
      }

      results.push({ game: gameId, platform: platformId, steps });
    }
  }

  return results;
}
