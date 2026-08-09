import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameConfig } from '../config.js';
import { runPipeline } from '../pipeline.js';

const FIXTURE_ROOT = resolve(process.cwd(), 'data', '__pipeline_test__');

function makeGameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    id: 'demo',
    displayName: 'Demo',
    platforms: [
      {
        platform: 'amiga',
        dataDirs: ['__pipeline_test__/amiga'],
        executable: 'GAME.EXE',
        expectedFiles: ['GAME.EXE', 'DATA.DAT'],
        supported: true,
        assetDir: 'demo',
      },
    ],
    ...overrides,
  };
}

describe('runPipeline', () => {
  const dataDir = resolve(FIXTURE_ROOT, 'amiga');

  beforeEach(() => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, 'GAME.EXE'), '');
    writeFileSync(resolve(dataDir, 'DATA.DAT'), '');
  });

  afterEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports a config as failed when it has no data dir on disk', async () => {
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__does_not_exist__'],
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
        },
      ],
    });
    const results = await runPipeline([config]);
    expect(results).toHaveLength(1);
    expect(results[0].steps).toEqual([]);
  });

  it('skips exportGameData/buildAssets when not registered, reporting success', async () => {
    const config = makeGameConfig();
    const results = await runPipeline([config]);
    expect(results[0].steps).toEqual([
      ['export-game-data (skipped)', true],
      ['build-assets (skipped)', true],
    ]);
  });

  it('skips exportGameData when the executable is missing on disk, even if registered', async () => {
    rmSync(resolve(dataDir, 'GAME.EXE'));
    const exportGameData = vi.fn();
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
          exportGameData,
        },
      ],
    });
    const results = await runPipeline([config]);
    expect(exportGameData).not.toHaveBeenCalled();
    expect(results[0].steps).toEqual([
      ['export-game-data (skipped)', true],
      ['build-assets (skipped)', true],
    ]);
  });

  it('runs a synchronous exportGameData/buildAssets step and reports success', async () => {
    const exportGameData = vi.fn();
    const buildAssets = vi.fn();
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
          exportGameData,
          buildAssets,
        },
      ],
    });
    const results = await runPipeline([config]);

    const flatEntry = { ...config.platforms[0], game: 'demo' };
    expect(exportGameData).toHaveBeenCalledWith(flatEntry, dataDir);
    expect(buildAssets).toHaveBeenCalledWith(flatEntry, dataDir);
    expect(results[0].steps).toEqual([
      ['export-game-data', true],
      ['build-assets', true],
    ]);
  });

  it('catches a synchronous throw from a step and reports failure without stopping later steps', async () => {
    const exportGameData = vi.fn(() => {
      throw new Error('sync failure');
    });
    const buildAssets = vi.fn();
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
          exportGameData,
          buildAssets,
        },
      ],
    });
    const results = await runPipeline([config]);

    expect(buildAssets).toHaveBeenCalled();
    expect(results[0].steps).toEqual([
      ['export-game-data', false],
      ['build-assets', true],
    ]);
  });

  it('awaits an async step and reports success only after it resolves', async () => {
    const order: string[] = [];
    const exportGameData = vi.fn(async () => {
      order.push('start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('end');
    });
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
          exportGameData,
        },
      ],
    });
    const results = await runPipeline([config]);

    expect(order).toEqual(['start', 'end']);
    expect(results[0].steps).toEqual([
      ['export-game-data', true],
      ['build-assets (skipped)', true],
    ]);
  });

  it('catches a rejection thrown after an await inside an async step (regression)', async () => {
    const exportGameData = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('async failure after await');
    });
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
          exportGameData,
        },
      ],
    });
    const results = await runPipeline([config]);

    expect(results[0].steps).toEqual([
      ['export-game-data', false],
      ['build-assets (skipped)', true],
    ]);
  });

  it('skips unsupported configs entirely', async () => {
    const exportGameData = vi.fn();
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: false,
          assetDir: 'demo',
          exportGameData,
        },
      ],
    });
    const results = await runPipeline([config]);
    expect(exportGameData).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('expands game "all" to every distinct game in the config', async () => {
    const a: GameConfig = {
      id: 'a',
      displayName: 'A',
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'a',
        },
      ],
    };
    const b: GameConfig = {
      id: 'b',
      displayName: 'B',
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'b',
        },
      ],
    };
    const results = await runPipeline([a, b], { game: 'all', platform: 'amiga' });
    expect(results.map((r) => r.game).sort()).toEqual(['a', 'b']);
  });

  it('expands platform "all" to every supported platform for a game', async () => {
    const dosDir = resolve(FIXTURE_ROOT, 'dos');
    mkdirSync(dosDir, { recursive: true });
    writeFileSync(resolve(dosDir, 'GAME.EXE'), '');

    const config: GameConfig = {
      id: 'demo',
      displayName: 'Demo',
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__pipeline_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
        },
        {
          platform: 'dos',
          dataDirs: ['__pipeline_test__/dos'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
        },
      ],
    };
    const results = await runPipeline([config], { game: 'demo', platform: 'all' });
    expect(results.map((r) => r.platform).sort()).toEqual(['amiga', 'dos']);
  });

  it('respects a custom dataDir root passed via options', async () => {
    const customRoot = resolve(process.cwd(), 'data', '__pipeline_test_custom_root__');
    const nested = resolve(customRoot, 'demo', 'amiga');
    mkdirSync(nested, { recursive: true });
    writeFileSync(resolve(nested, 'GAME.EXE'), '');

    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['demo/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE', 'DATA.DAT'],
          supported: true,
          assetDir: 'demo',
        },
      ],
    });
    const results = await runPipeline([config], { dataDir: customRoot });
    expect(results[0].steps).toEqual([
      ['export-game-data (skipped)', true],
      ['build-assets (skipped)', true],
    ]);

    rmSync(customRoot, { recursive: true, force: true });
  });

  it('defaults to the first config entry when game/platform are omitted', async () => {
    const config = makeGameConfig();
    const results = await runPipeline([config]);
    expect(results).toHaveLength(1);
    expect(results[0].game).toBe('demo');
    expect(results[0].platform).toBe('amiga');
  });

  it('returns an empty array and logs an error when configs is empty', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await runPipeline([]);
    expect(results).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });
});
