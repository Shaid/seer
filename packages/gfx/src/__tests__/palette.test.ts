import { describe, it, expect } from 'vitest';
import { expandVga6 } from '../palette.js';

describe('expandVga6', () => {
  it('expands the 6-bit VGA DAC range endpoints to the full 8-bit range', () => {
    expect(expandVga6(0)).toBe(0);
    expect(expandVga6(63)).toBe(255);
  });

  it('rounds intermediate values to the nearest 8-bit level', () => {
    // 32 * 255/63 = 129.52... -> 130
    expect(expandVga6(32)).toBe(130);
    // 16 * 255/63 = 64.76... -> 65
    expect(expandVga6(16)).toBe(65);
  });
});
