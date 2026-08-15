/**
 * Random-access byte sources.
 *
 * Triage over a network share (SMB/NFS) is wire-bound, not CPU-bound:
 * reading every byte of a large collection means transferring all of it.
 * A source lets callers read only the ranges they actually need — a
 * ZIP's central directory, a file's head and tail — and reports
 * `bytesRead` so the saving is measurable rather than assumed.
 */

import { closeSync, openSync, readSync } from 'node:fs';

export interface ByteSource {
  readonly size: number;
  /** Bytes actually pulled from the underlying medium so far. */
  readonly bytesRead: number;
  /** Read `length` bytes at `offset`, clamped to the source's bounds. */
  read(offset: number, length: number): Uint8Array;
  readAll(): Uint8Array;
  close(): void;
}

class FileByteSource implements ByteSource {
  private fd: number;
  readonly size: number;
  bytesRead = 0;

  constructor(path: string, size: number) {
    this.fd = openSync(path, 'r');
    this.size = size;
  }

  read(offset: number, length: number): Uint8Array {
    const start = Math.max(0, Math.min(offset, this.size));
    const len = Math.max(0, Math.min(length, this.size - start));
    const buf = new Uint8Array(len);
    let got = 0;
    while (got < len) {
      const n = readSync(this.fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    this.bytesRead += got;
    return got === len ? buf : buf.subarray(0, got);
  }

  readAll(): Uint8Array {
    return this.read(0, this.size);
  }

  close(): void {
    closeSync(this.fd);
  }
}

class BufferByteSource implements ByteSource {
  private data: Uint8Array;
  bytesRead = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get size(): number {
    return this.data.length;
  }

  read(offset: number, length: number): Uint8Array {
    const start = Math.max(0, Math.min(offset, this.size));
    const len = Math.max(0, Math.min(length, this.size - start));
    this.bytesRead += len;
    return this.data.subarray(start, start + len);
  }

  readAll(): Uint8Array {
    this.bytesRead += this.data.length;
    return this.data;
  }

  close(): void {}
}

export function fileSource(path: string, size: number): ByteSource {
  return new FileByteSource(path, size);
}

/** Wrap an in-memory buffer (nested archive members, ADF file contents). */
export function bufferSource(data: Uint8Array): ByteSource {
  return new BufferByteSource(data);
}
