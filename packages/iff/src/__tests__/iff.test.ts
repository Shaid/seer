import { describe, it, expect } from 'vitest';
import { parseIff, findChunk, findChunks } from '../iff.ts';

/** Helper: build a minimal IFF FORM buffer. */
function buildIff(type: string, chunks: Array<{ id: string; data: number[] }>): ArrayBuffer {
  const chunkBuffers: number[] = [];
  for (const chunk of chunks) {
    // chunk ID (4 bytes)
    chunkBuffers.push(...[...chunk.id].map((c) => c.charCodeAt(0)));
    // chunk size (uint32 big-endian)
    const size = chunk.data.length;
    chunkBuffers.push((size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff);
    // chunk data
    chunkBuffers.push(...chunk.data);
    // pad byte if odd size
    if (size % 2 !== 0) chunkBuffers.push(0);
  }

  const formSize = 4 + chunkBuffers.length; // type + chunks
  const header = [
    ...[...'FORM'].map((c) => c.charCodeAt(0)),
    (formSize >> 24) & 0xff,
    (formSize >> 16) & 0xff,
    (formSize >> 8) & 0xff,
    formSize & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
  ];

  return new Uint8Array([...header, ...chunkBuffers]).buffer;
}

describe('IFF parser', () => {
  it('parses a simple IFF FORM', () => {
    const buffer = buildIff('TEST', [{ id: 'DATA', data: [0x01, 0x02, 0x03] }]);
    const form = parseIff(buffer);
    expect(form).not.toBeNull();
    expect(form!.type).toBe('TEST');
    expect(form!.chunks).toHaveLength(1);
    expect(form!.chunks[0].id).toBe('DATA');
    expect([...form!.chunks[0].data]).toEqual([0x01, 0x02, 0x03]);
  });

  it('parses multiple chunks', () => {
    const buffer = buildIff('ILBM', [
      { id: 'BMHD', data: [0x00, 0x01] },
      { id: 'CMAP', data: [0xff, 0x00, 0x00] },
      { id: 'BODY', data: [0x10, 0x20, 0x30, 0x40] },
    ]);
    const form = parseIff(buffer);
    expect(form).not.toBeNull();
    expect(form!.type).toBe('ILBM');
    expect(form!.chunks).toHaveLength(3);
  });

  it('findChunk returns the correct chunk', () => {
    const buffer = buildIff('TEST', [
      { id: 'AAAA', data: [0x01] },
      { id: 'BBBB', data: [0x02] },
    ]);
    const form = parseIff(buffer)!;
    const chunk = findChunk(form, 'BBBB');
    expect(chunk).toBeDefined();
    expect(chunk!.data[0]).toBe(0x02);
  });

  it('findChunks returns all matching chunks', () => {
    const buffer = buildIff('TEST', [
      { id: 'DATA', data: [0x01] },
      { id: 'DATA', data: [0x02] },
      { id: 'INFO', data: [0x03] },
    ]);
    const form = parseIff(buffer)!;
    const dataChunks = findChunks(form, 'DATA');
    expect(dataChunks).toHaveLength(2);
  });

  it('returns null for non-IFF data', () => {
    const buffer = new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer;
    expect(parseIff(buffer)).toBeNull();
  });

  it('returns null for too-small buffer', () => {
    const buffer = new Uint8Array([0x46, 0x4f]).buffer;
    expect(parseIff(buffer)).toBeNull();
  });
});
