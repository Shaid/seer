/**
 * Minimal read-only ISO9660 directory-record walker, parameterized over a
 * `DiscReader` (see `./sector.js`) rather than any one disc-image shape --
 * the directory-record format itself is identical whether the logical
 * sectors are read through a raw MODE2/2352 CD-XA layer or straight off a
 * plain 2048-byte-stride image (a PSP UMD, or a cooked/stripped ISO file).
 */
import type { DiscReader } from './sector.js';

const ISO_LOGICAL_BLOCK = 2048;

export interface PvdInfo {
  systemId: string;
  volumeId: string;
  volumeSpaceSize: number;
  logicalBlockSize: number;
  rootExtentLba: number;
  rootExtentLen: number;
}

function ascii(data: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(data[i]!);
  return s;
}

/** Parse the Primary Volume Descriptor at logical sector `lba` (default 16). */
export function parsePvd(disc: DiscReader, lba = 16): PvdInfo {
  const data = disc.readLogical(lba, ISO_LOGICAL_BLOCK);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stdId = ascii(data, 1, 6);
  if (stdId !== 'CD001') throw new Error(`bad PVD id: ${stdId}`);
  const systemId = ascii(data, 8, 40).trim();
  const volumeId = ascii(data, 40, 72).trim();
  const volumeSpaceSize = view.getUint32(80, true);
  const logicalBlockSize = view.getUint16(128, true);
  const rootDr = data.subarray(156, 156 + 34);
  const rootView = new DataView(rootDr.buffer, rootDr.byteOffset, rootDr.byteLength);
  const rootExtentLba = rootView.getUint32(2, true);
  const rootExtentLen = rootView.getUint32(10, true);
  return { systemId, volumeId, volumeSpaceSize, logicalBlockSize, rootExtentLba, rootExtentLen };
}

export interface DirEntry {
  path: string;
  name: string;
  isDir: boolean;
  extentLba: number;
  dataLen: number;
}

function parseDirectoryRecords(disc: DiscReader, lba: number, length: number): DirEntry[] {
  const data = disc.readLogical(lba, length);
  const entries: DirEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const recLen = data[off]!;
    if (recLen === 0) {
      const nextSectorOff = (Math.floor(off / ISO_LOGICAL_BLOCK) + 1) * ISO_LOGICAL_BLOCK;
      if (nextSectorOff <= off) break;
      off = nextSectorOff;
      continue;
    }
    const rec = data.subarray(off, off + recLen);
    const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    const extentLba = view.getUint32(2, true);
    const dataLen = view.getUint32(10, true);
    const flags = rec[25]!;
    const nameLen = rec[32]!;
    const nameRaw = rec.subarray(33, 33 + nameLen);
    if (!(nameRaw.length === 1 && (nameRaw[0] === 0 || nameRaw[0] === 1))) {
      let name = ascii(nameRaw, 0, nameRaw.length);
      const semi = name.indexOf(';');
      if (semi !== -1) name = name.slice(0, semi);
      entries.push({ path: '', name, isDir: (flags & 0x02) !== 0, extentLba, dataLen });
    }
    off += recLen;
  }
  return entries;
}

/** Recursively walk the ISO9660 directory tree starting at a directory extent. */
export function walk(disc: DiscReader, lba: number, length: number, path = ''): DirEntry[] {
  const results: DirEntry[] = [];
  for (const entry of parseDirectoryRecords(disc, lba, length)) {
    const full = `${path}/${entry.name}`;
    results.push({ ...entry, path: full });
    if (entry.isDir) results.push(...walk(disc, entry.extentLba, entry.dataLen, full));
  }
  return results;
}

/** Convenience: parse PVD + full recursive file listing in one call. */
export function listFiles(disc: DiscReader): { pvd: PvdInfo; entries: DirEntry[] } {
  const pvd = parsePvd(disc);
  const entries = walk(disc, pvd.rootExtentLba, pvd.rootExtentLen);
  return { pvd, entries };
}

/** Find one file by its full ISO path (case-sensitive, leading slash optional, e.g. "PSP_GAME/USRDIR/DATA.BIN"). */
export function findPath(disc: DiscReader, path: string): DirEntry | undefined {
  const wanted = `/${path.replace(/^\/+/, '')}`;
  const { entries } = listFiles(disc);
  return entries.find((e) => e.path === wanted);
}
