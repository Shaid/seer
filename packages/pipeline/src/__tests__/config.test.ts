import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getGameConfig,
  getSupportedPlatforms,
  resType,
  resolveDataDir,
  findFileCI,
  defineGameConfig,
  flattenConfigs,
  getPlatformConfig,
  getAllSupportedPlatforms,
  type PlatformConfig,
  type GameConfig,
} from '../config.ts';

const PLACEHOLDER: PlatformConfig = {
  game: 'game1',
  platform: 'platform1',
  dataDirs: ['game1/platform1'],
  expectedFiles: [],
  supported: false,
  assetDir: 'game1',
};

const PLATFORMS: PlatformConfig[] = [PLACEHOLDER];

describe('getGameConfig / getSupportedPlatforms (flat)', () => {
  it('finds the config', () => {
    const config = getGameConfig(PLATFORMS, 'game1', 'platform1');
    expect(config).toBeDefined();
    expect(config?.assetDir).toBe('game1');
  });

  it('returns undefined for an unknown combination', () => {
    expect(getGameConfig(PLATFORMS, 'game1', 'not-a-real-platform')).toBeUndefined();
  });

  it('returns only supported platforms for a game', () => {
    const platforms = getSupportedPlatforms(PLATFORMS, 'game1');
    // The placeholder config has supported: false
    expect(platforms).toEqual([]);
  });
});

describe('defineGameConfig / flattenConfigs', () => {
  const GAME: GameConfig = {
    id: 'wime',
    displayName: 'War in Middle Earth',
    platforms: [
      { platform: 'amiga', dataDirs: ['wime/amiga'], expectedFiles: ['a'], supported: true, assetDir: 'wime' },
      { platform: 'dos', dataDirs: ['wime/dos'], expectedFiles: ['b'], supported: false, assetDir: 'wime' },
    ],
  };

  it('returns the config unchanged', () => {
    const input = [GAME];
    const result = defineGameConfig(input);
    expect(result).toStrictEqual(input);
  });

  it('flattens into PlatformConfig[] with game back-references', () => {
    const flat = flattenConfigs([GAME]);
    expect(flat).toHaveLength(2);
    expect(flat[0].game).toBe('wime');
    expect(flat[0].platform).toBe('amiga');
    expect(flat[1].game).toBe('wime');
    expect(flat[1].platform).toBe('dos');
  });
});

describe('getPlatformConfig', () => {
  const GAME: GameConfig = {
    id: 'spirit',
    displayName: 'Spirit of Excalibur',
    platforms: [
      { platform: 'amiga', dataDirs: ['spirit/amiga'], expectedFiles: [], supported: true, assetDir: 'spirit' },
    ],
  };

  it('finds a platform by game+platform id', () => {
    const p = getPlatformConfig([GAME], 'spirit', 'amiga');
    expect(p).toBeDefined();
    expect(p?.assetDir).toBe('spirit');
  });

  it('returns undefined for a missing game', () => {
    expect(getPlatformConfig([GAME], 'nope', 'amiga')).toBeUndefined();
  });

  it('returns undefined for a missing platform', () => {
    expect(getPlatformConfig([GAME], 'spirit', 'dos')).toBeUndefined();
  });
});

describe('getAllSupportedPlatforms', () => {
  const GAME: GameConfig = {
    id: 'conan',
    displayName: 'Conan',
    platforms: [
      { platform: 'amiga', dataDirs: [], expectedFiles: [], supported: true, assetDir: 'c' },
      { platform: 'dos', dataDirs: [], expectedFiles: [], supported: false, assetDir: 'c' },
      { platform: 'iigs', dataDirs: [], expectedFiles: [], supported: true, assetDir: 'c' },
    ],
  };

  it('returns only supported platform IDs', () => {
    expect(getAllSupportedPlatforms([GAME], 'conan')).toEqual(['amiga', 'iigs']);
  });

  it('returns empty for an unknown game', () => {
    expect(getAllSupportedPlatforms([GAME], 'nope')).toEqual([]);
  });
});

