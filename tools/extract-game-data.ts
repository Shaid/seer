/**
 * extract-game-data — Unified extraction pipeline orchestrator.
 *
 * Chains the offline pipeline stages via runPipeline() from @seer/pipeline:
 * export-game-data → build-assets (see docs/architecture-overview.md §6).
 * Each step's functions are registered directly on the config table
 * (tools/shared/game-config.ts) — no execSync or file-path convention.
 *
 * Per-step failure tolerance and the summary printout are handled by the
 * library's runPipeline(). This file is purely the consumer's CLI layer:
 * arg parsing with sensible defaults, 'all' expansion, and forwarding to
 * the library.
 *
 * Usage:
 *   npx tsx tools/extract-game-data.ts --game <game> --platform <platform> [options]
 *
 * Options:
 *   --export-only    Only run game data export step
 *   --assets-only    Only run asset build step
 */

import {
  GAME_IDS,
  PLATFORM_IDS,
  DEFAULT_GAME,
  GAME_PLATFORMS,
  getSupportedPlatforms,
  type GameId,
  type PlatformId,
} from './shared/game-config.ts';
import { runPipeline } from '@seer/pipeline';

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
      const val = ++i && args[i];
      if (val === 'all') {
        game = 'all';
      } else if (GAME_IDS.includes(val as GameId)) {
        game = val as GameId;
      } else {
        throw new Error(`Unknown game: ${val}. Choose from: ${GAME_IDS.join(', ')}, all`);
      }
    } else if (arg === '--platform' && args[i + 1]) {
      const val = ++i && args[i];
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

async function main() {
  const opts = parseArgs(process.argv);

  // 'all' expansion: runPipeline handles iteration, but we need to expand
  // 'all' to concrete supported combinations ourselves, since the library
  // accepts concrete game/platform IDs only.
  const games = opts.game === 'all' ? [...GAME_IDS] : [opts.game];
  const results: { game: GameId; platform: PlatformId; ok: boolean }[] = [];

  for (const game of games) {
    const platforms =
      opts.platform === 'all'
        ? (opts.game === 'all' ? getSupportedPlatforms(game) : [...PLATFORM_IDS])
        : [opts.platform];

    for (const platform of platforms) {
      const pipelineResults = await runPipeline(GAME_PLATFORMS, { game, platform });
      const first = pipelineResults[0];
      const ok = first ? first.steps.every(([, s]) => s) : false;
      results.push({ game, platform, ok });
    }
  }

  if (results.length === 0) {
    console.error('No supported game+platform combinations found.');
    console.error('Edit tools/shared/game-config.ts to mark a config as supported: true.');
    process.exit(1);
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
