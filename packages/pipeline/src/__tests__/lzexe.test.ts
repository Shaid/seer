import { describe, it, expect } from 'vitest';
import { decompressLZEXE } from '../lzexe.js';

/**
 * Error-path coverage only. Full decompression correctness (the LZSS body
 * unpacking, the compressed-relocation-table decode, the header
 * reconstruction) is verified byte-exact against the reference `UNLZEXE
 * Ver. 0.9` C tool on three real LZEXE-compressed DOS executables in the
 * sibling `middilgard` project's `tools/__tests__/lzexe.test.ts` — those are
 * real, copyrighted game executables (Vengeance's `game.exe`/`vex.exe`,
 * Conan's `CONAN.EXE`) that can't be vendored into this framework repo as
 * test fixtures, and hand-constructing a synthetic-but-valid LZEXE v0.91
 * file (correctly interleaving its bit-packed control stream with raw
 * literal/length bytes at shared, moving file offsets) is disproportionate
 * effort for re-verifying an already-proven port with no compressor
 * available to generate one. See lzexe.ts's docblock for the full
 * provenance note.
 */
describe('decompressLZEXE', () => {
  it('throws on non-MZ input rather than producing garbage', () => {
    const notMz = new Uint8Array(64);
    notMz[0] = 0x00;
    notMz[1] = 0x00;
    expect(() => decompressLZEXE(notMz)).toThrow(/not an MZ file/);
  });

  it('throws on a buffer too small to hold an MZ header', () => {
    expect(() => decompressLZEXE(new Uint8Array(4))).toThrow(/too small/);
  });

  it('throws on a well-formed MZ header with a non-zero overlay number', () => {
    const buf = new Uint8Array(64);
    buf[0] = 0x4d; // 'M'
    buf[1] = 0x5a; // 'Z'
    buf[0x1c] = 0x1c; // e_lfarlc, correct LZEXE-shaped value
    buf[0x1a] = 1; // overlay number != 0
    expect(() => decompressLZEXE(buf)).toThrow(/overlay/);
  });

  it('throws on a well-formed MZ header with the wrong e_lfarlc', () => {
    const buf = new Uint8Array(64);
    buf[0] = 0x4d;
    buf[1] = 0x5a;
    buf[0x18] = 0x99; // e_lfarlc != 0x1c
    expect(() => decompressLZEXE(buf)).toThrow(/e_lfarlc/);
  });

  it('throws on an MZ file whose entry point does not match the v0.91 stub signature', () => {
    const buf = new Uint8Array(256);
    buf[0] = 0x4d;
    buf[1] = 0x5a;
    buf[0x18] = 0x1c; // e_lfarlc == 0x1c
    // ihead[0x0a]/[0x0b]/[4] all default to 0, so entry == 0 and the stub
    // signature check reads real (zeroed) bytes that don't match SIG91.
    expect(() => decompressLZEXE(buf)).toThrow(/does not match the known LZEXE v0\.91 signature/);
  });
});
