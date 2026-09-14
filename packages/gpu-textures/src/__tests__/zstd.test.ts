import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compressBytes } from '@tootallnate/zstd-wasm';
import { zstdDecode } from '../zstd.js';

async function loadZstdWasm(): Promise<Uint8Array> {
  const wasmPath = createRequire(import.meta.url).resolve('@tootallnate/zstd-wasm/zstd.wasm');
  return readFileSync(wasmPath);
}

describe('zstdDecode', () => {
  it('decompresses a real zstd frame produced by the same underlying library', async () => {
    const wasm = await loadZstdWasm();
    const plain = new TextEncoder().encode('the quick brown fox jumps over the lazy dog, '.repeat(50));
    const compressed = await compressBytes(wasm, plain);
    expect(compressed.length).toBeLessThan(plain.length); // sanity: it actually compressed
    const decompressed = await zstdDecode(compressed);
    expect(Array.from(decompressed)).toEqual(Array.from(plain));
  });

  it('decodes multiple different buffers correctly across a shared cached decoder instance', async () => {
    const wasm = await loadZstdWasm();
    const a = new TextEncoder().encode('first payload'.repeat(20));
    const b = new TextEncoder().encode('a completely different second payload'.repeat(30));
    const [ca, cb] = await Promise.all([compressBytes(wasm, a), compressBytes(wasm, b)]);
    // Sequential (not concurrent) decodes, since the wrapper caches one shared decoder instance.
    const da = await zstdDecode(ca);
    const db = await zstdDecode(cb);
    expect(Array.from(da)).toEqual(Array.from(a));
    expect(Array.from(db)).toEqual(Array.from(b));
  });

  it('round-trips an empty buffer', async () => {
    const wasm = await loadZstdWasm();
    const compressed = await compressBytes(wasm, new Uint8Array(0));
    const decompressed = await zstdDecode(compressed);
    expect(decompressed.length).toBe(0);
  });

  it('round-trips binary (non-UTF8-safe) data', async () => {
    const wasm = await loadZstdWasm();
    const plain = new Uint8Array(4096);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 137 + 7) & 0xff;
    const compressed = await compressBytes(wasm, plain);
    const decompressed = await zstdDecode(compressed);
    expect(Array.from(decompressed)).toEqual(Array.from(plain));
  });
});
