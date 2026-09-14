/**
 * ZSTD (Zstandard) one-shot decompressor.
 *
 * Wraps `@tootallnate/zstd-wasm` (MIT), a WebAssembly build of upstream
 * zstd 1.5.7 with a streaming decoder — it doesn't need the compressed
 * frame to carry an embedded content size (unlike a single-shot
 * `ZSTD_decompress` call sized off `ZSTD_findDecompressedSize`), so a
 * caller no longer needs to pass an expected output size at all.
 *
 * `node:fs`/`node:url` are imported lazily inside `load()`, same rationale
 * as `astc.ts`'s doc comment (avoids a Vite dev-server crash on a bare
 * top-level Node-builtin import; this code path only ever runs when
 * `zstdDecode()` is actually invoked from Node).
 */
import { ZstdDecoder } from '@tootallnate/zstd-wasm';

let decoderPromise: Promise<ZstdDecoder> | null = null;

async function load(): Promise<ZstdDecoder> {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  // See `astc.ts`'s `load()` doc comment: `createRequire(...).resolve()` rather than
  // `import.meta.resolve()`, which Vite's SSR module transform rewrites to a non-functional
  // stub.
  const wasmPath = createRequire(import.meta.url).resolve('@tootallnate/zstd-wasm/zstd.wasm');
  const wasm = readFileSync(wasmPath);
  return ZstdDecoder.create(wasm);
}

function getDecoder(): Promise<ZstdDecoder> {
  decoderPromise ??= load();
  return decoderPromise;
}

export async function zstdDecode(compressed: Uint8Array): Promise<Uint8Array> {
  const decoder = await getDecoder();
  return decoder.decode(compressed);
}
