/**
 * Shared binary utilities for working with Uint8Array and DataView.
 *
 * These are low-level, byte-oriented primitives with no assumptions about
 * any particular container or resource format — safe to use for any binary
 * reverse-engineering target, on any platform/endianness.
 *
 * Format-specific helpers (e.g. detecting a container's endianness from its
 * magic header) belong alongside that container's own decoder, not here.
 */

export type Endianness = 'be' | 'le';

/** Create a DataView over a Uint8Array, handling byteOffset/byteLength correctly. */
export function dataViewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Read a uint8 at offset. */
export function r8(data: Uint8Array, offset: number): number {
  return data[offset];
}

/** Read a uint16 at offset in the given endianness. */
export function r16(data: Uint8Array, offset: number, endian: Endianness): number {
  if (endian === 'le') return data[offset] | (data[offset + 1] << 8);
  return (data[offset] << 8) | data[offset + 1];
}

/** Read a uint24 at offset in the given endianness. */
export function r24(data: Uint8Array, offset: number, endian: Endianness): number {
  if (endian === 'le') {
    return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
  }
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

/** Read a uint32 at offset in the given endianness. */
export function r32(data: Uint8Array, offset: number, endian: Endianness): number {
  if (endian === 'le') {
    return (
      (data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24)) >>>
      0
    );
  }
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}
