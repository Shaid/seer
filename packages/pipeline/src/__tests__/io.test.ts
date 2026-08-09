import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readBinary,
  writePNG,
  writeJson,
  writeIndexedPNG,
  writeWav,
  resolveDataFile,
  scanFilesByExtension,
} from '../io.js';

/** Read a 4-byte little-endian u32 out of a raw file buffer. */
function u32le(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

/** Read a PNG's raw RGBA pixel buffer back out (pngjs round-trip). */
async function readPngRgba(path: string): Promise<{ width: number; height: number; data: Buffer }> {
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: png.data };
}

const TMP = join(import.meta.dirname, '__tmp__');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('readBinary', () => {
  it('reads a file and returns a Uint8Array with its own ArrayBuffer', () => {
    const path = join(TMP, 'test.bin');
    const original = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0xff]);
    writeFileSync(path, Buffer.from(original));

    const result = readBinary(path);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(5);
    expect(Array.from(result)).toEqual([0x00, 0x11, 0x22, 0x33, 0xff]);
    // Must own its own buffer (not a Node.js pool view)
    expect(result.buffer.byteLength).toBe(5);
  });
});

describe('writePNG', () => {
  it('writes a valid PNG file that can be read back', () => {
    const path = join(TMP, 'test.png');
    const rgba = new Uint8Array(16); // 2x2 pixels, RGBA
    rgba[0] = 255; // pixel 0: red
    rgba[3] = 255;
    rgba[5] = 255; // pixel 1: green
    rgba[7] = 255;
    rgba[10] = 255; // pixel 2: blue
    rgba[11] = 255;
    // pixel 3: transparent (all zero)

    writePNG(path, rgba, 2, 2);

    const fileBuf = readFileSync(path);
    // PNG header magic
    expect(fileBuf[0]).toBe(0x89);
    expect(fileBuf[1]).toBe(0x50); // P
    expect(fileBuf[2]).toBe(0x4e); // N
    expect(fileBuf[3]).toBe(0x47); // G
    expect(fileBuf.byteLength).toBeGreaterThan(50);
  });
});

describe('writeJson', () => {
  it('writes pretty-printed JSON by default', () => {
    const path = join(TMP, 'test.json');
    writeJson(path, { a: 1, b: [2, 3] });

    const text = readFileSync(path, 'utf-8');
    expect(text).toContain('"a": 1');
    expect(text).toContain('"b": [');
    expect(text).toContain('\n');
    expect(JSON.parse(text)).toEqual({ a: 1, b: [2, 3] });
  });

  it('writes minified JSON when pretty=false', () => {
    const path = join(TMP, 'test-min.json');
    writeJson(path, { a: 1 }, false);

    const text = readFileSync(path, 'utf-8');
    expect(text).not.toContain('\n');
  });
});

describe('resolveDataFile', () => {
  it('returns the first existing file from candidates', () => {
    writeFileSync(join(TMP, 'DATA.BIN'), '');
    const result = resolveDataFile(TMP, ['data.bin', 'DATA.BIN']);
    expect(result).toBe('DATA.BIN');
  });

  it('returns the first candidate if none exist', () => {
    const result = resolveDataFile(TMP, ['nope.bin', 'also-nope.bin']);
    expect(result).toBe('nope.bin');
  });
});

describe('scanFilesByExtension', () => {
  it('finds files matching an extension case-insensitively, sorted', () => {
    writeFileSync(join(TMP, 'B.DAT'), '');
    writeFileSync(join(TMP, 'a.dat'), '');
    writeFileSync(join(TMP, 'ignore.txt'), '');

    const result = scanFilesByExtension(TMP, 'dat');
    expect(result).toEqual(['B.DAT', 'a.dat']);
  });
});

describe('writeIndexedPNG', () => {
  it('defaults index 0 to transparent, everything else opaque', async () => {
    const path = join(TMP, 'indexed.png');
    // 2x1: index 0 (should key out), index 5 (should stay opaque)
    writeIndexedPNG(path, new Uint8Array([0, 5]), 2, 1);

    const { data } = await readPngRgba(path);
    expect(data[3]).toBe(0); // pixel 0 alpha
    expect(data[0]).toBe(0); // pixel 0 red (index value)
    expect(data[7]).toBe(255); // pixel 1 alpha
    expect(data[4]).toBe(5); // pixel 1 red (index value)
  });

  it('treats index 0 as opaque when transparentIndex is null', async () => {
    const path = join(TMP, 'indexed-opaque.png');
    writeIndexedPNG(path, new Uint8Array([0, 5]), 2, 1, { transparentIndex: null });

    const { data } = await readPngRgba(path);
    expect(data[3]).toBe(255); // pixel 0 alpha — no longer keyed out
    expect(data[7]).toBe(255); // pixel 1 alpha
  });

  it('keys out a caller-chosen index instead of 0', async () => {
    const path = join(TMP, 'indexed-custom-key.png');
    writeIndexedPNG(path, new Uint8Array([0, 5]), 2, 1, { transparentIndex: 5 });

    const { data } = await readPngRgba(path);
    expect(data[3]).toBe(255); // index 0 now opaque
    expect(data[7]).toBe(0); // index 5 is the keyed-out one
  });
});

describe('writeWav', () => {
  it('writes mono 8-bit unsigned PCM byte-for-byte with no scaling', () => {
    const path = join(TMP, 'mono8.wav');
    writeWav(path, [new Uint8Array([0, 128, 255])], { sampleRate: 8000, bits: 8 });

    const buf = readFileSync(path);
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.readUInt16LE(22)).toBe(1); // numChannels
    expect(u32le(buf, 24)).toBe(8000); // sampleRate
    expect(buf.readUInt16LE(34)).toBe(8); // bitsPerSample
    expect(u32le(buf, 40)).toBe(3); // dataSize (3 samples x 1 byte)
    expect(Array.from(buf.subarray(44, 47))).toEqual([0, 128, 255]);
  });

  it('writes stereo 16-bit signed PCM, quantized and clamped from [-1, 1]', () => {
    const path = join(TMP, 'stereo16.wav');
    const left = new Float32Array([0, 1, -1, 2 /* out-of-range, clamps to 1 */]);
    const right = new Float32Array([0, -1, 1, -2 /* clamps to -1 */]);
    writeWav(path, [left, right], { sampleRate: 44100 });

    const buf = readFileSync(path);
    expect(buf.readUInt16LE(22)).toBe(2); // numChannels
    expect(buf.readUInt16LE(34)).toBe(16); // bitsPerSample (default)
    expect(u32le(buf, 40)).toBe(4 * 2 * 2); // 4 samples x 2 channels x 2 bytes

    const dataOff = 44;
    expect(buf.readInt16LE(dataOff + 0)).toBe(0); // L[0]
    expect(buf.readInt16LE(dataOff + 2)).toBe(0); // R[0]
    expect(buf.readInt16LE(dataOff + 4)).toBe(32767); // L[1]
    expect(buf.readInt16LE(dataOff + 6)).toBe(-32767); // R[1]
    expect(buf.readInt16LE(dataOff + 12)).toBe(32767); // L[3] clamped from 2
    expect(buf.readInt16LE(dataOff + 14)).toBe(-32767); // R[3] clamped from -2
  });
});
