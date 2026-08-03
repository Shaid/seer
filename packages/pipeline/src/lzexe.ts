/**
 * LZEXE v0.91 decompressor — a faithful TypeScript port of the classic
 * `unlzexe.c` (originally by Kou, extended by Kirschbaum/Modra/Bontchev/
 * Skjelstad; canonical source: https://github.com/mywave82/unlzexe).
 *
 * LZEXE is a common DOS-era executable compressor — several real-world
 * projects in this framework's family have hit it directly (e.g. Conan the
 * Cimmerian's `CONAN.EXE`, Vengeance of Excalibur's `game.exe`/`vex.exe` —
 * see the sibling `middilgard` project's `docs/tooling/x86-disassembly.md`).
 * Ported here (rather than shelling out to a native `unlzexe` binary) so the
 * pipeline has no external-tool dependency and produces reproducible output
 * on any machine.
 *
 * Only LZEXE **0.91** is implemented — v0.90 uses a different decompression
 * stub and a different compressed-relocation-table encoding, neither
 * implemented here. `decompressLZEXE` throws if the input isn't a v0.91 file
 * (confirmed via the fixed `SIG91` decompression-stub byte signature below).
 *
 * Verified byte-exact against the reference `UNLZEXE Ver. 0.9` C tool on
 * three real LZEXE-compressed DOS executables (Vengeance's `game.exe`/
 * `vex.exe`, Conan's `CONAN.EXE`) in `middilgard`'s own test suite
 * (`tools/__tests__/lzexe.test.ts`) — those are real, copyrighted game
 * executables that can't live in this framework repo, so this package's own
 * tests cover the error paths (malformed input) directly and rely on that
 * external verification for full decompression correctness; see
 * `src/__tests__/lzexe.test.ts` here for specifics.
 */

/** Read a little-endian u16 from `buf` at byte offset `off`. */
function u16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

/** Interpret a u16 value as a signed 16-bit integer (two's complement). */
function toSigned16(v: number): number {
  return v >= 0x8000 ? v - 0x10000 : v;
}

// The LZEXE 0.91 decompression-stub bytes, used to confirm the input is
// really v0.91 (not just "some LZEXE version") before trusting the rest of
// this module's offset arithmetic. Verbatim from unlzexe.c's `sig91`.
const SIG91: number[] = [
  0x06, 0x0e, 0x1f, 0x8b, 0x0e, 0x0c, 0x00, 0x8b, 0xf1, 0x4e, 0x89, 0xf7, 0x8c, 0xdb, 0x03, 0x1e,
  0x0a, 0x00, 0x8e, 0xc3, 0xfd, 0xf3, 0xa4, 0x53, 0xb8, 0x2b, 0x00, 0x50, 0xcb, 0x2e, 0x8b, 0x2e,
  0x08, 0x00, 0x8c, 0xda, 0x89, 0xe8, 0x3d, 0x00, 0x10, 0x76, 0x03, 0xb8, 0x00, 0x10, 0x29, 0xc5,
  0x29, 0xc2, 0x29, 0xc3, 0x8e, 0xda, 0x8e, 0xc3, 0xb1, 0x03, 0xd3, 0xe0, 0x89, 0xc1, 0xd1, 0xe0,
  0x48, 0x48, 0x8b, 0xf0, 0x8b, 0xf8, 0xf3, 0xa5, 0x09, 0xed, 0x75, 0xd8, 0xfc, 0x8e, 0xc2, 0x8e,
  0xdb, 0x31, 0xf6, 0x31, 0xff, 0xba, 0x10, 0x00, 0xad, 0x89, 0xc5, 0xd1, 0xed, 0x4a, 0x75, 0x05,
  0xad, 0x89, 0xc5, 0xb2, 0x10, 0x73, 0x03, 0xa4, 0xeb, 0xf1, 0x31, 0xc9, 0xd1, 0xed, 0x4a, 0x75,
  0x05, 0xad, 0x89, 0xc5, 0xb2, 0x10, 0x72, 0x22, 0xd1, 0xed, 0x4a, 0x75, 0x05, 0xad, 0x89, 0xc5,
  0xb2, 0x10, 0xd1, 0xd1, 0xd1, 0xed, 0x4a, 0x75, 0x05, 0xad, 0x89, 0xc5, 0xb2, 0x10, 0xd1, 0xd1,
  0x41, 0x41, 0xac, 0xb7, 0xff, 0x8a, 0xd8, 0xe9, 0x13, 0x00, 0xad, 0x8b, 0xd8, 0xb1, 0x03, 0xd2,
  0xef, 0x80, 0xcf, 0xe0, 0x80, 0xe4, 0x07, 0x74, 0x0c, 0x88, 0xe1, 0x41, 0x41, 0x26, 0x8a, 0x01,
  0xaa, 0xe2, 0xfa, 0xeb, 0xa6, 0xac, 0x08, 0xc0, 0x74, 0x34, 0x3c, 0x01, 0x74, 0x05, 0x88, 0xc1,
  0x41, 0xeb, 0xea, 0x89, 0xfb, 0x83, 0xe7, 0x0f, 0x81, 0xc7, 0x00, 0x20, 0xb1, 0x04, 0xd3, 0xeb,
  0x8c, 0xc0, 0x01, 0xd8, 0x2d, 0x00, 0x02, 0x8e, 0xc0, 0x89, 0xf3, 0x83, 0xe6, 0x0f, 0xd3, 0xeb,
  0x8c, 0xd8, 0x01, 0xd8, 0x8e, 0xd8, 0xe9, 0x72,
];

