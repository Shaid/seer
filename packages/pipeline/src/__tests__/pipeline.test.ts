import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flattenConfigs } from '../config.ts';
import { runPipeline, type PipelineEntry } from '../pipeline.ts';

// Fixture data dir shared by all tests below: data/__pipeline_test__/<platform>/GAME.EXE
const FIXTURE_ROOT = resolve(process.cwd(), 'data', '__pipeline_test__');

function makeEntry(overrides: Partial<PipelineEntry> = {}): PipelineEntry {
  return {
    game: 'demo',
    platform: 'amiga',
    dataDirs: ['__pipeline_test__/amiga'],
    executable: 'GAME.EXE',
    // DATA.DAT lets the fixture dir still resolve even when GAME.EXE itself
    // is removed to test the "executable missing" skip path in isolation.
    expectedFiles: ['GAME.EXE', 'DATA.DAT'],
    supported: true,
    assetDir: 'demo',
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
    const entry = makeEntry({ dataDirs: ['__does_not_exist__'] });
    const results = await runPipeline([entry]);
    expect(results).toHaveLength(1);
    expect(results[0].steps).toEqual([]);
  });

  it('skips exportGameData/buildAssets when not registered, reporting success', async () => {
    const entry = makeEntry();
    const results = await runPipeline([entry]);
    expect(results[0].steps).toEqual([
      ['export-game-data (skipped)', true],
      ['build-assets (skipped)', true],
    ]);
  });

  it('skips exportGameData when the executable is missing on disk, even if registered', async () => {
    rmSync(resolve(dataDir, 'GAME.EXE'));
    const exportGameData = vi.fn();
    const entry = makeEntry({ exportGameData });
    const results = await runPipeline([entry]);
    expect(exportGameData).not.toHaveBeenCalled();
    expect(results[0].steps).toEqual([
      ['export-game-data (skipped)', true],
      ['build-assets (skipped)', true],
    ]);
  });

  it('runs a synchronous exportGameData/buildAssets step and reports success', async () => {
    const exportGameData = vi.fn();
    const buildAssets = vi.fn();
    const entry = makeEntry({ exportGameData, buildAssets });
    const results = await runPipeline([entry]);

    expect(exportGameData).toHaveBeenCalledWith(entry, dataDir);
    expect(buildAssets).toHaveBeenCalledWith(entry, dataDir);
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
    const entry = makeEntry({ exportGameData, buildAssets });
    const results = await runPipeline([entry]);

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
    const entry = makeEntry({ exportGameData });
    const results = await runPipeline([entry]);

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
    const entry = makeEntry({ exportGameData });
    const results = await runPipeline([entry]);

    expect(results[0].steps).toEqual([
      ['export-game-data', false],
      ['build-assets (skipped)', true],
    ]);
  });

  it('skips unsupported configs entirely', async () => {
    const exportGameData = vi.fn();
    const entry = makeEntry({ supported: false, exportGameData });
    const results = await runPipeline([entry]);
    expect(exportGameData).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('expands game "all" to every distinct game in the entries', async () => {
    const a = makeEntry({ game: 'a', dataDirs: ['__pipeline_test__/amiga'] });
    const b = makeEntry({ game: 'b', dataDirs: ['__pipeline_test__/amiga'] });
    const results = await runPipeline([a, b], { game: 'all', platform: 'amiga' });
    expect(results.map((r) => r.game).sort()).toEqual(['a', 'b']);
  });

  it('expands platform "all" to every supported platform for a game', async () => {
    const dosDir = resolve(FIXTURE_ROOT, 'dos');
    mkdirSync(dosDir, { recursive: true });
    writeFileSync(resolve(dosDir, 'GAME.EXE'), '');

    const amiga = makeEntry({ platform: 'amiga' });
    const dos = makeEntry({ platform: 'dos', dataDirs: ['__pipeline_test__/dos'] });
    const results = await runPipeline([amiga, dos], { game: 'demo', platform: 'all' });
    expect(results.map((r) => r.platform).sort()).toEqual(['amiga', 'dos']);
  });

  it('respects a custom dataDir root passed via options', async () => {
    const customRoot = resolve(process.cwd(), 'data', '__pipeline_test_custom_root__');
    const nested = resolve(customRoot, 'demo', 'amiga');
    mkdirSync(nested, { recursive: true });
    writeFileSync(resolve(nested, 'GAME.EXE'), '');

    const entry = makeEntry({ dataDirs: ['demo/amiga'] });
    const results = await runPipeline([entry], { dataDir: customRoot });
    expect(results[0].steps).toEqual([
      ['export-game-data (skipped)', true],
      ['build-assets (skipped)', true],
    ]);

    rmSync(customRoot, { recursive: true, force: true });
  });

  it('defaults to the first entry when game/platform are omitted', async () => {
    const entry = makeEntry();
    const results = await runPipeline([entry]);
    expect(results).toHaveLength(1);
    expect(results[0].game).toBe('demo');
    expect(results[0].platform).toBe('amiga');
  });

  it('returns an empty array and logs an error when entries is empty', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await runPipeline([]);
    expect(results).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('works with flattened GameConfig[] via flattenConfigs', async () => {
    const flat = flattenConfigs([
      {
        id: 'demo',
        displayName: 'Demo',
        platforms: [
          { platform: 'amiga', dataDirs: ['__pipeline_test__/amiga'], expectedFiles: ['GAME.EXE', 'DATA.DAT'], supported: true, assetDir: 'demo' },
        ],
      },
    ]) as PipelineEntry[];
    const results = await runPipeline(flat);
    expect(results).toHaveLength(1);
    expect(results[0].game).toBe('demo');
    expect(results[0].platform).toBe('amiga');
  });
});
