/**
 * Reader for UAE-family (WinUAE/FS-UAE/Amiberry) `.uss` emulator savestate
 * files — walk the chunk stream, zlib-inflate the compressed ones, and hand
 * back a decompressed-RAM ground-truth oracle. Not game data: any Amiga
 * target that resists static analysis (self-decompressing loaders, runtime
 * tables the disk image never holds verbatim) can be captured mid-run
 * instead and read back offline, no running emulator required afterward.
 *
 * Independently reverse-engineered twice (crawl's `kgb` tools and strike's
 * WIME work) before being reconciled here — both projects had it right,
 * they just drew the header/payload boundary in different places. This
 * module follows the 12-byte-header reading (matching `kgb`'s
 * `scanChunks`/`inflateChunk`/`loadSavestate` naming), since a chunk's
 * `flags` genuinely belongs to its header, not its payload — that's what
 * lets {@link inflateChunk} work generically on any compressed chunk
 * instead of special-casing chunk names.
 *
 * ## Format
 *
 * ```
 *   [4]   "ASF "
 *   [4]   u32 BE header length (total bytes through the description string)
 *   [8]   zero padding
 *   [.]   null-terminated emulator identifier string (e.g. "UAE")
 *   [.]   null-terminated version string (e.g. "8.2.2")
 *   [.]   null-terminated description string (may be empty, i.e. "...")
 *   --- first chunk starts here, 4-byte aligned ---
 *   repeat:
 *     [4]  name (4 printable ASCII chars, e.g. "CPU ", "CRAM", "BRAM")
 *     [4]  u32 BE size (header-inclusive: name + size + flags + payload)
 *     [4]  u32 BE flags (bit 0 = payload is zlib-deflate compressed)
 *     [size-12]  payload — if flags & 1, a 4-byte BE uncompressed-length
 *                prefix followed by a raw zlib-deflate stream
 *   each chunk is padded to a 4-byte boundary after `size`
 * ```
 *
 * The declared `size` field cannot always be trusted to locate the next
 * chunk — real savestates have been observed with a handful of stray bytes
 * between chunks that `size` doesn't account for. A strict offset-arithmetic
 * walker desyncs after the first such gap and never recovers, so
 * {@link scanChunks} verifies each computed "next chunk" position actually
 * looks like a plausible header, and scans forward for the next one that
 * does when it doesn't.
 */

import { r32 } from '@seer-project/core';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface UssChunk {
  offset: number;
  name: string;
  /** Declared size, header-inclusive (12 bytes of name+size+flags, plus the payload). */
  size: number;
  flags: number;
  payloadOffset: number;
  payloadLength: number;
}

export interface Savestate {
  data: Uint8Array;
  chunks: UssChunk[];
}

const RESYNC_WINDOW = 64;

function looksLikeName(data: Uint8Array, o: number): boolean {
  for (let i = 0; i < 4; i++) {
    const c = data[o + i];
    if (c === undefined || c < 32 || c > 126) return false;
  }
  return true;
}

function looksLikeHeader(data: Uint8Array, o: number, n: number): boolean {
  if (!looksLikeName(data, o)) return false;
  if (o + 12 > n) return false;
  const size = r32(data, o + 4, 'be');
  const flags = r32(data, o + 8, 'be');
  return size >= 12 && o + size <= n + 16 && flags <= 3;
}

/**
 * Walk a `.uss` file's chunk stream. Requires the `"ASF "` magic (real
 * savestates always have it) — a raw memory dump without the wrapper isn't
 * this format at all, not a variant to resync past.
 */
export function scanChunks(data: Uint8Array): UssChunk[] {
  if (new TextDecoder().decode(data.subarray(0, 4)) !== 'ASF ') {
    throw new Error('Not a UAE-family .uss savestate (missing "ASF " magic)');
  }
  const n = data.length;
  const headerLength = r32(data, 4, 'be');
  const chunks: UssChunk[] = [];
  let off = (headerLength + 3) & ~3;

  while (off + 12 <= n) {
    if (!looksLikeHeader(data, off, n)) {
      let found = -1;
      for (let cand = off + 1; cand < Math.min(off + RESYNC_WINDOW, n - 12); cand++) {
        if (looksLikeHeader(data, cand, n)) {
          found = cand;
          break;
        }
      }
      if (found < 0) break;
      off = found;
    }

    const name = new TextDecoder().decode(data.subarray(off, off + 4));
    const size = r32(data, off + 4, 'be');
    const flags = r32(data, off + 8, 'be');
    const payloadOffset = off + 12;
    const payloadLength = size - 12;
    chunks.push({ offset: off, name, size, flags, payloadOffset, payloadLength });

    if (name === 'END ') break;

    const naiveNext = off + size;
    off = (naiveNext + 3) & ~3;
  }

  return chunks;
}

export function findChunk(chunks: UssChunk[], name: string): UssChunk | undefined {
  return chunks.find((c) => c.name === name);
}

export function chunkPayload(data: Uint8Array, chunk: UssChunk): Uint8Array {
  return data.subarray(chunk.payloadOffset, chunk.payloadOffset + chunk.payloadLength);
}

/**
 * A chunk's payload, inflating it first if `flags & 1` marks it as
 * zlib-deflate compressed (CRAM/BRAM/ZRAM on the savestates seen so far —
 * generically, any compressed chunk, not a hardcoded name list). Throws if
 * the inflated length doesn't match the declared 4-byte length prefix.
 */
export function inflateChunk(data: Uint8Array, chunk: UssChunk): Uint8Array {
  const payload = chunkPayload(data, chunk);
  if (!(chunk.flags & 1)) return payload;
  const declaredLen = r32(payload, 0, 'be');
  const compressed = payload.subarray(4);
  const out = inflateSync(compressed);
  if (out.length !== declaredLen) {
    throw new Error(`inflateChunk: length mismatch for ${chunk.name} (declared ${declaredLen}, got ${out.length})`);
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Read and scan a `.uss` file in one call — the common case for offline
 * tooling. Node-only (this is the one function in the module that touches
 * the filesystem); {@link scanChunks} and friends stay `Uint8Array`-in,
 * so a browser-hosted consumer can still use them on a file the user
 * dropped in, it just can't use this convenience wrapper.
 */
export function loadSavestate(path: string): Savestate {
  const data = new Uint8Array(readFileSync(path));
  const chunks = scanChunks(data);
  return { data, chunks };
}