class BitStream {
  private readonly data: Uint8Array;
  private buf: number;
  private count: number;
  private pos: number;

  constructor(data: Uint8Array, startOffset: number) {
    this.data = data;
    this.pos = startOffset;
    this.buf = u16(data, this.pos);
    this.pos += 2;
    this.count = 0x10;
  }

  getBit(): number {
    const b = this.buf & 1;
    this.count--;
    if (this.count === 0) {
      this.buf = u16(this.data, this.pos);
      this.pos += 2;
      this.count = 0x10;
    } else {
      this.buf >>= 1;
    }
    return b;
  }

  /** Read one raw byte from the underlying stream (not bit-decoded). */
  getByte(): number {
    const b = this.data[this.pos];
    this.pos += 1;
    return b;
  }
}

/**
 * Decode the LZEXE 0.91 compressed relocation table starting at input file
 * offset `fpos + 0x158` (the fixed offset of the compressed reloc table
 * relative to the decompression stub's own code-segment start, per
 * `unlzexe.c`'s `reloc91`). Returns the flat list of (offset, segment)
 * pairs, each written as two little-endian u16s by the caller.
 */
function decodeReloc91(input: Uint8Array, fpos: number): { offset: number; segment: number }[] {
  let pos = fpos + 0x158;
  let relOff = 0;
  let relSeg = 0;
  const relocs: { offset: number; segment: number }[] = [];

  for (;;) {
    let span = input[pos];
    pos += 1;
    if (span === 0) {
      span = u16(input, pos);
      pos += 2;
      if (span === 0) {
        relSeg += 0x0fff;
        continue;
      } else if (span === 1) {
        break;
      }
      // else: span (the 2-byte value) is used as the delta below.
    }
    relOff += span;
    relSeg += (relOff & ~0x0f) >> 4;
    relOff &= 0x0f;
    relocs.push({ offset: relOff, segment: relSeg });
  }

  return relocs;
}

export interface LZEXEResult {
  /** Full reassembled MZ executable (header + reloc table + decompressed body). */
  data: Uint8Array;
  /** File offset (in `data`) where the decompressed program body starts. */
  bodyOffset: number;
}

/**
 * Decompress an LZEXE v0.91-compressed MS-DOS executable. `input` is the
 * raw, on-disk compressed file. Throws if `input` isn't a v0.91 LZEXE file
 * (not a valid MZ header, or the decompression stub doesn't match the known
 * v0.91 byte signature).
 */
