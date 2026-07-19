import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getGameConfig,
  getSupportedPlatforms,
  resType,
  resolveDataDir,
  findFileCI,
  type GamePlatformConfig,
} from '../config.ts';

const PLACEHOLDER: GamePlatformConfig = {
  game: 'game1',
  platform: 'platform1',
  displayName: 'Placeholder',
  dataDirs: ['game1/platform1'],
  expectedFiles: [],
  supported: false,
  assetDir: 'game1',
};

const PLATFORMS: GamePlatformConfig[] = [PLACEHOLDER];

describe('getGameConfig / getSupportedPlatforms', () => {
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
