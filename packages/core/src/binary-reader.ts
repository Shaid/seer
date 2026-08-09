import type { Endianness } from './binary.js';

/**
 * BinaryReader — sequential cursor-based reader over an ArrayBuffer.
 *
 * Endianness is a constructor parameter (default big-endian) rather than a
 * hardcoded assumption, since different retro platforms use different byte
 * orders (e.g. 68000-based systems are big-endian; x86 DOS is little-endian).
 * Pass `'le'` when reading data produced by a little-endian target.
 *
 * Unlike the standalone readers in `binary.ts`, this **throws `RangeError`** on
 * overrun. Use it for walking a format you have already confirmed; use those
 * for speculative probing where a miss is expected.
 *
 * **Views the whole `buffer`.** Passing `someUint8Array.buffer` from a
 * *subarray* reads the underlying buffer, not the subarray's slice of it —
 * pass `byteOffset`/`byteLength` explicitly, or `dataViewOf()` a Uint8Array and
 * hand over `view.buffer, view.byteOffset, view.byteLength`.
 */
export class BinaryReader {
  private view: DataView;
  private _offset: number;
  private _endian: Endianness;

  /**
   * @param buffer      Backing buffer.
   * @param offset      Starting cursor position, relative to `byteOffset`.
   * @param endian      Byte order for multi-byte reads (default big-endian).
   * @param byteOffset  Start of the readable window within `buffer` (default 0).
   * @param byteLength  Length of that window (default: to the end of `buffer`).
   */
  constructor(
    buffer: ArrayBuffer,
    offset = 0,
    endian: Endianness = 'be',
    byteOffset = 0,
    byteLength?: number,
  ) {
    this.view = new DataView(buffer, byteOffset, byteLength ?? buffer.byteLength - byteOffset);
    this._offset = offset;
    this._endian = endian;
  }

  get offset(): number {
    return this._offset;
  }

  get length(): number {
    return this.view.byteLength;
  }

  get remaining(): number {
    return this.view.byteLength - this._offset;
  }

  get endian(): Endianness {
    return this._endian;
  }

  private get littleEndian(): boolean {
    return this._endian === 'le';
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.view.byteLength) {
      throw new RangeError(`Seek offset ${offset} out of range [0, ${this.view.byteLength}]`);
    }
    this._offset = offset;
  }

  skip(bytes: number): void {
    this.seek(this._offset + bytes);
  }

  /** Read an unsigned 8-bit integer. */
  readUint8(): number {
    const v = this.view.getUint8(this._offset);
    this._offset += 1;
    return v;
  }

  /** Read a signed 8-bit integer. */
  readInt8(): number {
    const v = this.view.getInt8(this._offset);
    this._offset += 1;
    return v;
  }

  /** Read an unsigned 16-bit integer in the reader's endianness. */
  readUint16(): number {
    const v = this.view.getUint16(this._offset, this.littleEndian);
    this._offset += 2;
    return v;
  }

  /** Read a signed 16-bit integer in the reader's endianness. */
  readInt16(): number {
    const v = this.view.getInt16(this._offset, this.littleEndian);
    this._offset += 2;
    return v;
  }

  /** Read an unsigned 32-bit integer in the reader's endianness. */
  readUint32(): number {
    const v = this.view.getUint32(this._offset, this.littleEndian);
    this._offset += 4;
    return v;
  }

  /** Read a signed 32-bit integer in the reader's endianness. */
  readInt32(): number {
    const v = this.view.getInt32(this._offset, this.littleEndian);
    this._offset += 4;
    return v;
  }

  /** Read a 4-byte ASCII chunk ID (e.g. "FORM", "ILBM"). */
  readFourCC(): string {
    const bytes = this.readBytes(4);
    return String.fromCharCode(...bytes);
  }

  /**
   * Read `length` bytes as a Uint8Array.
   *
   * Returns a **view onto the backing buffer**, not a copy — mutating it
   * mutates the source. Copy it (`.slice()`) if you intend to modify it or to
   * retain it past the buffer's lifetime. Contrast `subReader()`, which copies.
   */
  readBytes(length: number): Uint8Array {
    if (this._offset + length > this.view.byteLength) {
      throw new RangeError(
        `Cannot read ${length} bytes at offset ${this._offset} (buffer length: ${this.view.byteLength})`,
      );
    }
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this._offset, length);
    this._offset += length;
    return bytes;
  }

  /** Read a null-terminated ASCII string. */
  readCString(maxLength = 256): string {
    const chars: number[] = [];
    for (let i = 0; i < maxLength && this._offset < this.view.byteLength; i++) {
      const ch = this.readUint8();
      if (ch === 0) break;
      chars.push(ch);
    }
    return String.fromCharCode(...chars);
  }

  /** Read a fixed-length ASCII string (padded with nulls). */
  readString(length: number): string {
    const bytes = this.readBytes(length);
    let end = bytes.indexOf(0);
    if (end === -1) end = length;
    return String.fromCharCode(...bytes.subarray(0, end));
  }

  /**
   * Create a sub-reader from the current position for `length` bytes.
   *
   * **Copies** those bytes, so the sub-reader is independent of this one's
   * buffer. Contrast `readBytes()`, which returns a view.
   */
  subReader(length: number): BinaryReader {
    const start = this.view.byteOffset + this._offset;
    const buffer = this.view.buffer.slice(start, start + length) as ArrayBuffer;
    this._offset += length;
    return new BinaryReader(buffer, 0, this._endian);
  }
}
