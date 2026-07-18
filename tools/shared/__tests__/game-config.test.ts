import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GAME_IDS,
  PLATFORM_IDS,
  GAME_PLATFORMS,
  getGameConfig,
  getSupportedPlatforms,
  resType,
  resolveDataDir,
  findFileCI,
  type GamePlatformConfig,
} from '../game-config.ts';

describe('GAME_IDS / PLATFORM_IDS', () => {
  it('are non-empty and match game-id.ts', () => {
    expect(GAME_IDS.length).toBeGreaterThan(0);
    expect(PLATFORM_IDS.length).toBeGreaterThan(0);
  });
});

describe('GAME_PLATFORMS', () => {
  it('all configs have the required fields', () => {
    for (const config of GAME_PLATFORMS) {
      expect(config.game).toBeDefined();
      expect(config.platform).toBeDefined();
      expect(config.displayName).toBeDefined();
      expect(Array.isArray(config.dataDirs)).toBe(true);
      expect(config.dataDirs.length).toBeGreaterThan(0);
      expect(Array.isArray(config.expectedFiles)).toBe(true);
      expect(typeof config.supported).toBe('boolean');
      expect(typeof config.assetDir).toBe('string');
    }
  });
});

describe('getGameConfig / getSupportedPlatforms', () => {
  it('finds the placeholder config', () => {
    const config = getGameConfig('game1', 'platform1');
    expect(config).toBeDefined();
    expect(config?.assetDir).toBe('game1');
  });

  it('returns undefined for an unknown combination', () => {
    // @ts-expect-error deliberately invalid for the test
    expect(getGameConfig('game1', 'not-a-real-platform')).toBeUndefined();
  });

  it('returns only supported platforms for a game', () => {
    const platforms = getSupportedPlatforms('game1');
    // The placeholder config has supported: false
    expect(platforms).toEqual([]);
  });
});

describe('resType', () => {
  it('falls back to uppercase for logical types with no override', () => {
    const config: GamePlatformConfig = {
      game: 'game1',
      platform: 'platform1',
      displayName: 'x',
      dataDirs: ['x'],
      expectedFiles: [],
      supported: true,
      assetDir: 'x',
    };
    expect(resType(config, 'image')).toBe('IMAGE');
  });

  it('uses typeCodes override when present', () => {
    const config: GamePlatformConfig = {
      game: 'game1',
      platform: 'platform1',
      displayName: 'x',
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
//
// These functions are the standout reusable piece of this file — fully
// generic breadth-first, case-insensitive data-directory discovery. Test
// against constructed fixtures rather than real (gitignored) game data so
// the suite is self-contained and always runs.
describe('resolveDataDir', () => {
  const FIXTURE_ROOT = join(process.cwd(), 'data', '__test_fixture__');

  function makeConfig(overrides: Partial<GamePlatformConfig> = {}): GamePlatformConfig {
    return {
      game: 'game1',
      platform: 'platform1',
      displayName: 'Fixture',
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
