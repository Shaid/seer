/**
 * Shared utilities for offline tool scripts.
 *
 * Generic file I/O, PNG writing, and JSON export helpers with no
 * container-format-specific logic — reusable regardless of what container
 * or bitmap format your target game actually uses.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { encodeWav, int16FromFloat32 } from '@seer-project/core';

/** Read a file as a safe Uint8Array with its own ArrayBuffer (avoids Node.js Buffer pool sharing). */
export function readBinary(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf);
}

/**
 * Write RGBA pixel data as a PNG file, via libvips (sharp) rather than the
 * pure-JS pngjs encoder — measured ~40 MB/s of RGBA with pngjs, the dominant
 * cost (77% of wall clock) in every texture-extraction pipeline built on this
 * package. sharp has no synchronous encode API, so this is async — every
 * caller must await it (a resumed run's existsSync-based skip check, or a
 * worker pool tearing down, can otherwise race an in-flight write).
 */
export async function writePNG(filepath: string, rgba: Uint8Array, width: number, height: number): Promise<void> {
  await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toFile(filepath);
}

/**
 * Write palette-indexed pixel data as an RGBA PNG (index in R channel).
 * Useful for a palette-editor tool that needs to remap colours at runtime
 * without re-decoding the source bitmap.
 *
 * By default index 0 renders fully transparent (A=0) and every other index
 * is fully opaque (A=255) — the common case for sprite art on a keyed
 * background. Pass `transparentIndex: null` when index 0 is a real, opaque
 * color in the source palette (e.g. black is conventionally index 0 in many
 * of these engines), or a different index if some other value is the key.
 */
export function writeIndexedPNG(
  filepath: string,
  indices: Uint8Array,
  width: number,
  height: number,
  opts?: { transparentIndex?: number | null },
) {
  const transparentIndex = opts?.transparentIndex === undefined ? 0 : opts.transparentIndex;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = indices[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = v === transparentIndex ? 0 : 255;
  }
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba);
  writeFileSync(filepath, PNG.sync.write(png));
}

/**
 * Write PCM samples as a minimal RIFF/WAVE file, one or two channels.
 * Thin `writeFileSync` wrapper around `@seer-project/core`'s `encodeWav` —
 * import that directly for the pure byte-buffer version (browser code, or
 * anywhere else disk access isn't available/wanted).
 *
 * - `bits: 8` (unsigned): `channels` must already be raw unsigned 8-bit
 *   sample values (`Uint8Array`), copied byte-for-byte with no scaling.
 * - `bits: 16` (signed, default): `channels` may be either already-quantized
 *   `Int16Array` PCM, or normalized float samples in [-1, 1] (`Float32Array`),
 *   which get quantized here.
 *
 * One array per channel — `[mono]` or `[left, right]`.
 */
export function writeWav(
  filepath: string,
  channels: Uint8Array[],
  opts: { sampleRate: number; bits: 8 },
): void;
export function writeWav(
  filepath: string,
  channels: Int16Array[],
  opts: { sampleRate: number; bits?: 16 },
): void;
export function writeWav(
  filepath: string,
  channels: Float32Array[],
  opts: { sampleRate: number; bits?: 16 },
): void;
export function writeWav(
  filepath: string,
  channels: Uint8Array[] | Int16Array[] | Float32Array[],
  opts: { sampleRate: number; bits?: 8 | 16 },
): void {
  const { sampleRate, bits = 16 } = opts;
  if (bits === 8) {
    writeFileSync(filepath, encodeWav(channels as Uint8Array[], { sampleRate, bits: 8 }));
    return;
  }
  const int16Channels =
    channels.length > 0 && channels[0] instanceof Float32Array
      ? (channels as Float32Array[]).map(int16FromFloat32)
      : (channels as Int16Array[]);
  writeFileSync(filepath, encodeWav(int16Channels, { sampleRate, bits: 16 }));
}

/** Write structured data as a JSON file with optional pretty-printing. */
export function writeJson(filepath: string, data: unknown, pretty = true) {
  writeFileSync(filepath, JSON.stringify(data, null, pretty ? 2 : undefined));
}

/**
 * Resolve a data filename by trying multiple casings/candidates (e.g. a
 * mixed-case name on one platform's port vs. all-uppercase on another).
 * Returns the first matching filename found on disk, or the first candidate
 * if none exist (so callers still get a sensible path in error messages).
 */
export function resolveDataFile(dataDir: string, candidates: string[]): string {
  for (const name of candidates) {
    if (existsSync(`${dataDir}/${name}`)) return name;
  }
  return candidates[0];
}

/**
 * Scan a directory for files matching an extension (case-insensitive).
 * Returns sorted filenames. Generic — not tied to any specific container
 * format's extension.
 */
export function scanFilesByExtension(dataDir: string, extension: string): string[] {
  const pattern = new RegExp(`\\.${extension.replace(/^\./, '')}$`, 'i');
  return readdirSync(dataDir)
    .filter((f: string) => pattern.test(f))
    .sort();
}
