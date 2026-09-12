import { describe, it, expect } from 'vitest';
import { detectAncientContainer, decompressRnc1, decompressRnc2, decrunchRenamedPp20 } from '../ancient.js';

describe('detectAncientContainer', () => {
  it('recognizes RNC1, RNC2, IMP! and PP20 magics', () => {
    expect(detectAncientContainer(new Uint8Array([0x52, 0x4e, 0x43, 0x01, 0, 0]))).toBe('rnc1');
    expect(detectAncientContainer(new Uint8Array([0x52, 0x4e, 0x43, 0x02, 0, 0]))).toBe('rnc2');
    expect(detectAncientContainer(new Uint8Array([0x49, 0x4d, 0x50, 0x21]))).toBe('imp');
    expect(detectAncientContainer(new Uint8Array([0x50, 0x50, 0x32, 0x30]))).toBe('pp20');
  });

  it('returns "none" for unrecognized or short headers', () => {
    expect(detectAncientContainer(new Uint8Array([0x46, 0x4f, 0x52, 0x4d]))).toBe('none'); // "FORM"
    expect(detectAncientContainer(new Uint8Array([0x52, 0x4e]))).toBe('none');
  });
});

describe('decompressRnc1 / decompressRnc2', () => {
  it('throws a clear error on non-matching magic rather than shelling out', () => {
    expect(() => decompressRnc1(new Uint8Array([1, 2, 3, 4]))).toThrow(/expected magic/);
    expect(() => decompressRnc2(new Uint8Array([1, 2, 3, 4]))).toThrow(/expected magic/);
  });
});

describe('decrunchRenamedPp20', () => {
  const LR88_MAGIC = [0x4c, 0x52, 0x38, 0x38]; // "LR88"

  it('throws a clear error on non-matching renamed magic rather than shelling out', () => {
    expect(() => decrunchRenamedPp20(new Uint8Array([1, 2, 3, 4]), LR88_MAGIC)).toThrow(/expected renamed magic/);
  });
});
