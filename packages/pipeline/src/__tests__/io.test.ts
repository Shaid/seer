import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBinary, writePNG, writeJson, resolveDataFile, scanFilesByExtension } from '../io.ts';

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
