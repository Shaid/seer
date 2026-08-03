import { describe, it, expect } from 'vitest';
import { cyclePalette } from '../palette.ts';

describe('cyclePalette', () => {
  it('rotates forward: last entry in range wraps to start', () => {
    const colors = [0, 1, 2, 3, 4, 5];
    const result = cyclePalette(colors, 1, 4, 1);
    expect(result).toEqual([0, 4, 1, 2, 3, 5]);
  });

  it('rotates in reverse: first entry in range wraps to end', () => {
    const colors = [0, 1, 2, 3, 4, 5];
    const result = cyclePalette(colors, 1, 4, -1);
    expect(result).toEqual([0, 2, 3, 4, 1, 5]);
  });

  it('mutates the array in place and returns the same reference', () => {
    const colors = [0, 1, 2, 3];
    const result = cyclePalette(colors, 0, 3, 1);
    expect(result).toBe(colors);
  });

  it('cycling forward n times equals cycling in reverse n times back to the start', () => {
    const original = [10, 20, 30, 40, 50];
    const colors = [...original];
    for (let i = 0; i < 4; i++) cyclePalette(colors, 0, 4, 1);
    for (let i = 0; i < 4; i++) cyclePalette(colors, 0, 4, -1);
    expect(colors).toEqual(original);
  });

  it('a full rotation (range.length steps) returns to the original order', () => {
    const original = [1, 2, 3, 4, 5, 6];
    const colors = [...original];
    for (let i = 0; i < 5; i++) cyclePalette(colors, 1, 5, 1);
    expect(colors).toEqual(original);
  });

  it('leaves entries outside the range untouched', () => {
    const colors = ['a', 'b', 'c', 'd', 'e'];
    cyclePalette(colors, 1, 3, 1);
    expect(colors[0]).toBe('a');
    expect(colors[4]).toBe('e');
  });

  it('works on arrays of objects (RGB palette entries)', () => {
    const colors = [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ];
    cyclePalette(colors, 1, 3, 1);
    expect(colors).toEqual([
      { r: 0, g: 0, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
    ]);
  });

  it('is a no-op when start >= end', () => {
    const colors = [1, 2, 3];
    const result = cyclePalette(colors, 2, 1, 1);
    expect(result).toEqual([1, 2, 3]);
  });

  it('is a no-op when start is negative', () => {
    const colors = [1, 2, 3];
    cyclePalette(colors, -1, 2, 1);
    expect(colors).toEqual([1, 2, 3]);
  });

  it('is a no-op when end is out of bounds', () => {
    const colors = [1, 2, 3];
    cyclePalette(colors, 0, 3, 1);
    expect(colors).toEqual([1, 2, 3]);
  });

  it('defaults to forward direction when direction is omitted', () => {
    const colors = [0, 1, 2, 3];
    cyclePalette(colors, 0, 3);
    expect(colors).toEqual([3, 0, 1, 2]);
  });
});
