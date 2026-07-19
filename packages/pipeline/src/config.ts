/**
 * Game + platform config types and data-dir resolution.
 *
 * Two levels of config:
 *   - `GameConfig` — game-level wrapper (id, display name, array of platforms).
 *   - `PlatformConfig` — single platform entry (executable, expected files, etc.).
 *
 * `defineGameConfig()` accepts a nested `GameConfig[]` and returns it as-is.
 * `flattenConfigs()` converts the nested shape into a flat `PlatformConfig[]`
 * array for functions that iterate over every game+platform combination.
 *
 * Node-only: uses node:fs and node:path. Never import from browser-bundled code.
 */

import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single platform port of a game — the smallest config unit. Each entry
 * describes where to find files for one platform and whether it's usable.
 */
export interface PlatformConfig {
  /** Game this platform belongs to (back-reference set by flattenConfigs). */
  game?: string;
  /** Platform identifier (e.g. 'amiga', 'dosvga'). */
  platform: string;
  dataDirs: string[];
  executable?: string;
  expectedFiles: string[];
  supported: boolean;
  assetDir: string;
  typeCodes?: Record<string, string>;
  features?: Record<string, boolean>;
  /** Stage 1: parse game executable / data tables, write raw JSON. */
  exportGameData?: (config: PlatformConfig, dataDir: string) => void | Promise<void>;
  /** Stage 2: decode resource files into web-native PNG + JSON assets. */
  buildAssets?: (config: PlatformConfig, dataDir: string) => void | Promise<void>;
}

/**
 * Top-level game config — groups platforms under a single human-readable
 * game identity. This is the shape consumers write in their config file.
 */
export interface GameConfig {
  /** Game identifier (e.g. 'wime', 'spirit'). */
  id: string;
  /** Human-readable name (e.g. 'War in Middle Earth'). */
  displayName: string;
  /** One entry per supported platform port. */
  platforms: PlatformConfig[];
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Defines a nested game config. A thin typed wrapper — returns the config
 * as-is — but gives the consumer IDE autocompletion and compile-time
 * checking against the GameConfig shape.
 */
export function defineGameConfig<T extends GameConfig[]>(config: T): T {
  return config;
}

/**
 * Flatten a nested GameConfig[] into a flat PlatformConfig[] with game
 * back-references set on each entry. Internal utility — consumers pass
 * GameConfig[] directly to runPipeline() and don't need to call this.
 */
export function flattenConfigs(
  configs: GameConfig[],
): (PlatformConfig & { game: string })[] {
  return configs.flatMap((g) =>
    g.platforms.map((p) => ({ ...p, game: g.id })),
  );
}

/** Look up one platform inside a nested GameConfig[]. */
export function getPlatformConfig(
  configs: GameConfig[],
  game: string,
  platform: string,
): PlatformConfig | undefined {
  for (const g of configs) {
    if (g.id !== game) continue;
    return g.platforms.find((p) => p.platform === platform);
  }
  return undefined;
}

/** Get all supported platform IDs for a game from a nested GameConfig[]. */
export function getAllSupportedPlatforms(
  configs: GameConfig[],
  game: string,
): string[] {
  for (const g of configs) {
    if (g.id !== game) continue;
    return g.platforms.filter((p) => p.supported).map((p) => p.platform);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Flat-array helpers (work directly on PlatformConfig[])
// ---------------------------------------------------------------------------

/** Lookup a specific game+platform config from a flat array. */
export function getGameConfig(
  platforms: PlatformConfig[],
  game: string,
  platform: string,
): PlatformConfig | undefined {
  return platforms.find((c) => c.game === game && c.platform === platform);
}

/** Get all supported platforms for a game from a flat array. */
export function getSupportedPlatforms(
  platforms: PlatformConfig[],
  game: string,
): string[] {
  return platforms
    .filter((c) => c.game === game && c.supported)
    .map((c) => c.platform);
}

/** Map a logical resource type to a platform-specific code, if overridden. */
export function resType(config: PlatformConfig, logical: string): string {
  return config.typeCodes?.[logical] ?? logical.toUpperCase();
}

// ---------------------------------------------------------------------------
// Data-dir resolution
// ---------------------------------------------------------------------------

/** Directory names skipped when searching for a game's data folder. */
const IGNORED_DIR_NAMES = new Set(['node_modules', '.git']);

/** How many levels deep to search under each base for the actual data folder. */
const MAX_SEARCH_DEPTH = 4;

/** True if `dir` directly contains this game's executable or any expected file. */
function looksLikeDataDir(dir: string, config: PlatformConfig): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (config.executable) {
    const exeLower = config.executable.toLowerCase();
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === exeLower))
      return true;
  }
  const lowerNames = new Set(entries.map((e) => e.name.toLowerCase()));
  return config.expectedFiles.some((f) => lowerNames.has(f.toLowerCase()));
}

/**
 * Finds a file in `dir` matching `name` case-insensitively, returning its
 * on-disk filename. Falls back to `name` unchanged if nothing matches.
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
 * executable or any expected file, matched case-insensitively.
 *
 * @param dataRoot - Root directory under which `config.dataDirs` are
 *   searched. Defaults to `<cwd>/data`. Pass an explicit path to override
 *   (e.g. for `--data-dir` CLI support).
 */
export function resolveDataDir(
  config: PlatformConfig,
  dataRoot = resolve('data'),
): string | undefined {
  for (const base of config.dataDirs) {
    const root = resolve(dataRoot, base);
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
