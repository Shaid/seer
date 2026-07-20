import { describe, it, expect } from 'vitest';
import { getGameConfig } from '../game-config.ts';

describe('getGameConfig', () => {
  it('finds the placeholder config', () => {
    const config = getGameConfig('<%= it.game %>', '<%= it.platform %>');
    expect(config).toBeDefined();
    expect(config?.assetDir).toBe('<%= it.game %>');
  });
});
