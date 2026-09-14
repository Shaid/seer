/**
 * 3DS game container access (Node-only). Walks the classic container stack —
 * NCSD (.3ds) / NCCH (.cxi) / CIA (.cia) → NCCH → RomFS — and gives the
 * caller random-access reads plus the RomFS filesystem layout.
 *
 * Everything here is container plumbing: the game-agnostic "unpack the ROM"
 * layer. Game-specific asset formats (CTPK, ETC1 textures, BCH, CGFX, LZ)
 * live in the browser-safe part of this package and are decoded by the
 * caller's own per-game build scripts.
 *
 * Byte offsets below are absolute file offsets unless noted otherwise.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MEDIA_UNIT = 0x200;

export interface RomfsLayout {
  /** Absolute offset of the RomFS IVFC superblock. */
  ivfcOffset: number;
  /** Total RomFS section size in bytes (from the NCCH header). */
  romfsSize: number;
  /** Absolute offset of the RomFS filesystem (Lv3 header). */
  dataOffset: number;
  lv3: Lv3Header;
}

export interface Lv3Header {
  dirMetaOffset: number;
  dirMetaSize: number;
  fileMetaOffset: number;
  fileMetaSize: number;
  fileDataOffset: number;
}

export interface RomfsFileEntry {
  /** RomFS path, e.g. `b/a.bin`. */
  path: string;
  /** Absolute file offset of this file's data. */
  offset: number;
  size: number;
}

export interface Container {
  filePath: string;
  kind: 'ncsd' | 'ncch' | 'cia';
  romfs: RomfsLayout;
}