export function decompressLZEXE(input: Uint8Array): LZEXEResult {
  if (input.length < 0x20) {
    throw new Error('decompressLZEXE: file too small to contain an MZ header');
  }

  // ihead: the 16-word (32-byte) MZ header of the COMPRESSED input file.
  const ihead: number[] = [];
  for (let i = 0; i < 0x10; i++) ihead.push(u16(input, i * 2));

  const magic = ihead[0];
  if (magic !== 0x5a4d && magic !== 0x4d5a) {
    throw new Error(`decompressLZEXE: not an MZ file (magic=0x${magic.toString(16)})`);
  }
  if (ihead[0x0d] !== 0) {
    throw new Error('decompressLZEXE: non-zero overlay number, not a plain LZEXE executable');
  }
  if (ihead[0x0c] !== 0x1c) {
    throw new Error('decompressLZEXE: unexpected e_lfarlc (reloc table offset), not LZEXE-shaped');
  }

  // Locate + verify the v0.91 decompression stub at the file's entry point.
  const entry = ((ihead[4] + ihead[0x0b]) << 4) + ihead[0x0a];
  const sigBuf = input.subarray(entry, entry + SIG91.length);
  if (sigBuf.length !== SIG91.length || !SIG91.every((b, i) => sigBuf[i] === b)) {
    throw new Error(
      'decompressLZEXE: decompression stub does not match the known LZEXE v0.91 signature ' +
        '(v0.90 files, or non-LZEXE files with a coincidentally-shaped header, are not supported)',
    );
  }

  // ohead starts as a copy of ihead; several fields get overwritten below
  // with the original (pre-compression) program's real values, recovered
  // from the embedded `inf` block at the start of the stub's code segment.
  const ohead = ihead.slice();

  const codeSegFpos = (ihead[0x0b] + ihead[4]) << 4;
  const inf: number[] = [];
  for (let i = 0; i < 8; i++) inf.push(u16(input, codeSegFpos + i * 2));

  ohead[0x0a] = inf[0]; // IP
  ohead[0x0b] = inf[1]; // CS
  ohead[0x08] = inf[2]; // SP
  ohead[0x07] = inf[3]; // SS
  ohead[0x0c] = 0x1c; // reloc table start offset (unchanged)

  // --- mkreltbl + reloc91: rebuild the real relocation table ---
  const relocs = decodeReloc91(input, codeSegFpos);
  ohead[3] = relocs.length; // NumRelocs

  const relocTableEnd = 0x1c + relocs.length * 4;
  const pad = (0x200 - relocTableEnd) & 0x1ff;
  const headerBytes = relocTableEnd + pad;
  ohead[4] = headerBytes >> 4; // HeaderParagraphs, rounded up to a 512-byte block

  // --- unpack: LZSS-style decompression of the program body ---
  const bodyInStart = (ihead[0x0b] - inf[4] + ihead[4]) << 4;
  const body: number[] = [];
  const bits = new BitStream(input, bodyInStart);

  outer: for (;;) {
    if (bits.getBit()) {
      body.push(bits.getByte());
      continue;
    }
    let len: number;
    let span: number;
    if (!bits.getBit()) {
      len = bits.getBit() << 1;
      len |= bits.getBit();
      len += 2;
      span = bits.getByte() | 0xff00;
    } else {
      const b1 = bits.getByte();
      const b2 = bits.getByte();
      span = b1 | (((b2 & ~0x07) << 5) | 0xe000);
      len = (b2 & 0x07) + 2;
      if (len === 2) {
        len = bits.getByte();
        if (len === 0) break outer; // end of compressed load module
        if (len === 1) continue outer; // segment-change marker, no output
        len += 1;
      }
    }
    const signedSpan = toSigned16(span & 0xffff);
    for (; len > 0; len--) {
      body.push(body[body.length + signedSpan]);
    }
  }

  // --- assemble the final output file ---
  const total = headerBytes + body.length;
  const out = new Uint8Array(total);
  let relPos = 0x1c;
  for (const { offset, segment } of relocs) {
    out[relPos] = offset & 0xff;
    out[relPos + 1] = (offset >> 8) & 0xff;
    out[relPos + 2] = segment & 0xff;
    out[relPos + 3] = (segment >> 8) & 0xff;
    relPos += 4;
  }
  out.set(body, headerBytes);

  // --- wrhead: patch final header fields (BytesInLastBlock/BlocksInFile,
  // and the MinExtra/MaxExtra paragraph adjustment `unlzexe.c` applies) ---
  if (ihead[6] !== 0) {
    ohead[5] -= inf[5] + ((inf[6] + 16 - 1) >> 4) + 9;
    if (ihead[6] !== 0xffff) {
      ohead[6] -= ihead[5] - ohead[5];
    }
  }
  const loadSize = body.length;
  ohead[1] = (loadSize + (ohead[4] << 4)) & 0x1ff;
  ohead[2] = Math.floor((loadSize + (ohead[4] << 4) + 0x1ff) / 0x200);

  for (let i = 0; i < 0x0e; i++) {
    out[i * 2] = ohead[i] & 0xff;
    out[i * 2 + 1] = (ohead[i] >> 8) & 0xff;
  }

  return { data: out, bodyOffset: headerBytes };
}
