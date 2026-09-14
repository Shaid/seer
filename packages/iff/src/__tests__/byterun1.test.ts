import { describe, it, expect } from 'vitest';
import { decodeByteRun1 } from '../byterun1.js';

describe('decodeByteRun1', () => {
  it('copies a literal run (n >= 0)', () => {
    // n=2 -> copy next 3 bytes literally
    const input = new Uint8Array([2, 0x11, 0x22, 0x33]);
    expect([...decodeByteRun1(input, 3)]).toEqual([0x11, 0x22, 0x33]);
  });

  it('repeats a byte run (n < 0)', () => {
    // n=-3 (0xFD) -> repeat next byte (1 - (-3)) = 4 times
    const input = new Uint8Array([0xfd, 0xaa]);
    expect([...decodeByteRun1(input, 4)]).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it('treats -128 as a no-op control byte', () => {
    const input = new Uint8Array([0x80, 1, 0x01, 0x02]);
    expect([...decodeByteRun1(input, 2)]).toEqual([0x01, 0x02]);
  });

  it('mixes literal and run codes across a longer stream', () => {
    // literal run of 2, then repeat run of 3
    const input = new Uint8Array([1, 0x10, 0x20, 0xfe, 0x99]);
    expect([...decodeByteRun1(input, 5)]).toEqual([0x10, 0x20, 0x99, 0x99, 0x99]);
  });

  it('stops at expectedLength even with trailing input', () => {
    const input = new Uint8Array([3, 1, 2, 3, 4, 5, 9, 9, 9, 9]);
    expect([...decodeByteRun1(input, 3)]).toEqual([1, 2, 3]);
  });

  it('degrades to zero-fill on truncated input rather than throwing', () => {
    const input = new Uint8Array([5]); // claims 6 literal bytes, provides none
    expect(() => decodeByteRun1(input, 6)).not.toThrow();
    expect([...decodeByteRun1(input, 6)]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
