import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanChunks, findChunk, chunkPayload, inflateChunk, loadSavestate } from '../uss.js';

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(name: string, flags: number, payload: number[]): number[] {
  const size = 12 + payload.length;
  return [...Array.from(name, (c) => c.charCodeAt(0)), ...u32be(size), ...u32be(flags), ...payload];
}

function pad4(bytes: number[]): number[] {
  const out = [...bytes];
  while (out.length % 4 !== 0) out.push(0);
  return out;
}

/** A minimal, real-shaped .uss buffer: ASF header, one plain chunk, one compressed chunk, END. */
function buildSavestate(): { data: Uint8Array; raw: Uint8Array } {
  const strings = [
    ...Array.from('UAE\0', (c) => c.charCodeAt(0)),
    ...Array.from('1.0\0', (c) => c.charCodeAt(0)),
    ...Array.from('test\0', (c) => c.charCodeAt(0)),
  ];
  const headerLength = 4 + 4 + 8 + strings.length;
  const header = [
    ...Array.from('ASF ', (c) => c.charCodeAt(0)),
    ...u32be(headerLength),
    ...new Array(8).fill(0),
    ...strings,
  ];

  const raw = Uint8Array.from(Array.from({ length: 10 }, (_, i) => i + 1)); // 1..10
  const compressed = Array.from(deflateSync(raw));
  const cramPayload = [...u32be(raw.length), ...compressed];

  // Each chunk is individually padded to a 4-byte boundary — real
  // savestates carry these padding bytes physically; scanChunks' own
  // offset math assumes they're there, not implied.
  const bytes = [
    ...pad4(header),
    ...pad4(chunk('TEST', 0, Array.from('hello!!!', (c) => c.charCodeAt(0)))),
    ...pad4(chunk('CRAM', 1, cramPayload)),
    ...pad4(chunk('END ', 0, [])),
  ];
  return { data: Uint8Array.from(bytes), raw };
}

describe('scanChunks', () => {
  it('walks a well-formed chunk stream, computing the first chunk offset from the declared header length', () => {
    const { data } = buildSavestate();
    const chunks = scanChunks(data);
    expect(chunks.map((c) => c.name)).toEqual(['TEST', 'CRAM', 'END ']);
    expect(chunks[0].payloadLength).toBe(8);
  });

  it('rejects a buffer without the "ASF " magic', () => {
    expect(() => scanChunks(Uint8Array.from([0, 0, 0, 0]))).toThrow(/ASF/);
  });

  it('resyncs past stray bytes between chunks that the declared size does not account for', () => {
    const { data } = buildSavestate();
    // Splice a 4-byte gap in right after the TEST chunk (before CRAM starts)
    // — matching the real-world artefact this scanner exists for (observed:
    // 4 zero bytes between CYCS and CPU on a real savestate). A gap that's
    // itself a multiple of 4 keeps every later chunk's alignment intact, so
    // this exercises exactly the case the resync logic is meant to recover.
    const testChunk = scanChunks(data)[0];
    const spliceAt = testChunk.offset + testChunk.size;
    const withGarbage = Uint8Array.from([
      ...data.subarray(0, spliceAt),
      0xff,
      0xff,
      0xff,
      0xff,
      ...data.subarray(spliceAt),
    ]);
    const chunks = scanChunks(withGarbage);
    expect(chunks.map((c) => c.name)).toEqual(['TEST', 'CRAM', 'END ']);
  });

  it('stops at an "END " chunk without reading past it', () => {
    const { data } = buildSavestate();
    const chunks = scanChunks(data);
    expect(chunks.at(-1)?.name).toBe('END ');
  });
});

describe('findChunk / chunkPayload / inflateChunk', () => {
  it('finds a chunk by name and reads its raw payload', () => {
    const { data } = buildSavestate();
    const chunks = scanChunks(data);
    const test = findChunk(chunks, 'TEST');
    expect(test).toBeDefined();
    expect(new TextDecoder().decode(chunkPayload(data, test!))).toBe('hello!!!');
  });

  it('inflates a flags & 1 chunk back to its original bytes', () => {
    const { data, raw } = buildSavestate();
    const chunks = scanChunks(data);
    const cram = findChunk(chunks, 'CRAM')!;
    expect(inflateChunk(data, cram)).toEqual(raw);
  });

  it('returns the payload unchanged for a chunk with flags & 1 unset', () => {
    const { data } = buildSavestate();
    const chunks = scanChunks(data);
    const test = findChunk(chunks, 'TEST')!;
    expect(inflateChunk(data, test)).toEqual(chunkPayload(data, test));
  });

  it('throws if the inflated length does not match the declared prefix', () => {
    const { data } = buildSavestate();
    const chunks = scanChunks(data);
    const cram = findChunk(chunks, 'CRAM')!;
    const corrupted = Uint8Array.from(data);
    // Corrupt the declared uncompressed-length prefix (first 4 bytes of the payload).
    corrupted[cram.payloadOffset] ^= 0xff;
    expect(() => inflateChunk(corrupted, cram)).toThrow(/length mismatch/);
  });
});

describe('loadSavestate', () => {
  it('reads a real file from disk and scans it', () => {
    const { data } = buildSavestate();
    const dir = mkdtempSync(join(tmpdir(), 'uss-test-'));
    const path = join(dir, 'test.uss');
    writeFileSync(path, data);
    const { chunks } = loadSavestate(path);
    expect(chunks.map((c) => c.name)).toEqual(['TEST', 'CRAM', 'END ']);
  });
});
