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
 * Write palette-indexed pixel data as an RGBA PNG (index in R channel, A=255).
 * Useful for a palette-editor tool that needs to remap colours at runtime
 * without re-decoding the source bitmap.
 */
export function writeIndexedPNG(
  filepath: string,
  indices: Uint8Array,
  width: number,
  height: number,
) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = indices[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = v === 0 ? 0 : 255;
  }
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba);
  writeFileSync(filepath, PNG.sync.write(png));
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
