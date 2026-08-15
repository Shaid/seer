import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLhaFile, listLha, readLhaEntry } from '../lha.js';

/**
 * A hand-built level-1 `-lh0-` (stored) archive. This exercises header
 * walking, extended-header traversal and member extraction without
 * needing a packer installed. The Huffman path is covered by the
 * corpus test below, since the common `lha` binary (Lhasa) can extract
 * but not create.
 */
function buildStoredArchive(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    const nameBytes = [...f.name].map((c) => c.charCodeAt(0));
    const headerSize = 25 + nameBytes.length;
    const h = new Uint8Array(headerSize + 2);
    h[0] = headerSize;
    h.set([0x2d, 0x6c, 0x68, 0x30, 0x2d], 2); // '-lh0-'
    const w32 = (off: number, v: number) => {
      h[off] = v & 0xff;
      h[off + 1] = (v >>> 8) & 0xff;
      h[off + 2] = (v >>> 16) & 0xff;
      h[off + 3] = (v >>> 24) & 0xff;
    };
    w32(7, f.data.length); // skip size (stored: same as payload)
    w32(11, f.data.length); // original size
    w32(15, 0); // timestamp
    h[19] = 0x20;
    h[20] = 1; // header level
    h[21] = nameBytes.length;
    h.set(nameBytes, 22);
    h[22 + nameBytes.length] = 0; // crc16 lo
    h[23 + nameBytes.length] = 0; // crc16 hi
    h[24 + nameBytes.length] = 0x41; // OS id 'A'
    h[headerSize] = 0; // extended-header terminator (2 bytes of zero)
    h[headerSize + 1] = 0;
    let sum = 0;
    for (let i = 2; i < headerSize; i++) sum = (sum + h[i]) & 0xff;
    h[1] = sum;
    parts.push(h, f.data);
  }
  parts.push(new Uint8Array(1)); // archive terminator
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('lha stored archives', () => {
  const files = [
    { name: 'ReadMe', data: new TextEncoder().encode('hello amiga\n') },
    { name: 'data/level.bin', data: new Uint8Array(300).map((_, i) => (i * 7) & 0xff) },
  ];
  const archive = buildStoredArchive(files);

  it('detects the archive signature', () => {
    expect(isLhaFile(archive)).toBe(true);
  });

  it('lists every member with its name and size', () => {
    const entries = listLha(archive);
    expect(entries.map((e) => [e.name, e.originalSize])).toEqual([
      ['ReadMe', 12],
      ['data/level.bin', 300],
    ]);
    expect(entries.every((e) => e.method === 'lh0')).toBe(true);
  });

  it('extracts member bytes exactly', () => {
    const entries = listLha(archive);
    expect(readLhaEntry(archive, entries[0])).toEqual(files[0].data);
    expect(readLhaEntry(archive, entries[1])).toEqual(files[1].data);
  });
});

describe('lha structural handling', () => {
  it('rejects non-archives', () => {
    expect(isLhaFile(new Uint8Array(64))).toBe(false);
    expect(isLhaFile(new Uint8Array(8))).toBe(false);
  });

  it('returns no members for garbage rather than throwing', () => {
    expect(() => listLha(new Uint8Array(512).fill(0x41))).not.toThrow();
  });

  it('stops cleanly at a truncated header instead of looping', () => {
    const truncated = Uint8Array.from([0x28, 0x0e, 0x2d, 0x6c, 0x68, 0x35, 0x2d, ...new Array(20).fill(0)]);
    expect(() => listLha(truncated)).not.toThrow();
  });

  it('reports unsupported methods rather than mis-decoding them', () => {
    const archive = buildStoredArchive([{ name: 'x', data: new Uint8Array(4) }]);
    archive.set([0x2d, 0x6c, 0x68, 0x31, 0x2d], 2); // '-lh1-'
    const [entry] = listLha(archive);
    expect(entry.method).toBe('lh1');
    expect(() => readLhaEntry(archive, entry)).toThrow(/unsupported method/);
  });
});

/**
 * Real-corpus check: decode an actual WHDLoad archive and compare every
 * member against the system extractor. This is what validates the
 * Huffman (`-lh5-`) path; it skips where the corpus or `lha` is absent.
 */
const CORPUS = '/data/TOSEC Amiga/WHDLoad';
const canValidate = existsSync(CORPUS) && existsSync('/usr/bin/lha') && existsSync('/usr/bin/unzip');

describe.skipIf(!canValidate)('lha against the system extractor on real archives', () => {
  it('decodes -lh5- members byte-for-byte', () => {
    const zips = readdirSync(CORPUS).filter((f) => f.endsWith('.zip')).sort().slice(0, 2);
    const dir = mkdtempSync(join(tmpdir(), 'lha-corpus-'));
    try {
      let compared = 0;
      for (const zip of zips) {
        const work = join(dir, zip.replace(/\W/g, '_'));
        execFileSync('unzip', ['-o', '-q', join(CORPUS, zip), '-d', work], { stdio: 'ignore' });
        const lhaName = readdirSync(work).find((f) => f.toLowerCase().endsWith('.lha'));
        if (!lhaName) continue;
        const lhaPath = join(work, lhaName);
        const ref = join(work, 'ref');
        execFileSync('mkdir', ['-p', ref]);
        execFileSync('lha', ['xq', lhaPath], { cwd: ref, stdio: 'ignore' });

        const archive = new Uint8Array(readFileSync(lhaPath));
        for (const entry of listLha(archive)) {
          if (entry.isDirectory) continue;
          const refFile = join(ref, entry.name);
          if (!existsSync(refFile) || statSync(refFile).isDirectory()) continue;
          expect(readLhaEntry(archive, entry), `${lhaName}:${entry.name}`).toEqual(
            new Uint8Array(readFileSync(refFile)),
          );
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Shells out to unzip and lha for real archives; the default 5s is tight.
  }, 60_000);
});
