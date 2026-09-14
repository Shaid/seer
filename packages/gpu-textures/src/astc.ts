/**
 * ASTC (Adaptive Scalable Texture Compression) decoder.
 *
 * Wraps `@tootallnate/astc-wasm` (MIT), a pure-Rust ASTC LDR decoder
 * compiled to WebAssembly — supports 4x4 through 12x12 block sizes and
 * outputs RGBA8. The WASM instance is created lazily and cached for reuse
 * across textures.
 *
 * `node:fs`/`node:module` are imported lazily inside `load()` (not at
 * module top level) so this module can be imported from a browser bundle
 * without crashing: Vite's dev server externalizes Node builtins as a
 * Proxy, and a plain top-level named import (`import { readFileSync } from
 * 'node:fs'`) forces an eager property read on that Proxy at
 * module-evaluation time — which throws immediately, before `load()` (and
 * thus `readFileSync`) is ever actually called. A dynamic `import()`
 * deferred until `load()` runs avoids that eager read entirely. `load()`
 * only ever runs when `getDecoder()`/`decodeASTC()` is actually invoked
 * (never during a bare module import), so this has zero effect on
 * Node-side callers.
 */
import { AstcDecoder } from '@tootallnate/astc-wasm';

let decoderPromise: Promise<AstcDecoder> | null = null;

const BLOCK_SIZES: Record<string, { w: number; h: number }> = {
  ASTC_4x4_UNORM: { w: 4, h: 4 },
  ASTC_8x8_UNORM: { w: 8, h: 8 },
  ASTC_4x4_SRGB: { w: 4, h: 4 },
  ASTC_8x8_SRGB: { w: 8, h: 8 },
};

export function getASTCBlockSize(format: string): { w: number; h: number } {
  const b = BLOCK_SIZES[format];
  if (!b) throw new Error(`ASTC: unsupported block size for ${format}`);
  return b;
}

async function load(): Promise<AstcDecoder> {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  // `createRequire(...).resolve()` rather than `import.meta.resolve()`: the latter is
  // rewritten to a non-functional stub by Vite's SSR module transform (the environment
  // both Vitest and a Vite dev server run this file under), so it throws at runtime in
  // exactly the environments this lazy-import dance already exists to support.
  const wasmPath = createRequire(import.meta.url).resolve('@tootallnate/astc-wasm/astc.wasm');
  const wasm = readFileSync(wasmPath);
  return AstcDecoder.create(wasm);
}

function getDecoder(): Promise<AstcDecoder> {
  decoderPromise ??= load();
  return decoderPromise;
}

/**
 * Largest slice, in pixels, handed to the WASM decoder at once. Its allocator
 * is a fixed arena, so a whole 4096x4096 surface (64 MB of RGBA output) fails
 * with "out of WASM memory". ASTC blocks are independent, so the surface is
 * decoded in horizontal bands and stitched — this bounds arena use regardless
 * of texture size, at the cost of one extra WASM call per band.
 */
const BAND_PIXEL_BUDGET = 1 << 20;

/**
 * Decode an ASTC texture to RGBA8.
 * `data` is the linear (deswizzled) ASTC block stream.
 */
export async function decodeASTC(data: Uint8Array, width: number, height: number, format: string): Promise<Uint8Array> {
  const { w: blockW, h: blockH } = getASTCBlockSize(format);
  const decoder = await getDecoder();

  const blocksX = Math.ceil(width / blockW);
  const blocksY = Math.ceil(height / blockH);
  const bytesPerBlockRow = blocksX * 16;

  // Whole-surface fast path.
  if (width * height <= BAND_PIXEL_BUDGET) {
    return decoder.decode(width, height, blockW, blockH, data);
  }

  const blockRowsPerBand = Math.max(1, Math.floor(BAND_PIXEL_BUDGET / (width * blockH)));
  const out = new Uint8Array(width * height * 4);

  for (let row = 0; row < blocksY; row += blockRowsPerBand) {
    const rows = Math.min(blockRowsPerBand, blocksY - row);
    const y = row * blockH;
    const bandHeight = Math.min(rows * blockH, height - y);
    if (bandHeight <= 0) break;

    const src = data.subarray(row * bytesPerBlockRow, (row + rows) * bytesPerBlockRow);
    const band = decoder.decode(width, bandHeight, blockW, blockH, src);
    out.set(band.subarray(0, width * bandHeight * 4), y * width * 4);
  }

  return out;
}
