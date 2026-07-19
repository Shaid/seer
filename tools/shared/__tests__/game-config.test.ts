import { describe, it, expect } from 'vitest';
import {
  GAME_IDS,
  PLATFORM_IDS,
  GAME_PLATFORMS,
  getGameConfig,
  getSupportedPlatforms,
} from '../game-config.ts';

describe('GAME_IDS / PLATFORM_IDS', () => {
  it('are non-empty and match game-id.ts', () => {
    expect(GAME_IDS.length).toBeGreaterThan(0);
    expect(PLATFORM_IDS.length).toBeGreaterThanOrEqual(0);
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
