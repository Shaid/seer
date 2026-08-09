import { describe, it, expect } from 'vitest';
import { DisplayMode } from '../DisplayMode.js';

describe('DisplayMode', () => {
  it('starts in modern mode', () => {
    const dm = new DisplayMode();
    expect(dm.mode).toBe('modern');
  });

  it('returns config with default modern values', () => {
    const dm = new DisplayMode();
    const cfg = dm.config;
    expect(cfg.minZoom).toBe(0.25);
    expect(cfg.maxZoom).toBe(6);
    expect(cfg.scaleMode).toBe('nearest');
  });

  it('returns the same config reference each call', () => {
    const dm = new DisplayMode();
    expect(dm.config).toBe(dm.config);
  });
});
