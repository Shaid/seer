/**
 * Pipeline orchestration: runPipeline.
 *
 * The bridge between a consumer's config and the reusable orchestration loop
 * (step execution, error tolerance, summary reporting). Consumers register
 * step functions directly on their flattened config entries.
 *
 * Node-only: uses node:fs, node:child_process. Never import from
 * browser-bundled code.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type PlatformConfig,
  type FlattenedPlatform,
  getGameConfig,
  getSupportedPlatforms,
  resolveDataDir,
  findFileCI,
} from './config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single reusable pipeline step — a function that takes a platform config
 * and the resolved data directory, and does one stage of work.
 * May be sync or async; thrown exceptions are caught by the orchestrator.
 */
export type PipelineStep = (
  config: PlatformConfig,
  dataDir: string,
) => void | Promise<void>;

/** Pipeline result for a single game+platform combination. */
export interface PipelineResult {
  game: string;
  platform: string;
  steps: [string, boolean][];
}

/**
 * A platform config augmented with the pipeline step functions the consumer
 * registers for the orchestrator to call. This is what `runPipeline` accepts
 * — a flat array, one entry per game+platform combination.
 */
export interface PipelineEntry extends FlattenedPlatform {
  /** Stage 1: parse game executable / data tables, write raw JSON. */
  exportGameData?: PipelineStep;
  /** Stage 2: decode resource files into web-native PNG + JSON assets. */
  buildAssets?: PipelineStep;
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
async function runStep(
  name: string,
  fn: () => void | Promise<void>,
): Promise<boolean> {
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
function printDataDirNotFound(
  config: PlatformConfig,
  dataRoot: string,
): void {
  console.error(
    `Could not find game data under: ${config.dataDirs.map((d) => resolve(dataRoot, d)).join(', ')}`,
  );
  const gameDir = config.game ? `${config.game}/${config.platform}` : config.platform;
  console.error(
    `Place your game files anywhere inside ${dataRoot}/${gameDir}/ — files may be`,
  );
  console.error(`flat, in a subfolder, or nested however you like. Looked for:`);
  if (config.executable) console.error(`  - executable: ${config.executable}`);
  console.error(`  - any of: ${config.expectedFiles.join(', ')}`);
}

/**
 * Run the full extraction pipeline for one or more game+platform combinations.
 *
 * Per-step failure is tolerated: a failed step is logged but does not
 * prevent subsequent steps from running.
 *
 * @param entries - Flat array of platform configs with optional pipeline step
 *   functions attached. Use `flattenConfigs()` to convert a nested
 *   `GameConfig[]` into this shape.
 * @param options - Which game+platform to process. When both are omitted,
 *   the first supported entry in the array is used.
 */
export async function runPipeline(
  entries: PipelineEntry[],
  options: PipelineOptions = {},
): Promise<PipelineResult[]> {
  const game = options.game ?? entries[0]?.game;
  const platform = options.platform ?? entries[0]?.platform;

  if (!game || !platform) {
    console.error('No game+platform specified and none found in config.');
    return [];
  }

  const games =
    game === 'all' ? [...new Set(entries.map((e) => e.game))] : [game];
  const results: PipelineResult[] = [];

  for (const gameId of games) {
    const platforms =
      platform === 'all'
        ? getSupportedPlatforms(entries, gameId)
        : [platform];

    for (const platformId of platforms) {
      const config = getGameConfig(entries, gameId, platformId) as
        | PipelineEntry
        | undefined;
      if (!config || !config.supported) continue;

      const dataDir = resolveDataDir(config, options.dataDir);
      if (!dataDir) {
        printDataDirNotFound(config, options.dataDir ?? resolve('data'));
        results.push({ game: gameId, platform: platformId, steps: [] });
        continue;
      }

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
            await runStep('Export game data', () =>
              config.exportGameData!(config, dataDir),
            ),
          ]);
        } else {
          console.log('\n── export-game-data ──');
          console.warn(
            `  ⚠ ${config.executable ?? 'executable'} not found — skipping`,
          );
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
          await runStep('Build assets', () =>
            config.buildAssets!(config, dataDir),
          ),
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
        console.log(
          `\n${failed.length} step(s) had issues. Check warnings above.`,
        );
      } else {
        console.log('\nAll steps complete.');
      }

      results.push({ game: gameId, platform: platformId, steps });
    }
  }

  return results;
}
