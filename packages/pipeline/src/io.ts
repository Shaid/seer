/**
 * Shared utilities for offline tool scripts.
 *
 * Generic file I/O, PNG writing, and JSON export helpers with no
 * container-format-specific logic — reusable regardless of what container
 * or bitmap format your target game actually uses.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';

/** Read a file as a safe Uint8Array with its own ArrayBuffer (avoids Node.js Buffer pool sharing). */
export function readBinary(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf);
}

/** Write RGBA pixel data as a PNG file. */
export function writePNG(filepath: string, rgba: Uint8Array, width: number, height: number) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba);
  writeFileSync(filepath, PNG.sync.write(png));
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
 *
 * - `bits: 8` (unsigned): `channels` must already be raw unsigned 8-bit
 *   sample values (`Uint8Array`), copied byte-for-byte with no scaling.
 * - `bits: 16` (signed, default): `channels` must be normalized float
 *   samples in [-1, 1] (`Float32Array`), quantized to 16-bit PCM.
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
  channels: Float32Array[],
  opts: { sampleRate: number; bits?: 16 },
): void;
export function writeWav(
  filepath: string,
  channels: Uint8Array[] | Float32Array[],
  opts: { sampleRate: number; bits?: 8 | 16 },
): void {
  const { sampleRate, bits = 16 } = opts;
  const numChannels = channels.length;
  const numSamples = channels[0]?.length ?? 0;
  const bytesPerSample = bits / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  let off = 0;
  buf.write('RIFF', off);
  off += 4;
  buf.writeUInt32LE(36 + dataSize, off);
  off += 4;
  buf.write('WAVE', off);
  off += 4;
  buf.write('fmt ', off);
  off += 4;
  buf.writeUInt32LE(16, off);
  off += 4;
  buf.writeUInt16LE(1, off); // PCM
  off += 2;
  buf.writeUInt16LE(numChannels, off);
  off += 2;
  buf.writeUInt32LE(sampleRate, off);
  off += 4;
  buf.writeUInt32LE(sampleRate * blockAlign, off);
  off += 4;
  buf.writeUInt16LE(blockAlign, off);
  off += 2;
  buf.writeUInt16LE(bits, off);
  off += 2;
  buf.write('data', off);
  off += 4;
  buf.writeUInt32LE(dataSize, off);
  off += 4;

  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      if (bits === 8) {
        buf.writeUInt8((channels[ch] as Uint8Array)[i] & 0xff, off);
        off += 1;
      } else {
        const sample = (channels[ch] as Float32Array)[i];
        const v = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
        buf.writeInt16LE(v, off);
        off += 2;
      }
    }
  }
  writeFileSync(filepath, buf);
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
