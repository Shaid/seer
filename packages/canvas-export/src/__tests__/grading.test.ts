import { describe, expect, it } from 'vitest';
import { buildGradingFilterString, isCtxFilterSupported } from '../grading.js';

describe('buildGradingFilterString', () => {
  it('returns "none" when called with no options', () => {
    expect(buildGradingFilterString()).toBe('none');
  });

  it('returns "none" when every option is explicitly at its neutral default', () => {
    expect(
      buildGradingFilterString({ brightness: 1, contrast: 1, saturate: 1, hueRotate: 0 }),
    ).toBe('none');
  });

  it('returns "none" when only a subset of options is given, all neutral', () => {
    expect(buildGradingFilterString({ brightness: 1 })).toBe('none');
  });

  it('builds the full filter string when brightness differs', () => {
    expect(buildGradingFilterString({ brightness: 1.2 })).toBe(
      'brightness(1.2) contrast(1) saturate(1) hue-rotate(0deg)',
    );
  });

  it('builds the full filter string when contrast differs', () => {
    expect(buildGradingFilterString({ contrast: 0.8 })).toBe(
      'brightness(1) contrast(0.8) saturate(1) hue-rotate(0deg)',
    );
  });

  it('builds the full filter string when saturate differs', () => {
    expect(buildGradingFilterString({ saturate: 1.5 })).toBe(
      'brightness(1) contrast(1) saturate(1.5) hue-rotate(0deg)',
    );
  });

  it('builds the full filter string when hueRotate differs', () => {
    expect(buildGradingFilterString({ hueRotate: 45 })).toBe(
      'brightness(1) contrast(1) saturate(1) hue-rotate(45deg)',
    );
  });

  it('builds the full filter string when every option differs', () => {
    expect(
      buildGradingFilterString({ brightness: 1.1, contrast: 0.9, saturate: 1.3, hueRotate: -30 }),
    ).toBe('brightness(1.1) contrast(0.9) saturate(1.3) hue-rotate(-30deg)');
  });
});

describe('isCtxFilterSupported', () => {
  it('returns true for a context object that has a filter property', () => {
    expect(isCtxFilterSupported({ filter: 'none' } as unknown as CanvasRenderingContext2D)).toBe(true);
  });

  it('returns false for a context object without a filter property', () => {
    expect(isCtxFilterSupported({} as unknown as CanvasRenderingContext2D)).toBe(false);
  });
});
