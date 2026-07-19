/**
 * Pipeline orchestration: defineGameConfig + runPipeline.
 *
 * This module is the bridge between a consumer's project config and the
 * reusable orchestration logic (step execution, error tolerance, summary
 * reporting). The consumer owns the config file; the library owns the
 * orchestration loop.
 *
 * Node-only: uses node:fs, node:child_process. Never import from
 * browser-bundled code.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type GamePlatformConfig,
  getGameConfig,
  getSupportedPlatforms,
  resolveDataDir,
  findFileCI,
} from './config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single reusable pipeline step — a function that takes a game+platform
 * config and the resolved data directory, and does one stage of work.
 * Thrown exceptions are caught and reported by the orchestrator.
 */
export type PipelineStep = (config: GamePlatformConfig, dataDir: string) => void;

/** Pipeline result for a single game+platform combination. */
export interface PipelineResult {
  game: string;
  platform: string;
  steps: [string, boolean][];
}

/** A game+platform config augmented with the pipeline functions the consumer
 * registers for the orchestration loop to call. Extends GamePlatformConfig
 * so data fields (displayName, dataDirs, expectedFiles, etc.) are still
 * required. */
export interface GameConfig extends GamePlatformConfig {
  /** Stage 1: parse game executable / data tables, write raw JSON. */
  exportGameData?: PipelineStep;
  /** Stage 2: decode resource files into web-native PNG + JSON assets. */
  buildAssets?: PipelineStep;
}

/**
 * Defines a game+platform configuration object (or array of them).
 *
 * A thin typed wrapper — returns the config as-is — but gives the consumer
 * IDE autocompletion and compile-time checking against the GameConfig shape.
 */
export function defineGameConfig<T extends GameConfig | GameConfig[]>(config: T): T {
  return config;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface PipelineOptions {
  game?: string;
  platform?: string;
  verbose?: boolean;
}

/** Run a named step, catching errors and returning true on success. */
function runStep(name: string, fn: () => void): boolean {
  try {
    console.log(`\n── ${name} ──`);
    fn();
    return true;
  } catch (e) {
    console.error(`  ✗ ${name} failed: ${(e as Error).message}`);
    return false;
  }
}

/** Print a helpful error when the data directory can't be found. */
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

/**
 * Run the full extraction pipeline for one game+platform combination.
 *
 * The consumer calls this once per combination from their own CLI wrapper.
 * Per-step failure is tolerated: a failed step is logged but does not
 * prevent subsequent steps from running.
 *
 * @param configs - The full config array (typically the consumer's
 *   GAME_PLATFORMS). `runPipeline` filters to the requested game+platform.
 * @param options - Which game+platform to process. When both are omitted,
 *   the first supported combination in the array is used.
 * @returns Results for each step that ran, suitable for a summary printout
 *   or programmatic checking.
 */
export function runPipeline(configs: GameConfig[], options: PipelineOptions = {}): PipelineResult[] {
  const game = options.game ?? configs[0]?.game;
  const platform = options.platform ?? configs[0]?.platform;

  if (!game || !platform) {
    console.error('No game+platform specified and none found in config.');
    return [];
  }

  // Expand 'all' to concrete game IDs, then expand 'all' platforms per game.
  const games = game === 'all' ? [...new Set(configs.map((c) => c.game))] : [game];
  const results: PipelineResult[] = [];

  for (const gameId of games) {
    const platforms =
      platform === 'all'
        ? getSupportedPlatforms(configs, gameId)
        : [platform];

    for (const platformId of platforms) {
      const config = getGameConfig(configs, gameId, platformId) as GameConfig | undefined;
      if (!config || !config.supported) continue;

      const dataDir = resolveDataDir(config);
      if (!dataDir) {
        printDataDirNotFound(config);
        results.push({ game: gameId, platform: platformId, steps: [] });
        continue;
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(config.displayName);
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
          steps.push(['export-game-data', runStep('Export game data', () => {
            config.exportGameData!(config, dataDir);
          })]);
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
        steps.push(['build-assets', runStep('Build assets', () => {
          config.buildAssets!(config, dataDir);
        })]);
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
