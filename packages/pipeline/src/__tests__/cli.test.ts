import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseArgs,
  loadConfig,
  CONFIG_FILENAMES,
  cmdDoctor,
  cmdExtract,
  cmdHexDump,
} from '../cli.js';
import type { GameConfig } from '../config.js';

describe('parseArgs', () => {
  it('extracts --game and --platform', () => {
    const result = parseArgs([
      'node',
      'seer',
      'extract',
      '--game',
      'mygame',
      '--platform',
      'amiga',
    ]);
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

  it('loads a nested GameConfig[] from a .ts config file', async () => {
    const dir = resolve(tmpDir, 'ts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'seer.config.ts'),
      `export default [{ id: 'ts-game', displayName: 'TS Game', platforms: [{ platform: 'p1', dataDirs: ['ts/p1'], expectedFiles: [], supported: true, assetDir: 'ts' }] }];\n`,
    );
    const configs = await loadConfig(dir);
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('ts-game');
    expect(configs[0].platforms).toHaveLength(1);
    expect(configs[0].platforms[0].platform).toBe('p1');
  });

  it('loads a .js config file', async () => {
    const dir = resolve(tmpDir, 'js');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'seer.config.js'),
      `export default [{ id: 'js-game', displayName: 'JS Game', platforms: [{ platform: 'p1', dataDirs: ['js/p1'], expectedFiles: [], supported: true, assetDir: 'js' }] }];\n`,
    );
    const configs = await loadConfig(dir);
    expect(configs[0].id).toBe('js-game');
    expect(configs[0].platforms[0].platform).toBe('p1');
  });

  it('wraps a single-object flat config in a synthetic GameConfig', async () => {
    const dir = resolve(tmpDir, 'single');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'seer.config.ts'),
      `export default { game: 'single', platform: 'p1', displayName: 'Single', dataDirs: ['s/p1'], expectedFiles: [], supported: true, assetDir: 's' };\n`,
    );
    const configs = await loadConfig(dir);
    expect(Array.isArray(configs)).toBe(true);
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('single');
    expect(configs[0].platforms[0].platform).toBe('p1');
  });

  it('wraps a legacy flat array in synthetic GameConfig entries', async () => {
    const dir = resolve(tmpDir, 'flat');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'seer.config.ts'),
      `export default [{ game: 'g1', platform: 'p1', displayName: 'Flat', dataDirs: ['g1/p1'], expectedFiles: [], supported: true, assetDir: 'g1' }];\n`,
    );
    const configs = await loadConfig(dir);
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('g1');
    expect(configs[0].displayName).toBe('Flat');
    expect(configs[0].platforms[0].platform).toBe('p1');
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

function makeGameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    id: 'demo',
    displayName: 'Demo',
    platforms: [
      {
        platform: 'amiga',
        dataDirs: ['__cli_test__/amiga'],
        executable: 'GAME.EXE',
        expectedFiles: ['GAME.EXE'],
        supported: true,
        assetDir: 'demo',
      },
    ],
    ...overrides,
  };
}

describe('cmdDoctor', () => {
  const fixtureRoot = resolve(process.cwd(), 'data', '__cli_test__');
  const dataDir = resolve(fixtureRoot, 'amiga');
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function loggedText(): string {
    return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  it('resolves and reports the data dir when it exists on disk', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, 'GAME.EXE'), '');

    cmdDoctor([makeGameConfig()]);

    expect(loggedText()).toContain(`Data dir: found at ${dataDir}`);
  });

  it('reports the data dir as not found when nothing matches on disk', () => {
    cmdDoctor([
      makeGameConfig({
        platforms: [
          {
            platform: 'amiga',
            dataDirs: ['__does_not_exist__'],
            expectedFiles: ['GAME.EXE'],
            supported: true,
            assetDir: 'demo',
          },
        ],
      }),
    ]);

    const warnedText = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warnedText).toContain('Data dir: not found');
  });

  it('groups multiple platform entries under one game heading', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, 'GAME.EXE'), '');

    cmdDoctor([
      makeGameConfig({
        platforms: [
          {
            platform: 'amiga',
            dataDirs: ['__cli_test__/amiga'],
            executable: 'GAME.EXE',
            expectedFiles: ['GAME.EXE'],
            supported: true,
            assetDir: 'demo',
          },
          {
            platform: 'dos',
            dataDirs: ['__does_not_exist_dos__'],
            expectedFiles: ['GAME.EXE'],
            supported: false,
            assetDir: 'demo',
          },
        ],
      }),
    ]);

    const text = loggedText();
    expect(text).toContain('Found 1 game(s), 2 game+platform entries in config.');
    expect(text).toContain('Platform: amiga');
    expect(text).toContain('Platform: dos (not marked supported)');
  });

  it('reports registered pipeline steps', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, 'GAME.EXE'), '');

    cmdDoctor([
      makeGameConfig({
        platforms: [
          {
            platform: 'amiga',
            dataDirs: ['__cli_test__/amiga'],
            executable: 'GAME.EXE',
            expectedFiles: ['GAME.EXE'],
            supported: true,
            assetDir: 'demo',
            exportGameData: () => {},
          },
        ],
      }),
    ]);

    const text = loggedText();
    expect(text).toContain('exportGameData: registered');
    expect(text).toContain('buildAssets:    not registered');
  });

  it('accepts a custom dataDir override', () => {
    const customRoot = resolve(process.cwd(), 'data', '__cli_test_custom__');
    const nested = resolve(customRoot, 'demo', 'amiga');
    mkdirSync(nested, { recursive: true });
    writeFileSync(resolve(nested, 'GAME.EXE'), '');

    cmdDoctor(
      [
        makeGameConfig({
          platforms: [
            {
              platform: 'amiga',
              dataDirs: ['demo/amiga'],
              executable: 'GAME.EXE',
              expectedFiles: ['GAME.EXE'],
              supported: true,
              assetDir: 'demo',
            },
          ],
        }),
      ],
      customRoot,
    );

    expect(loggedText()).toContain(`Data dir: found at ${nested}`);
    rmSync(customRoot, { recursive: true, force: true });
  });
});

describe('cmdExtract', () => {
  const fixtureRoot = resolve(process.cwd(), 'data', '__cli_extract_test__');
  const dataDir = resolve(fixtureRoot, 'amiga');
  let exitSpy: MockInstance;

  beforeEach(() => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, 'GAME.EXE'), '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not exit when all steps succeed', async () => {
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__cli_extract_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE'],
          supported: true,
          assetDir: 'demo',
          exportGameData: () => {},
          buildAssets: () => {},
        },
      ],
    });
    await cmdExtract([config], 'demo', 'amiga');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with code 1 when a step fails', async () => {
    const config = makeGameConfig({
      platforms: [
        {
          platform: 'amiga',
          dataDirs: ['__cli_extract_test__/amiga'],
          executable: 'GAME.EXE',
          expectedFiles: ['GAME.EXE'],
          supported: true,
          assetDir: 'demo',
          exportGameData: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    await cmdExtract([config], 'demo', 'amiga');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when no game+platform combination matches', async () => {
    await cmdExtract([], 'demo', 'amiga');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('cmdHexDump', () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with code 1 when no file argument is given', () => {
    cmdHexDump([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('dumps a real file without exiting', () => {
    cmdHexDump([resolve(__dirname, '../cli.ts')]);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
