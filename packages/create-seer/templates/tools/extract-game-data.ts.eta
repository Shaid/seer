import {
  DEFAULT_GAME,
  GAME_CONFIGS,
  type GameId,
  type PlatformId,
} from './shared/game-config.ts';
import { runPipeline } from '@seer/pipeline';

function parseArgs(argv: string[]): { game: GameId | "all"; platform: PlatformId | "all" } {
  const args = argv.slice(2);
  let game: GameId | "all" | undefined;
  let platform: PlatformId | "all" | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--game" && args[i + 1]) {
      const val = args[++i];
      game = val === "all" ? "all" : val as GameId;
    } else if (args[i] === "--platform" && args[i + 1]) {
      const val = args[++i];
      platform = val === "all" ? "all" : val as PlatformId;
    }
  }

  return {
    game: game ?? DEFAULT_GAME,
    platform: platform ?? "all",
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  await runPipeline(GAME_CONFIGS, {
    game: opts.game,
    platform: opts.platform,
  });
}

const isStandalone =
  process.argv[1]?.endsWith('extract-game-data.ts') ||
  process.argv[1]?.endsWith('extract-game-data');

if (isStandalone) main();
