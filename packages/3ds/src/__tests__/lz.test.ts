import { existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decompressLz10, decompressLz11, decompressLz13 } from '../lz.js';

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

describe('LZ11', () => {
  it('decodes literals plus a back-reference block', () => {
    // "AB" + 8x "AB" via disp=2, len=8 (normal LZ11 block: nibble 7 = len 8)
    const stream = bytes(0x11, 0x0a, 0x00, 0x00, 0x20, 0x41, 0x42, 0x70, 0x01);
    expect(Buffer.from(decompressLz11(stream)).toString()).toBe('ABABABABAB');
  });

  it('decodes the long-repetition form (length > 0x10)', () => {
    // 0x12 'X' literals, then a case-0 block repeating the whole run 0x22 times.
    const literals = new Uint8Array(0x12).fill(0x58); // 'X'
    const len = 0x11 + 0x11; // 34
    const disp = 0x12; // repeat from out[0] (first literal)
    // case-0 compressed block (length nibble 0): b1/b2/b3 encode len & disp.
    const b1 = ((len - 0x11) >> 4) & 0x0f;
    const b2 = (((len - 0x11) & 0x0f) << 4) | (((disp - 1) >> 8) & 0x0f);
    const b3 = (disp - 1) & 0xff;

    const total = 0x12 + len;
    const head = bytes(0x11, total & 0xff, (total >> 8) & 0xff, (total >> 16) & 0xff);
    // Flags bytes are interleaved with the literal bytes they describe:
    // [flags1][8 lits][flags2][8 lits][flags3][2 lits][comp]. Output completes
    // during the compressed block, so the trailing flag bits are never used.
    const out = decompressLz11(
      concat(
        head,
        bytes(0x00),
        literals.subarray(0, 8),
        bytes(0x00),
        literals.subarray(8, 16),
        bytes(0x20),
        literals.subarray(16, 18),
        bytes(b1, b2, b3),
      ),
    );
    expect(out.length).toBe(total);
    for (let i = 0; i < total; i++) expect(out[i]).toBe(0x58);
  });
});

describe('LZ10', () => {
  it('decodes a short-repeat block', () => {
    // "AB" + 8x "AB": b1 = 0x50 | (disp-1)>>8, b2 = disp-1
    const stream = bytes(0x10, 0x0a, 0x00, 0x00, 0x20, 0x41, 0x42, 0x50, 0x01);
    expect(Buffer.from(decompressLz10(stream)).toString()).toBe('ABABABABAB');
  });
});

describe('LZ13 (FE3DS wrapper)', () => {
  it('strips the 4-byte wrapper and decompresses the LZ11 stream', () => {
    const lz11 = bytes(0x11, 0x0a, 0x00, 0x00, 0x20, 0x41, 0x42, 0x70, 0x01);
    const wrapped = concat(bytes(0x13, 0x0a, 0x00, 0x00), lz11);
    expect(Buffer.from(decompressLz13(wrapped)).toString()).toBe('ABABABABAB');
  });

  it('handles an LZ13 wrapper around an LZ10 stream', () => {
    const lz10 = bytes(0x10, 0x0a, 0x00, 0x00, 0x20, 0x41, 0x42, 0x50, 0x01);
    const wrapped = concat(bytes(0x13, 0x0a, 0x00, 0x00), lz10);
    expect(Buffer.from(decompressLz13(wrapped)).toString()).toBe('ABABABABAB');
  });

  it('decompresses a bare LZ11 stream with no wrapper', () => {
    const lz11 = bytes(0x11, 0x0a, 0x00, 0x00, 0x20, 0x41, 0x42, 0x70, 0x01);
    expect(Buffer.from(decompressLz13(lz11)).toString()).toBe('ABABABABAB');
  });

  it('throws rather than returning still-compressed bytes for an unknown wrapper', () => {
    const wrapped = bytes(0x13, 0x0a, 0x00, 0x00, 0x42, 0x43, 0x48, 0x00);
    expect(() => decompressLz13(wrapped)).toThrow(/unknown inner stream type/);
  });

  it('passes through non-LZ13 input untouched', () => {
    const plain = bytes(0x43, 0x54, 0x50, 0x4b, 0x00);
    expect(decompressLz13(plain)).toEqual(plain);
  });
});

describe('LZ guards', () => {
  it('rejects an LZ10 back-reference before the start of output', () => {
    // A compressed block as the very first block has nothing to point back to.
    const stream = bytes(0x10, 0x04, 0x00, 0x00, 0x80, 0x00, 0x00);
    expect(() => decompressLz10(stream)).toThrow(/before start of output/);
  });

  it('rejects an LZ11 back-reference before the start of output', () => {
    const stream = bytes(0x11, 0x04, 0x00, 0x00, 0x80, 0x20, 0x00);
    expect(() => decompressLz11(stream)).toThrow(/before start of output/);
  });
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('LZ13 outer size and stored wrapper', () => {
  // Inner LZ11 stream: 'AB' literals + back-ref -> 'ABABABABAB' (10 bytes).
  const inner = new Uint8Array([0x11, 0x0a, 0x00, 0x00, 0x20, 0x41, 0x42, 0x70, 0x01]);
  const wrap = (outer: number) =>
    new Uint8Array([0x13, outer & 0xff, (outer >> 8) & 0xff, (outer >> 16) & 0xff, ...inner]);

  it('output length is the inner LZ11 size even when the outer u24 differs', () => {
    for (const outer of [10, 0x40, 0x1234]) {
      const out = decompressLz13(wrap(outer));
      expect(out.length).toBe(10);
      expect(Buffer.from(out).toString()).toBe('ABABABABAB');
    }
  });

  it('null control: sizing by the outer u24 would give the wrong length', () => {
    expect(wrap(0x40)[1] | (wrap(0x40)[2] << 8)).not.toBe(decompressLz13(wrap(0x40)).length);
  });

  it('unwraps the stored wrapper (00 + u24 == length-4)', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const file = new Uint8Array([0x00, 6, 0, 0, ...payload]);
    expect(Array.from(decompressLz13(file))).toEqual(Array.from(payload));
  });

  it('null control: a leading 0x00 with a non-matching size passes through untouched', () => {
    const file = new Uint8Array([0x00, 9, 0, 0, 1, 2, 3, 4, 5, 6]);
    expect(decompressLz13(file)).toBe(file);
  });
});

describe('real FE data (skipped when absent)', () => {
  const root = '/home/ctemplet/Development/lucina/data/extracted/fe-fates/romfs-index.json';
  const have = existsSync(root);
  it.skipIf(!have)('Fates: stored files unwrap, LZ13 length == inner size', () => {
    const idx = JSON.parse(readFileSync(root, 'utf8')) as {
      container: { file: string };
      files: { path: string; offset: number; size: number }[];
    };
    if (!existsSync(idx.container.file)) return;
    const fd = openSync(idx.container.file, 'r');
    let stored = 0;
    let l13 = 0;
    for (const f of idx.files) {
      if (!f.path.endsWith('.lz')) continue;
      const b = Buffer.alloc(f.size);
      readSync(fd, b, 0, f.size, f.offset);
      const out = decompressLz13(new Uint8Array(b));
      if (b[0] === 0x00) {
        stored++;
        expect(out.length).toBe(f.size - 4);
      } else if (b[0] === 0x13) {
        l13++;
        expect(out.length).toBe(b[5] | (b[6] << 8) | (b[7] << 16));
      }
    }
    expect(stored).toBe(31);
    expect(l13).toBe(13455);
  }, 60_000);
});
