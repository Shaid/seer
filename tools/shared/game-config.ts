/**
 * Game and platform configuration for the extraction pipeline.
 *
 * Single source of truth for per-game, per-platform file mappings. Every
 * pipeline script imports from here instead of hardcoding file paths.
 *
 * Re-exports browser-safe identifiers from src/game-id.ts and adds
 * Node-only config data (this file uses `node:fs`/`node:path`, so it must
 * never be imported from browser-bundled code under src/).
 */

import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  GAME_IDS,
  PLATFORM_IDS,
  DEFAULT_GAME,
  DEFAULT_PLATFORM,
  type GameId,
  type PlatformId,
} from '../../src/game-id.ts';

export { GAME_IDS, PLATFORM_IDS, DEFAULT_GAME, DEFAULT_PLATFORM };
export type { GameId, PlatformId };

export interface GamePlatformConfig {
  game: GameId;
  platform: PlatformId;
  /** Human-readable name for UI/CLI display. */
  displayName: string;
  /**
   * Base directories to SEARCH for this game+platform's files — NOT exact
   * paths. The canonical base is `data/<game>/<platform>/`, but the actual
   * data files may live anywhere beneath it (dropped flat, nested in a
   * subfolder, extracted from a disk image, etc). `resolveDataDir()` walks
   * each base breadth-first and returns the shallowest directory that
   * actually contains the executable or one of `expectedFiles` (matched
   * case-insensitively). Multiple bases are searched in order; the first
   * that resolves wins.
   */
  dataDirs: string[];
  /** Executable filename for exe-data extraction (omit if there isn't one). */
  executable?: string;
  /**
   * Filenames (or relative paths beneath the data directory) that identify
   * this game+platform's data — used by `resolveDataDir()` to recognise the
   * directory, and by pipeline scripts to know what to look for. Include
   * every file your build-assets/export-game-data scripts will read.
   */
  expectedFiles: string[];
  /** Whether this game+platform combination has usable data available. */
  supported: boolean;
  /** Runtime asset output subdirectory under public/assets/. */
  assetDir: string;
  /**
   * Optional per-platform overrides for resource type codes/names, for
   * formats where different ports rename container entry types (e.g. some
   * DOS ports store 4-letter type codes byte-reversed relative to the
   * original Amiga release). Leave undefined if not applicable.
   */
  typeCodes?: Record<string, string>;
  /**
   * Free-form feature flags for this game+platform — use this instead of
   * adding new top-level boolean fields for every optional subsystem
   * (e.g. `{ music: true, tileGrid: false }`). Keeps the config shape open
   * without hardcoding assumptions about what every game has.
   */
  features?: Record<string, boolean>;
}

/**
 * The config table itself. This is the ONE place that should need editing
 * when you add a new game or a new platform port of an existing game.
 *
 * Delete this placeholder entry and add your own.
 */
export const GAME_PLATFORMS: GamePlatformConfig[] = [
  {
    game: 'game1',
    platform: 'platform1',
    displayName: 'Placeholder Game (Platform 1)',
    dataDirs: ['game1/platform1'],
    executable: undefined,
    expectedFiles: [],
    supported: false,
    assetDir: 'game1',
    features: {},
  },
];

/** Lookup a specific game+platform config. */
export function getGameConfig(game: GameId, platform: PlatformId): GamePlatformConfig | undefined {
  return GAME_PLATFORMS.find((c) => c.game === game && c.platform === platform);
}

/** Get all supported platforms for a game. */
export function getSupportedPlatforms(game: GameId): PlatformId[] {
  return GAME_PLATFORMS.filter((c) => c.game === game && c.supported).map((c) => c.platform);
}

/** Map a logical resource type (e.g. 'image') to a platform-specific code, if overridden. */
export function resType(config: GamePlatformConfig, logical: string): string {
  return config.typeCodes?.[logical] ?? logical.toUpperCase();
}

/** Directory names skipped when searching for a game's data folder. */
const IGNORED_DIR_NAMES = new Set(['node_modules', '.git']);

/** How many levels deep to search under each base for the actual data folder. */
const MAX_SEARCH_DEPTH = 4;

/** True if `dir` directly contains this game's executable or any expected file. */
function looksLikeDataDir(dir: string, config: GamePlatformConfig): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (config.executable) {
    const exeLower = config.executable.toLowerCase();
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === exeLower)) return true;
  }
  const lowerNames = new Set(entries.map((e) => e.name.toLowerCase()));
  return config.expectedFiles.some((f) => lowerNames.has(f.toLowerCase()));
}

/**
 * Finds a file in `dir` matching `name` case-insensitively, returning its
 * on-disk filename (useful since different platform ports conventionally use
 * different filename casing). Falls back to `name` unchanged if nothing
 * matches, so callers still get a sensible path in error messages.
 */
export function findFileCI(dir: string, name: string): string {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return name;
  }
  const match = names.find((n) => n.toLowerCase() === name.toLowerCase());
  return match ?? name;
}

/**
 * Locates the directory that actually holds a game's data files.
 *
 * Walks each base in `config.dataDirs` breadth-first (shallowest match wins)
 * and returns the first directory that directly contains the game's
 * executable or any expected file, matched case-insensitively. Returns
 * undefined if no base yields a match. This tolerates any user-organised
 * layout: flat files, nested subfolders, extracted disk images, etc.
 */
export function resolveDataDir(config: GamePlatformConfig): string | undefined {
  for (const base of config.dataDirs) {
    const root = resolve('data', base);
    if (!existsSync(root)) continue;

    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!;
      if (looksLikeDataDir(dir, config)) return dir;
      if (depth >= MAX_SEARCH_DEPTH) continue;

      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          IGNORED_DIR_NAMES.has(entry.name) ||
          entry.name.startsWith('.')
        )
          continue;
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return undefined;
}
