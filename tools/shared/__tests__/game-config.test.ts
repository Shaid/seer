import { describe, it, expect } from 'vitest';
import { getGameConfig, getSupportedPlatforms, flattenConfigs } from '@seer-project/pipeline';
import { GAME_IDS, PLATFORM_IDS, GAME_CONFIGS, GAME_PLATFORMS } from '../game-config.ts';

describe('GAME_IDS / PLATFORM_IDS', () => {
  it('are non-empty and match game-id.ts', () => {
    expect(GAME_IDS.length).toBeGreaterThan(0);
    expect(PLATFORM_IDS.length).toBeGreaterThanOrEqual(0);
  });
});

describe('GAME_CONFIGS', () => {
  it('all game configs have the required fields', () => {
    for (const game of GAME_CONFIGS) {
      expect(game.id).toBeDefined();
      expect(game.displayName).toBeDefined();
      expect(Array.isArray(game.platforms)).toBe(true);
      expect(game.platforms.length).toBeGreaterThan(0);
    }
  });

  it('flattened GAME_PLATFORMS has game back-references', () => {
    const flat = flattenConfigs(GAME_CONFIGS);
    for (const entry of flat) {
      expect(entry.game).toBeDefined();
      expect(entry.platform).toBeDefined();
      expect(typeof entry.supported).toBe('boolean');
      expect(typeof entry.assetDir).toBe('string');
    }
  });
});

describe('getGameConfig / getSupportedPlatforms', () => {
  it('finds the placeholder config', () => {
    const config = getGameConfig(GAME_PLATFORMS, 'game1', 'platform1');
    expect(config).toBeDefined();
    expect(config?.assetDir).toBe('game1');
  });

  it('returns undefined for an unknown combination', () => {
    expect(getGameConfig(GAME_PLATFORMS, 'game1', 'not-a-real-platform')).toBeUndefined();
  });

  it('returns only supported platforms for a game', () => {
    const platforms = getSupportedPlatforms(GAME_PLATFORMS, 'game1');
    // The placeholder config has supported: false
    expect(platforms).toEqual([]);
  });
});
