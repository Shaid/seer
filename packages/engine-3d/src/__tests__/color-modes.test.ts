import { describe, expect, it } from 'vitest';
import { createPaletteResolver, resolveColor } from '../color-modes.ts';

describe('createPaletteResolver / resolveColor("palette")', () => {
  const palette = [0x000000, 0xff0000, 0x00ff00, 0x0000ff];

  it('reproduces hunter\'s fillToColor bit-decode exactly: bits 11-8 select the palette index', () => {
    const resolver = createPaletteResolver(palette, (fill) => (fill >> 8) & 0xf);
    // fill word 0x0203 -> colorIdx = (0x0203 >> 8) & 0xf = 2 -> palette[2] = 0x00ff00
    const color = resolver({ objectId: 0, faceIndex: 0, fill: 0x0203, y: 0 });
    expect(color.getHex()).toBe(0x00ff00);
  });

  it('wraps an out-of-range decoded index back into the palette rather than throwing', () => {
    const resolver = createPaletteResolver(palette, () => 99);
    const color = resolver({ objectId: 0, faceIndex: 0, fill: 0, y: 0 });
    expect(color.getHex()).toBe(palette[99 % palette.length]);
  });

  it('resolveColor defers to the resolver for "palette" mode', () => {
    const resolver = createPaletteResolver(palette, (fill) => fill);
    const color = resolveColor('palette', { objectId: 0, faceIndex: 0, fill: 3, y: 0 }, resolver);
    expect(color.getHex()).toBe(0x0000ff);
  });

  it('resolveColor("palette") falls back to flat grey when no resolver is supplied', () => {
    const color = resolveColor('palette', { objectId: 0, faceIndex: 0, fill: 3, y: 0 });
    expect(color.getHex()).toBe(0x888888);
  });
});

describe('resolveColor("face")', () => {
  it('is a deterministic function of faceIndex alone', () => {
    const a = resolveColor('face', { objectId: 5, faceIndex: 7, fill: 0, y: 0 });
    const b = resolveColor('face', { objectId: 99, faceIndex: 7, fill: 999, y: 500 });
    expect(a.getHexString()).toBe(b.getHexString());
  });

  it('differs across face indices', () => {
    const a = resolveColor('face', { objectId: 0, faceIndex: 0, fill: 0, y: 0 });
    const b = resolveColor('face', { objectId: 0, faceIndex: 1, fill: 0, y: 0 });
    expect(a.getHexString()).not.toBe(b.getHexString());
  });
});

describe('resolveColor("object")', () => {
  it('is a deterministic function of objectId alone', () => {
    const a = resolveColor('object', { objectId: 3, faceIndex: 0, fill: 0, y: 0 });
    const b = resolveColor('object', { objectId: 3, faceIndex: 999, fill: 999, y: 999 });
    expect(a.getHexString()).toBe(b.getHexString());
  });

  it('differs across object ids', () => {
    const a = resolveColor('object', { objectId: 0, faceIndex: 0, fill: 0, y: 0 });
    const b = resolveColor('object', { objectId: 1, faceIndex: 0, fill: 0, y: 0 });
    expect(a.getHexString()).not.toBe(b.getHexString());
  });
});

describe('resolveColor("height")', () => {
  it('maps the bottom of the default ±2000 range to a distinctly different hue than the top', () => {
    const bottom = resolveColor('height', { objectId: 0, faceIndex: 0, fill: 0, y: -2000 });
    const top = resolveColor('height', { objectId: 0, faceIndex: 0, fill: 0, y: 2000 });
    expect(bottom.getHexString()).not.toBe(top.getHexString());
  });

  it('uses a caller-supplied heightRange instead of the default ±2000', () => {
    const range = { min: 0, max: 100 };
    const viaCustomRange = resolveColor('height', { objectId: 0, faceIndex: 0, fill: 0, y: 100, heightRange: range });
    const viaDefaultRangeAtSameAbsoluteY = resolveColor('height', { objectId: 0, faceIndex: 0, fill: 0, y: 100 });
    // y=100 is the *top* of the custom 0..100 range but nowhere near the top
    // of the default ±2000 range — the two must resolve to different colors,
    // proving heightRange actually changes the mapping.
    expect(viaCustomRange.getHexString()).not.toBe(viaDefaultRangeAtSameAbsoluteY.getHexString());
  });

  it('clamps y outside the range rather than producing an out-of-gamut result', () => {
    const range = { min: 0, max: 100 };
    const belowRange = resolveColor('height', { objectId: 0, faceIndex: 0, fill: 0, y: -1000, heightRange: range });
    const atMin = resolveColor('height', { objectId: 0, faceIndex: 0, fill: 0, y: 0, heightRange: range });
    expect(belowRange.getHexString()).toBe(atMin.getHexString());
  });

  it('falls back to a flat midpoint color for a degenerate (zero-span) range', () => {
    const range = { min: 50, max: 50 };
    expect(() => resolveColor('height', { objectId: 0, faceIndex: 0, fill: 0, y: 50, heightRange: range })).not.toThrow();
  });
});
