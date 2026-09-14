/**
 * GPU texture codecs used by modern console decompilation:
 *
 * - **`swizzle.ts`** — Tegra X1 (Nintendo Switch) block-linear (de)swizzle.
 * - **`bc.ts`** — BC1-7/S3TC block compression codecs, including a full
 *   spec-conformant BC7 decoder and BC1/BC3 encoders.
 * - **`astc.ts`** — ASTC decode via `@tootallnate/astc-wasm`.
 * - **`zstd.ts`** — Zstandard decompression via `@tootallnate/zstd-wasm`.
 *
 * `astc.ts`/`zstd.ts` import their Node builtins lazily inside an internal
 * `load()`, so this whole barrel is safe to import from a bundled browser
 * viewer — see either file's doc comment for why. Actually decoding still
 * needs a Node runtime (they read the WASM file off disk via `node:fs`).
 */
export * from './swizzle.js';
export * from './bc.js';
export * from './astc.js';
export * from './zstd.js';