describe('resType', () => {
  it('falls back to uppercase for logical types with no override', () => {
    const config: PlatformConfig = {
      game: 'game1',
      platform: 'platform1',
      dataDirs: ['x'],
      expectedFiles: [],
      supported: true,
      assetDir: 'x',
    };
    expect(resType(config, 'image')).toBe('IMAGE');
  });

  it('uses typeCodes override when present', () => {
    const config: PlatformConfig = {
      game: 'game1',
      platform: 'platform1',
      dataDirs: ['x'],
      expectedFiles: [],
      supported: true,
      assetDir: 'x',
      typeCodes: { image: 'EGAMI' },
    };
    expect(resType(config, 'image')).toBe('EGAMI');
  });
});

// ─── resolveDataDir / findFileCI: exercised against a synthetic data/ tree ──
describe('resolveDataDir', () => {
  const FIXTURE_ROOT = join(process.cwd(), 'data', '__test_fixture__');

  function makeConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
    return {
      game: 'game1',
      platform: 'platform1',
      dataDirs: ['__test_fixture__'],
      expectedFiles: ['GAME.EXE'],
      supported: true,
      assetDir: 'fixture',
      ...overrides,
    };
  }

  beforeEach(() => {
    mkdirSync(FIXTURE_ROOT, { recursive: true });
  });

  afterEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('finds the data dir when the executable sits directly in the base', () => {
    writeFileSync(join(FIXTURE_ROOT, 'game.exe'), '');
    const config = makeConfig({ executable: 'GAME.EXE' });
    expect(resolveDataDir(config)).toBe(FIXTURE_ROOT);
  });

  it('finds the data dir nested under an arbitrary subfolder (shallowest match wins)', () => {
    const nested = join(FIXTURE_ROOT, 'disk1', 'extracted');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'GAME.EXE'), '');
    const config = makeConfig({ executable: 'GAME.EXE' });
    expect(resolveDataDir(config)).toBe(nested);
  });

  it('matches by expectedFiles when there is no executable', () => {
    writeFileSync(join(FIXTURE_ROOT, 'assets.dat'), '');
    const config = makeConfig({ executable: undefined, expectedFiles: ['ASSETS.DAT'] });
    expect(resolveDataDir(config)).toBe(FIXTURE_ROOT);
  });

  it('returns undefined when nothing matches', () => {
    const config = makeConfig({ executable: 'NOTHING.EXE', expectedFiles: ['NOTHING.DAT'] });
    expect(resolveDataDir(config)).toBeUndefined();
  });

  it('returns undefined when the base directory does not exist at all', () => {
    const config = makeConfig({ dataDirs: ['__does_not_exist__'] });
    expect(resolveDataDir(config)).toBeUndefined();
  });

  it('accepts a custom dataRoot instead of defaulting to <cwd>/data', () => {
    const customRoot = join(process.cwd(), 'data', '__custom_root__');
    const nested = join(customRoot, 'mygame', 'amiga');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'GAME.EXE'), '');
    const config = makeConfig({ dataDirs: ['mygame/amiga'], executable: 'GAME.EXE' });
    expect(resolveDataDir(config, customRoot)).toBe(nested);
    rmSync(customRoot, { recursive: true, force: true });
  });
});

describe('findFileCI', () => {
  const FIXTURE_ROOT = join(process.cwd(), 'data', '__test_fixture_ci__');

  beforeEach(() => mkdirSync(FIXTURE_ROOT, { recursive: true }));
  afterEach(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

  it('resolves a filename regardless of case', () => {
    writeFileSync(join(FIXTURE_ROOT, 'DATA.BIN'), '');
    expect(findFileCI(FIXTURE_ROOT, 'data.bin')).toBe('DATA.BIN');
  });

  it('falls back to the given name if nothing matches', () => {
    expect(findFileCI(FIXTURE_ROOT, 'missing.bin')).toBe('missing.bin');
  });
});
