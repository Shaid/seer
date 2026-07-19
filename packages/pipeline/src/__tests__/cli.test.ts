import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, loadConfig, CONFIG_FILENAMES } from '../cli.ts';

describe('parseArgs', () => {
  it('extracts --game and --platform', () => {
    const result = parseArgs(['node', 'seer', 'extract', '--game', 'mygame', '--platform', 'amiga']);
    expect(result).toEqual({ game: 'mygame', platform: 'amiga' });
  });

  it('returns undefined when flags are absent', () => {
    expect(parseArgs(['node', 'seer', 'extract'])).toEqual({});
  });

  it('ignores unknown flags', () => {
    const result = parseArgs(['node', 'seer', '--foo', 'bar', '--game', 'x']);
    expect(result.game).toBe('x');
  });
});

describe('loadConfig', () => {
  const tmpDir = resolve(__dirname, '__tmp_config_test__');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a .ts config file', async () => {
    const dir = resolve(tmpDir, 'ts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'seer.config.ts'),
      `export default [{ game: 'ts-game', platform: 'p1', displayName: 'TS Game', dataDirs: ['ts/p1'], expectedFiles: [], supported: true, assetDir: 'ts' }];\n`,
    );
    const configs = await loadConfig(dir);
    expect(configs).toHaveLength(1);
    expect(configs[0].game).toBe('ts-game');
  });

  it('loads a .js config file', async () => {
    const dir = resolve(tmpDir, 'js');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'seer.config.js'),
      `export default [{ game: 'js-game', platform: 'p1', displayName: 'JS Game', dataDirs: ['js/p1'], expectedFiles: [], supported: true, assetDir: 'js' }];\n`,
    );
    const configs = await loadConfig(dir);
    expect(configs[0].game).toBe('js-game');
  });

  it('wraps a single-object config in an array', async () => {
    const dir = resolve(tmpDir, 'single');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'seer.config.ts'),
      `export default { game: 'single', platform: 'p1', displayName: 'Single', dataDirs: ['s/p1'], expectedFiles: [], supported: true, assetDir: 's' };\n`,
    );
    const configs = await loadConfig(dir);
    expect(Array.isArray(configs)).toBe(true);
    expect(configs).toHaveLength(1);
    expect(configs[0].game).toBe('single');
  });

  it('throws when no config file exists', async () => {
    const emptyDir = resolve(tmpDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    await expect(loadConfig(emptyDir)).rejects.toThrow('No config file found');
  });

  it('checks all supported filenames', () => {
    expect(CONFIG_FILENAMES).toContain('seer.config.ts');
    expect(CONFIG_FILENAMES).toContain('seer.config.js');
  });
});
