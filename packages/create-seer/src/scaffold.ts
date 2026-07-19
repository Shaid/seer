/**
 * create-seer — project scaffolding.
 *
 * Generates a new seer project with multi-game/multi-platform support
 * pre-configured, one game/platform filled in as a working starting point.
 *
 * Run via: npx create-seer <project-name>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ScaffoldOptions {
  /** Game ID for the pre-configured entry (default: 'mygame'). */
  game?: string;
  /** Platform ID for the pre-configured entry (default: 'amiga'). */
  platform?: string;
  /** Human-readable game name (default: derived from game ID). */
  displayName?: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function write(filePath: string, content: string): void {
  writeFileSync(filePath, content);
}

/**
 * Scaffold a new seer project at `targetDir`.
 * Creates all directories and template files inline — no external template
 * directory needed, so the scaffold is self-contained in a single .ts file.
 */
export function scaffold(targetDir: string, options: ScaffoldOptions = {}): void {
  const game = options.game ?? 'mygame';
  const platform = options.platform ?? 'amiga';
  const displayName = options.displayName ?? capitalize(game);
  const gameDir = resolve(targetDir, 'tools/' + game);

  for (const dir of [
    '',
    'src/data',
    'src/engine',
    'data/' + game + '/' + platform,
    'tools/shared/__tests__',
    'tools/' + game,
  ]) {
    mkdirSync(resolve(targetDir, dir), { recursive: true });
  }

  const p = (rel: string) => resolve(targetDir, rel);

  // ── Root config files ──────────────────────────────────────────────

  write(p('package.json'), [
    '{',
    '  "name": "' + game + '",',
    '  "private": true,',
    '  "version": "0.0.1",',
    '  "type": "module",',
    '  "scripts": {',
    '    "dev": "vite --host",',
    '    "build": "tsc && vite build",',
    '    "preview": "vite preview --host",',
    '    "test": "vitest run",',
    '    "lint": "eslint src/ tools/",',
    '    "format": "prettier --write \'src/**/*.ts\' \'tools/**/*.ts\'",',
    '    "extract-data": "npx tsx tools/extract-game-data.ts",',
    '    "build-assets": "npx tsx tools/extract-game-data.ts --assets-only"',
    '  },',
    '  "dependencies": {',
    '    "@seer/core": "*",',
    '    "@seer/engine": "*",',
    '    "@seer/pipeline": "*",',
    '    "pixi.js": "^8.9.0",',
    '    "pngjs": "^7.0.0"',
    '  },',
    '  "devDependencies": {',
    '    "@types/node": "^26.0.1",',
    '    "typescript": "~6.0.2",',
    '    "tsx": "^4.20.0",',
    '    "vite": "^8.1.0",',
    '    "vitest": "^3.2.0"',
    '  }',
    '}',
  ].join('\n'));

  write(p('tsconfig.json'), [
    '{',
    '  "compilerOptions": {',
    '    "target": "ES2023",',
    '    "module": "ESNext",',
    '    "moduleResolution": "bundler",',
    '    "strict": true,',
    '    "noUnusedLocals": true,',
    '    "noUnusedParameters": true,',
    '    "noFallthroughCasesInSwitch": true,',
    '    "erasableSyntaxOnly": true,',
    '    "verbatimModuleSyntax": true,',
    '    "skipLibCheck": true,',
    '    "outDir": "dist"',
    '  },',
    '  "include": ["src", "tools"]',
    '}',
  ].join('\n'));

  write(p('index.html'), [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>' + displayName + '</title>',
    '  <style>',
    '    * { margin: 0; padding: 0; box-sizing: border-box; }',
    '    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }',
    '    #game-container { width: 100%; height: 100%; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div id="game-container"></div>',
    '  <script type="module" src="/src/main.ts"></script>',
    '</body>',
    '</html>',
  ].join('\n'));

  write(p('.gitignore'), [
    'node_modules/',
    'dist/',
    'data/',
    'public/assets/',
  ].join('\n'));

  // ── src/ ───────────────────────────────────────────────────────────

  write(p('src/game-id.ts'), [
    '/**',
    ' * Browser-safe canonical game and platform identifiers.',
    ' */',
    '',
    "export const GAME_IDS = ['" + game + "'] as const;",
    'export type GameId = (typeof GAME_IDS)[number];',
    '',
    "export const PLATFORM_IDS = ['" + platform + "'] as const;",
    'export type PlatformId = (typeof PLATFORM_IDS)[number];',
    '',
    "export const DEFAULT_GAME: GameId = '" + game + "';",
    "export const DEFAULT_PLATFORM: PlatformId = '" + platform + "';",
    '',
    'export function isGameId(v: string | null): v is GameId {',
    '  return v !== null && (GAME_IDS as readonly string[]).includes(v);',
    '}',
    '',
    'export function isPlatformId(v: string | null): v is PlatformId {',
    '  return v !== null && (PLATFORM_IDS as readonly string[]).includes(v);',
    '}',
    '',
    'export const GAME_DISPLAY_NAMES: Record<GameId, string> = {',
    "  " + game + ": '" + displayName + "',",
    '};',
  ].join('\n'));

  write(p('src/main.ts'), [
    "import { createGame } from '@seer/engine';",
    '',
    "const container = document.getElementById('game-container');",
    "if (!container) {",
    "  throw new Error('Missing #game-container element in index.html');",
    '}',
    '',
    'createGame({',
    '  container,',
    '  worldWidth: 1024,',
    '  worldHeight: 1024,',
    '  onInit: () => {',
    '    // TODO: load assets, build sprite layers, tilemaps, etc.',
    '  },',
    '  onUpdate: () => {',
    '    // TODO: per-frame game logic.',
    '  },',
    '}).catch((err: unknown) => {',
    "  console.error('Failed to initialise game:', err);",
    '});',
  ].join('\n'));

  write(p('src/data/GameData.ts'), [
    '/**',
    ' * Type definitions for preprocessed runtime assets.',
    ' */',
    '',
    'export interface AtlasMeta {',
    '  imageUrl: string;',
    '  cellWidth: number;',
    '  cellHeight: number;',
    '  columns: number;',
    '  rows: number;',
    '}',
    '',
    'export interface GameAssets {',
    '  atlas: AtlasMeta;',
    '}',
  ].join('\n'));

  write(p('src/data/AssetLoader.ts'), [
    "import { loadAssets } from '@seer/pipeline';",
    "import type { GameAssets } from './GameData.ts';",
    "import type { GameId, PlatformId } from '../game-id.ts';",
    '',
    'function assetBasePath(game: GameId, platform: PlatformId): string {',
    '  return `/assets/${game}/${platform}`;',
    '}',
    '',
    'export async function loadGameAssets(game: GameId, platform: PlatformId): Promise<GameAssets> {',
    '  const base = assetBasePath(game, platform);',
    "  return loadAssets<GameAssets>(base, { atlas: 'atlas.json' });",
    '}',
  ].join('\n'));

  // ── tools/ ─────────────────────────────────────────────────────────

  write(p('tools/shared/game-config.ts'), [
    "import {",
    '  defineGameConfig,',
    '  resolveDataDir,',
    '  findFileCI,',
    '  resType,',
    '  getGameConfig as _getGameConfig,',
    '  getSupportedPlatforms as _getSupportedPlatforms,',
    '  type GameConfig as BaseGameConfig,',
    "} from '@seer/pipeline';",
    "import {",
    '  GAME_IDS,',
    '  PLATFORM_IDS,',
    '  DEFAULT_GAME,',
    '  DEFAULT_PLATFORM,',
    '  type GameId,',
    '  type PlatformId,',
    "} from '../../src/game-id.ts';",
    '',
    'export { GAME_IDS, PLATFORM_IDS, DEFAULT_GAME, DEFAULT_PLATFORM, resolveDataDir, findFileCI, resType };',
    'export type { GameId, PlatformId };',
    '',
    'export interface GameConfig extends Omit<BaseGameConfig, "game" | "platform"> {',
    '  game: GameId;',
    '  platform: PlatformId;',
    '}',
    '',
    'export const GAME_PLATFORMS: GameConfig[] = defineGameConfig([{',
    "  game: '" + game + "',",
    "  platform: '" + platform + "',",
    "  displayName: '" + displayName + ' (' + capitalize(platform) + ")',",
    "  dataDirs: ['" + game + '/' + platform + "'],",
    '  executable: undefined,',
    '  expectedFiles: [],',
    '  supported: false,',
    "  assetDir: '" + game + "',",
    '  features: {},',
    '}]);',
    '',
    'export function getGameConfig(game: GameId, platform: PlatformId): GameConfig | undefined {',
    '  return _getGameConfig(GAME_PLATFORMS, game, platform) as GameConfig | undefined;',
    '}',
    '',
    'export function getSupportedPlatforms(game: GameId): PlatformId[] {',
    '  return _getSupportedPlatforms(GAME_PLATFORMS, game) as PlatformId[];',
    '}',
  ].join('\n'));

  write(p('tools/shared/__tests__/game-config.test.ts'), [
    "import { describe, it, expect } from 'vitest';",
    "import { getGameConfig, GAME_PLATFORMS } from '../game-config.ts';",
    '',
    "describe('getGameConfig', () => {",
    "  it('finds the placeholder config', () => {",
    "    const config = getGameConfig('" + game + "', '" + platform + "');",
    '    expect(config).toBeDefined();',
    "    expect(config?.assetDir).toBe('" + game + "');",
    '  });',
    '});',
  ].join('\n'));

  write(p('tools/extract-game-data.ts'), [
    "import {",
    '  GAME_IDS,',
    '  PLATFORM_IDS,',
    '  DEFAULT_GAME,',
    '  GAME_PLATFORMS,',
    '  getSupportedPlatforms,',
    '  type GameId,',
    '  type PlatformId,',
    "} from './shared/game-config.ts';",
    "import { runPipeline } from '@seer/pipeline';",
    '',
    'function parseArgs(argv: string[]): { game: GameId | "all"; platform: PlatformId | "all" } {',
    '  const args = argv.slice(2);',
    '  let game: GameId | "all" | undefined;',
    '  let platform: PlatformId | "all" | undefined;',
    '',
    '  for (let i = 0; i < args.length; i++) {',
    '    if (args[i] === "--game" && args[i + 1]) {',
    '      const val = args[++i];',
    '      game = val === "all" ? "all" : val as GameId;',
    '    } else if (args[i] === "--platform" && args[i + 1]) {',
    '      const val = args[++i];',
    '      platform = val === "all" ? "all" : val as PlatformId;',
    '    }',
    '  }',
    '',
    '  return {',
    '    game: game ?? DEFAULT_GAME,',
    '    platform: platform ?? "all",',
    '  };',
    '}',
    '',
    'function main() {',
    '  const opts = parseArgs(process.argv);',
    '  const games = opts.game === "all" ? [...GAME_IDS] : [opts.game];',
    '',
    '  for (const game of games) {',
    '    const platforms = opts.platform === "all"',
    '      ? getSupportedPlatforms(game)',
    '      : [opts.platform];',
    '    for (const platform of platforms) {',
    '      runPipeline(GAME_PLATFORMS, { game, platform });',
    '    }',
    '  }',
    '}',
    '',
    'const isStandalone =',
    "  process.argv[1]?.endsWith('extract-game-data.ts') ||",
    "  process.argv[1]?.endsWith('extract-game-data');",
    '',
    'if (isStandalone) main();',
  ].join('\n'));

  // Per-game export-game-data template
  const exDir = gameDir + '/export-game-data.ts';
  write(p(exDir), [
    '/**',
    ' * Stage 1: parse game executable/data tables -> JSON.',
    ' * Replace the body with your reverse-engineered parsing.',
    ' */',
    "import { resolve } from 'node:path';",
    "import { mkdirSync } from 'node:fs';",
    "import { writeJson } from '@seer/pipeline';",
    '',
    'function main() {',
    '  const dataDir = process.argv[2];',
    '  if (!dataDir) {',
    "    console.error('Usage: npx tsx tools/" + game + "/export-game-data.ts <dataDir>');",
    '    process.exit(1);',
    '  }',
    '',
    '  // TODO: parse your game data tables here.',
    "  const outDir = resolve('data/extracted/" + game + "');",
    '  mkdirSync(outDir, { recursive: true });',
    "  writeJson(resolve(outDir, 'entities.json'), []);",
    '  console.log("Wrote placeholder output to " + outDir);',
    '}',
    '',
    'main();',
  ].join('\n'));

  // Per-game build-assets template
  const baDir = gameDir + '/build-assets.ts';
  write(p(baDir), [
    '/**',
    ' * Stage 2: decode resource files -> web-native PNG + JSON.',
    ' * Replace the body with your format decoders.',
    ' */',
    "import { resolve } from 'node:path';",
    "import { mkdirSync } from 'node:fs';",
    "import { writeJson } from '@seer/pipeline';",
    "import { getGameConfig } from '../shared/game-config.ts';",
    '',
    'function main() {',
    '  const dataDir = process.argv[2];',
    '  if (!dataDir) {',
    "    console.error('Usage: npx tsx tools/" + game + "/build-assets.ts <dataDir>');",
    '    process.exit(1);',
    '  }',
    '',
    "  const config = getGameConfig('" + game + "', '" + platform + "');",
    "  if (!config) throw new Error('Missing " + game + "/" + platform + " config');",
    '',
    "  const outDir = resolve('public/assets', config.assetDir, config.platform);",
    '  mkdirSync(outDir, { recursive: true });',
    '',
    '  writeJson(resolve(outDir, "atlas.json"), {',
    '    imageUrl: "/assets/" + config.assetDir + "/" + config.platform + "/atlas.png",',
    '    cellWidth: 16,',
    '    cellHeight: 16,',
    '    columns: 1,',
    '    rows: 1,',
    '  });',
    '',
    '  console.log("Wrote placeholder manifest to " + outDir);',
    '}',
    '',
    'main();',
  ].join('\n'));

  // ── seer.config.ts ─────────────────────────────────────────────────

  write(p('seer.config.ts'), [
    "import { defineGameConfig } from '@seer/pipeline';",
    '',
    'export default defineGameConfig([{',
    "  game: '" + game + "',",
    "  platform: '" + platform + "',",
    "  displayName: '" + displayName + ' (' + capitalize(platform) + ")',",
    "  dataDirs: ['" + game + '/' + platform + "'],",
    '  executable: undefined,',
    '  expectedFiles: [],',
    '  supported: false,',
    "  assetDir: '" + game + "',",
    '  features: {},',
    '  // Register pipeline steps here once implemented:',
    '  // exportGameData: (cfg, dataDir) => { ... },',
    '  // buildAssets:    (cfg, dataDir) => { ... },',
    '}]);',
  ].join('\n'));

  console.log('Scaffolded ' + displayName + ' project at ' + targetDir);
  console.log('  Next steps:');
  console.log('    cd ' + resolve(targetDir));
  console.log('    npm install');
  console.log('    npm run dev');
}
