/**
 * Node-only access to a Switch container on disk.
 *
 * Both routines exist for the same reason: an NSP is routinely tens of
 * gigabytes, so neither the listing nor the carve may hold the file in
 * memory. `listPfs0File` reads the 0x10 header, sizes the entry table and
 * string table from it, and reads exactly that much; `extractFileRange`
 * copies a byte range out in bounded chunks.
 *
 * Nothing here decrypts anything or knows about keysets.
 */

import { openSync, readSync, writeSync, closeSync } from 'node:fs';

import { PFS0_HEADER_SIZE, parsePfs0Header, parsePfs0, type Pfs0Entry } from '../pfs0.js';

/**
 * Read a PFS0/NSP's entry table off disk, with every `absOffset` already
 * absolute within the file. Throws, with the path in the message, when the
 * file does not start with the `PFS0` magic.
 */
export function listPfs0File(path: string): Pfs0Entry[] {
  const fd = openSync(path, 'r');
  try {
    const head = new Uint8Array(PFS0_HEADER_SIZE);
    readSync(fd, head, 0, PFS0_HEADER_SIZE, 0);
    let headerLength: number;
    try {
      headerLength = parsePfs0Header(head).headerLength;
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`);
    }
    const region = new Uint8Array(headerLength);
    readSync(fd, region, 0, headerLength, 0);
    return parsePfs0(region);
  } finally {
    closeSync(fd);
  }
}

/** Copy `size` bytes at `offset` out of `src` into a new file `dst`, 16 MB at a time. */
export function extractFileRange(src: string, dst: string, offset: number, size: number): void {
  const fd = openSync(src, 'r');
  const outFd = openSync(dst, 'w');
  try {
    const CHUNK = 16 * 1024 * 1024;
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
    let written = 0;
    while (written < size) {
      const toRead = Math.min(buf.length, size - written);
      const n = readSync(fd, buf, 0, toRead, offset + written);
      if (n <= 0) throw new Error(`${src}: short read at ${offset + written} (wanted ${toRead})`);
      writeSync(outFd, buf, 0, n);
      written += n;
    }
  } finally {
    closeSync(fd);
    closeSync(outFd);
  }
}
