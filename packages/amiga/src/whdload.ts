/**
 * WHDLoad slave header parser.
 *
 * A WHDLoad install's `.slave` is a HUNK executable whose first CODE
 * hunk begins with the `WHDLOADS` slave structure — and from v10 on it
 * carries the game's real name, copyright and install-info strings,
 * which makes it the one universally machine-readable label in every
 * WHDLoad directory. The accompanying `Disk.N` files are RawDIC images:
 * track data laid out however the install's islave defined it (standard
 * AmigaDOS tracks walk as a filesystem; custom trackloader layouts are
 * opaque by design and carry no shared structure to parse).
 */

import { asciiAt, r16, r32 } from '@seer-project/core';
import { codeHunks, isHunkFile, parseHunkFile } from './hunk.js';

export interface WhdloadSlave {
  version: number;
  flags: number;
  baseMemSize: number;
  /** v10+ strings; null when the slave predates them or leaves them empty. */
  name: string | null;
  copy: string | null;
  info: string | null;
}

const ID = 'WHDLOADS';

function cString(payload: Uint8Array, offset: number): string | null {
  if (offset <= 0 || offset >= payload.length) return null;
  let s = '';
  for (let i = offset; i < payload.length; i++) {
    const b = payload[i];
    if (b === 0) break;
    s += b === 0x0a ? '\n' : b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '?';
  }
  return s.length > 0 ? s : null;
}

/**
 * Parse a `.slave` file. Returns null when the file isn't a HUNK
 * executable or its first CODE hunk doesn't start with the WHDLOADS
 * structure.
 */
export function parseWhdloadSlave(data: Uint8Array): WhdloadSlave | null {
  if (!isHunkFile(data)) return null;
  let hunks;
  try {
    hunks = parseHunkFile(data);
  } catch {
    return null;
  }
  const code = codeHunks(hunks)[0];
  if (!code || code.fileOffset === null || code.size < 42) return null;
  const payload = data.subarray(code.fileOffset, code.fileOffset + code.size);

  if (asciiAt(payload, 4, 8) !== ID) return null;

  const version = r16(payload, 12, 'be');
  const slave: WhdloadSlave = {
    version,
    flags: r16(payload, 14, 'be'),
    baseMemSize: r32(payload, 16, 'be'),
    name: null,
    copy: null,
    info: null,
  };
  if (version >= 10 && payload.length >= 42) {
    slave.name = cString(payload, r16(payload, 36, 'be'));
    slave.copy = cString(payload, r16(payload, 38, 'be'));
    slave.info = cString(payload, r16(payload, 40, 'be'));
  }
  return slave;
}
