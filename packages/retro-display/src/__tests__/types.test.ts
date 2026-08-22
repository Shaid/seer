import { describe, expect, it } from 'vitest';
import { DISPLAY_PROFILE_PRESETS, resolveRetroDisplayOptions, type DisplayProfile } from '../types.js';

const ALL_PROFILES: DisplayProfile[] = [
  'none',
  'crt-shadow-mask',
  'crt-aperture-grille',
  'crt-slot-mask',
  'lcd-subpixel',
];

describe('DISPLAY_PROFILE_PRESETS', () => {
  it('has an entry for every DisplayProfile', () => {
    for (const profile of ALL_PROFILES) {
      expect(DISPLAY_PROFILE_PRESETS[profile]).toBeDefined();
    }
  });

  it('gives "none" an empty preset (pure passthrough)', () => {
    expect(DISPLAY_PROFILE_PRESETS.none).toEqual({});
  });

  it('gives "lcd-subpixel" zero scanline intensity (no scanlines on a flat panel)', () => {
    expect(DISPLAY_PROFILE_PRESETS['lcd-subpixel'].scanlineIntensity).toBe(0);
  });

  it('every non-"none" preset value falls within its documented 0..1 range where applicable', () => {
    for (const profile of ALL_PROFILES) {
      const preset = DISPLAY_PROFILE_PRESETS[profile];
      for (const key of ['scanlineIntensity', 'maskIntensity', 'vignette', 'glow'] as const) {
        const value = preset[key];
        if (value !== undefined) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('resolveRetroDisplayOptions', () => {
  it('fills in the package-wide defaults for "none" (no preset overrides)', () => {
    const resolved = resolveRetroDisplayOptions({ profile: 'none' });
    expect(resolved).toEqual({
      profile: 'none',
      scanlineIntensity: 0.3,
      maskIntensity: 0.25,
      curvature: 0,
      vignette: 0.15,
      glow: 0.2,
      chromaticAberration: 0,
      brightness: 1.1,
    });
  });

  it('applies the profile preset over the bare defaults', () => {
    const resolved = resolveRetroDisplayOptions({ profile: 'lcd-subpixel' });
    expect(resolved.scanlineIntensity).toBe(0);
    expect(resolved.glow).toBe(0);
    expect(resolved.brightness).toBe(1.0);
    // curvature/chromaticAberration have no lcd-subpixel preset entry — falls through to the bare default.
    expect(resolved.curvature).toBe(0);
  });

  it('an explicit option always wins over that profile\'s preset', () => {
    const resolved = resolveRetroDisplayOptions({ profile: 'crt-shadow-mask', scanlineIntensity: 0.9 });
    expect(resolved.scanlineIntensity).toBe(0.9);
    // Untouched fields still come from the preset.
    expect(resolved.maskIntensity).toBe(0.25);
  });

  it('every DisplayProfile resolves to a fully-populated RequiredRetroDisplayOptions', () => {
    for (const profile of ALL_PROFILES) {
      const resolved = resolveRetroDisplayOptions({ profile });
      expect(resolved.profile).toBe(profile);
      expect(typeof resolved.scanlineIntensity).toBe('number');
      expect(typeof resolved.maskIntensity).toBe('number');
      expect(typeof resolved.curvature).toBe('number');
      expect(typeof resolved.vignette).toBe('number');
      expect(typeof resolved.glow).toBe('number');
      expect(typeof resolved.chromaticAberration).toBe('number');
      expect(typeof resolved.brightness).toBe('number');
    }
  });
});