/** Random-access reader over a container file. */
export interface ByteSource {
  readAt(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

class FileByteSource implements ByteSource {
  private fd: FileHandle | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async open(): Promise<void> {
    this.fd = await open(this.filePath, 'r');
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    if (!this.fd) throw new Error('FileByteSource not open');
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await this.fd.read(buf, got, length - got, offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return new Uint8Array(buf.subarray(0, got));
  }

  async close(): Promise<void> {
    await this.fd?.close();
    this.fd = null;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Find a 3DS container file (.3ds/.cxi/.cia) under `dataDir`, case-insensitively. Prefers a full-game cart dump (.3ds) over a digital/update image (.cxi/.cia). */
export function findContainerFile(dataDir: string): string | undefined {
  const priority = (name: string): number => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.3ds')) return 0;
    if (lower.endsWith('.cxi')) return 1;
    return 2;
  };
  let best: { name: string; path: string; prio: number } | undefined;
  // Keyed on the full path: two directories may legitimately hold entries with
  // the same basename, and keying on the bare name would skip the second.
  const seen = new Set<string>();
  const queue: string[] = [dataDir];
  for (let depth = 0; queue.length > 0 && depth < 6; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        if (seen.has(path)) continue;
        seen.add(path);
        const lower = name.toLowerCase();
        if (lower.endsWith('.3ds') || lower.endsWith('.cxi') || lower.endsWith('.cia')) {
          const prio = priority(name);
          if (!best || prio < best.prio) best = { name, path, prio };
          continue;
        }
        try {
          if (statSync(path).isDirectory()) next.push(path);
        } catch {
          /* ignore */
        }
      }
    }
    queue.length = 0;
    queue.push(...next);
  }
  return best?.path;
}

// ---------------------------------------------------------------------------
// Header parsing (pure, over small reads)
// ---------------------------------------------------------------------------

function u32(data: Uint8Array, off: number): number {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
}

function isAscii(data: Uint8Array, off: number, magic: string): boolean {
  for (let i = 0; i < magic.length; i++) if (data[off + i] !== magic.charCodeAt(i)) return false;
  return true;
}

function roundUp(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

/**
 * Given the RomFS IVFC superblock offset, locate the RomFS filesystem (Lv3)
 * start and read its header. The IVFC header is 0x60 bytes; the data follows
 * the master hash table, padded to the level-3 hash block size.
 */
export async function resolveRomfsLayout(
  source: ByteSource,
  ivfcOffset: number,
  superblock: Uint8Array,
): Promise<RomfsLayout> {
  if (superblock.length < 0x60) {
    throw new Error(`Truncated IVFC superblock at 0x${ivfcOffset.toString(16)}`);
  }
  const masterHashSize = u32(superblock, 8);
  const lv3BlockSizeLog = u32(superblock, 0x4c);
  if (lv3BlockSizeLog > 31) {
    throw new Error(`Implausible RomFS level-3 block size 2^${lv3BlockSizeLog}`);
  }
  const lv3BlockSize = 1 << lv3BlockSizeLog;
  const dataOffset = ivfcOffset + roundUp(0x60 + masterHashSize, lv3BlockSize);

  const lv3Bytes = await source.readAt(dataOffset, 0x28);
  const lv3: Lv3Header = {
    dirMetaOffset: u32(lv3Bytes, 12),
    dirMetaSize: u32(lv3Bytes, 16),
    fileMetaOffset: u32(lv3Bytes, 28),
    fileMetaSize: u32(lv3Bytes, 32),
    fileDataOffset: u32(lv3Bytes, 36),
  };
  return { ivfcOffset, romfsSize: 0, dataOffset, lv3 };
}

// ---------------------------------------------------------------------------
// Container resolution
// ---------------------------------------------------------------------------

interface NcchResult {
  romfsOffset: number;
  romfsSize: number;
}

/** Parse an NCCH at `base`, returning its RomFS region (partition-relative offsets). */
function parseNcch(data: Uint8Array, base: number): NcchResult {
  if (!isAscii(data, 0x100, 'NCCH')) throw new Error(`No NCCH magic at 0x${base.toString(16)}`);
  const romfsOffset = u32(data, 0x1b0) * MEDIA_UNIT;
  const romfsSize = u32(data, 0x1b4) * MEDIA_UNIT;
  return { romfsOffset, romfsSize };
}

async function resolveFromNcch(
  source: ByteSource,
  filePath: string,
  ncchBase: number,
  contentSize: number,
): Promise<Container> {
  const header = await source.readAt(ncchBase, 0x400);
  const { romfsOffset, romfsSize } = parseNcch(header, ncchBase);

  let ivfcOffset = ncchBase + romfsOffset;
  let superblock = await source.readAt(ivfcOffset, 0x1000);
  if (!isAscii(superblock, 0, 'IVFC')) {
    // Fallback: scan the partition for the IVFC superblock (covers headers
    // with unusual field layouts).
    const found = await scanForIvfc(source, ncchBase, contentSize);
    ivfcOffset = found.offset;
    superblock = found.data;
  }

  const romfs = await resolveRomfsLayout(source, ivfcOffset, superblock);
  romfs.romfsSize = romfsSize;
  return { filePath, kind: 'ncch', romfs };
}

/** Scan `[start, start+length)` for an IVFC superblock at 0x200-aligned offsets. */
async function scanForIvfc(
  source: ByteSource,
  start: number,
  length: number,
): Promise<{ offset: number; data: Uint8Array }> {
  const chunk = 0x1_000_000; // 16 MiB
  const pattern = new Uint8Array([0x49, 0x56, 0x46, 0x43, 0x00, 0x00, 0x01, 0x00]);
  for (let pos = start; pos < start + length; pos += chunk) {
    const data = await source.readAt(pos, Math.min(chunk, start + length - pos));
    for (let i = 0; i + 8 <= data.length; i += MEDIA_UNIT) {
      let match = true;
      for (let k = 0; k < pattern.length; k++) if (data[i + k] !== pattern[k]) match = false;
      if (match) {
        const offset = pos + i;
        // Re-read the superblock from the source rather than slicing the
        // chunk: a match within 0x1000 bytes of the chunk end would otherwise
        // yield a short buffer, and the level-3 block size at 0x4C would read
        // as undefined → NaN offsets downstream.
        return { offset, data: await source.readAt(offset, 0x1000) };
      }
    }
  }
  throw new Error('No IVFC superblock found in partition');
}

/** Open a file as a raw random-access byte source (no container parsing). */
export async function openRawSource(filePath: string): Promise<FileByteSource> {
  const source = new FileByteSource(filePath);
  await source.open();
  return source;
}

/** Open a container file and resolve its RomFS region. */
export async function openContainer(
  filePath: string,
): Promise<{ container: Container; source: FileByteSource }> {
  const source = await openRawSource(filePath);
  const kind = filePath.toLowerCase().endsWith('.3ds')
    ? 'ncsd'
    : filePath.toLowerCase().endsWith('.cia')
      ? 'cia'
      : 'ncch';

  let container: Container;
  if (kind === 'ncch') {
    // A bare .cxi is the whole partition, so the IVFC fallback scan may search
    // the entire file (passing 0 here would give the scan an empty range).
    const fileSize = statSync(filePath).size;
    container = await resolveFromNcch(source, filePath, 0, fileSize);
  } else if (kind === 'ncsd') {
    const ncsd = await source.readAt(0x100, 0x140);
    const part0Offset = u32(ncsd, 0x20) * MEDIA_UNIT;
    const part0Length = u32(ncsd, 0x24) * MEDIA_UNIT;
    container = await resolveFromNcch(source, filePath, part0Offset, part0Length);
  } else {
    // CIA: certificate chain, ticket, TMD, meta, then contents.
    const header = await source.readAt(0, 0x28);
    const headerSize = u32(header, 0);
    const certSize = u32(header, 0x08);
    const ticketSize = u32(header, 0x0c);
    const tmdSize = u32(header, 0x10);
    const contentSize = u32(header, 0x18) + u32(header, 0x1c) * 0x1_0000_0000;
    const certOff = roundUp(headerSize, 0x40);
    const ticketOff = certOff + roundUp(certSize, 0x40);
    const tmdOff = ticketOff + roundUp(ticketSize, 0x40);
    const contentOff = tmdOff + roundUp(tmdSize, 0x40);

    // Find the first NCCH content (the one carrying the RomFS).
    const { ncchBase, contentLength } = await findNcchContent(source, contentOff, contentSize);
    container = await resolveFromNcch(source, filePath, ncchBase, contentLength);
  }
  return { container, source };
}

/** Scan CIA contents for an NCCH with a valid RomFS. */
async function findNcchContent(
  source: ByteSource,
  contentOff: number,
  contentSize: number,
): Promise<{ ncchBase: number; contentLength: number }> {
  const chunk = 0x1_000_000;
  for (let pos = contentOff; pos < contentOff + contentSize; pos += chunk) {
    const data = await source.readAt(pos, Math.min(chunk, contentOff + contentSize - pos));
    for (let i = 0; i + 0x200 <= data.length; i += MEDIA_UNIT) {
      if (!isAscii(data, i + 0x100, 'NCCH')) continue;
      const romfsOffset = u32(data, i + 0x1b0) * MEDIA_UNIT;
      const ivfc = await source.readAt(pos + i + romfsOffset, 4);
      if (isAscii(ivfc, 0, 'IVFC')) {
        const contentLength = u32(data, i + 0x104) * MEDIA_UNIT;
        return { ncchBase: pos + i, contentLength };
      }
    }
  }
  throw new Error('No NCCH content with RomFS found in CIA');
}

// ---------------------------------------------------------------------------
// RomFS filesystem walk
// ---------------------------------------------------------------------------

/**
 * Walk a RomFS directory tree into a flat file list.
 * `romfs.dataOffset` is the absolute Lv3 start; table offsets within the Lv3
 * header are relative to it, and file data offsets are relative to
 * `dataOffset + lv3.fileDataOffset`.
 */
export async function walkRomfs(source: ByteSource, romfs: RomfsLayout): Promise<RomfsFileEntry[]> {
  const base = romfs.dataOffset;
  const dirmeta = await source.readAt(base + romfs.lv3.dirMetaOffset, romfs.lv3.dirMetaSize);
  const filemeta = await source.readAt(base + romfs.lv3.fileMetaOffset, romfs.lv3.fileMetaSize);
  const fileDataBase = base + romfs.lv3.fileDataOffset;

  const files: RomfsFileEntry[] = [];
  const dirName = (off: number): string => {
    const nameLen = u32(dirmeta, off + 0x14);
    let end = off + 0x18 + nameLen;
    if (end > dirmeta.length) end = dirmeta.length;
    return decodeUtf16(dirmeta.subarray(off + 0x18, end));
  };
  const childDir = (off: number): number => u32(dirmeta, off + 8);
  const childFile = (off: number): number => u32(dirmeta, off + 12);
  const siblingDir = (off: number): number => u32(dirmeta, off + 4);
  const siblingFile = (off: number): number => u32(filemeta, off + 4);

  const visitDir = (off: number, prefix: string): void => {
    const name = dirName(off);
    const full = prefix ? `${prefix}/${name}` : name;

    const firstFile = childFile(off);
    if (firstFile !== 0xffff_ffff) {
      let f = firstFile;
      while (f !== 0xffff_ffff) {
        // Built with multiplication, not `<<`/`|` — those coerce to signed
        // 32-bit ints, so a top byte >= 0x80 (any file past the 2GB mark)
        // sign-extends into a negative offset.
        const sizeLo =
          filemeta[f + 16]! +
          filemeta[f + 17]! * 0x100 +
          filemeta[f + 18]! * 0x1_0000 +
          filemeta[f + 19]! * 0x100_0000;
        const sizeHi =
          filemeta[f + 20]! +
          filemeta[f + 21]! * 0x100 +
          filemeta[f + 22]! * 0x1_0000 +
          filemeta[f + 23]! * 0x100_0000;
        const offLo =
          filemeta[f + 8]! +
          filemeta[f + 9]! * 0x100 +
          filemeta[f + 10]! * 0x1_0000 +
          filemeta[f + 11]! * 0x100_0000;
        const offHi =
          filemeta[f + 12]! +
          filemeta[f + 13]! * 0x100 +
          filemeta[f + 14]! * 0x1_0000 +
          filemeta[f + 15]! * 0x100_0000;
        const nameLen = u32(filemeta, f + 0x1c);
        const fname = decodeUtf16(filemeta.subarray(f + 0x20, f + 0x20 + nameLen));
        files.push({
          path: full ? `${full}/${fname}` : fname,
          offset: fileDataBase + offLo + offHi * 0x1_0000_0000,
          size: sizeLo + sizeHi * 0x1_0000_0000,
        });
        f = siblingFile(f);
      }
    }

    const firstDir = childDir(off);
    if (firstDir !== 0xffff_ffff) {
      let d = firstDir;
      while (d !== 0xffff_ffff) {
        visitDir(d, full);
        d = siblingDir(d);
      }
    }
  };

  visitDir(0, '');
  return files;
}

function decodeUtf16(bytes: Uint8Array): string {
  // RomFS names are UTF-16LE, null-terminated.
  let end = bytes.length;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) {
      end = i;
      break;
    }
  }
  const buf = Buffer.from(bytes.subarray(0, end));
  return buf.toString('utf16le');
}
