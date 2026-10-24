/**
 * Read-only AmigaDOS filesystem (OFS/FFS) reader for ADF disk images.
 *
 * Enough to answer "what files are on this disk?" and extract them —
 * TOSEC-style corpora ship games as ADFs, and a mountable `DOS\0` disk
 * should be walked as a filesystem, not carved as a blob. Not a driver:
 * no bitmap handling, no writing, checksums are not verified (recon
 * reads damaged and slightly nonstandard disks on purpose; a bad
 * pointer is caught by bounds checks instead).
 *
 * Trackloader disks (bootblock magic ≠ `DOS·`) report `NDOS` and stay
 * blobs — that itself is triage signal.
 */

import { printableAsciiAt, r32 } from '@seer-project/core';

const BLOCK = 512;
/** Hash-table size in a 512-byte root/dir block. */
const HT_SIZE = 72;

const T_HEADER = 2;
/** Primary type of a file-list ("extension") block — chains a file's data-block pointers past the header block's own 72-entry table. */
const T_LIST = 16;
const ST_ROOT = 1;
const ST_USERDIR = 2;
const ST_FILE = -3;

export type BootblockType =
  | 'OFS'
  | 'FFS'
  | 'OFS-INTL'
  | 'FFS-INTL'
  | 'OFS-DC'
  | 'FFS-DC'
  | 'NDOS'
  | 'KICK';

/** Standard double-density (880 KB) and high-density (1.76 MB) ADF sizes. */
export function isAdfSize(byteLength: number): boolean {
  return byteLength === 901120 || byteLength === 1802240;
}

/** Classify the bootblock: `DOS` + flags byte, Kickstart disk, or not-a-DOS-filesystem. */
export function adfBootblockType(data: Uint8Array): BootblockType {
  if (data.length < 4) return 'NDOS';
  if (data[0] === 0x4b && data[1] === 0x49 && data[2] === 0x43 && data[3] === 0x4b) return 'KICK';
  if (data[0] !== 0x44 || data[1] !== 0x4f || data[2] !== 0x53 || data[3] > 7) return 'NDOS';
  const flags = data[3];
  const base = flags & 1 ? 'FFS' : 'OFS';
  if (flags & 4) return `${base}-DC` as BootblockType;
  if (flags & 2) return `${base}-INTL` as BootblockType;
  return base as BootblockType;
}

export interface AdfEntry {
  /** Slash-joined path from the disk root. */
  path: string;
  type: 'file' | 'dir';
  /** Byte size for files; 0 for directories. */
  size: number;
  /** Header block number (needed by `readAdfFile`). */
  headerBlock: number;
}

function blockOffset(block: number): number {
  return block * BLOCK;
}

function bcplName(data: Uint8Array, blockStart: number): string {
  const nameOff = blockStart + 0x1b0;
  const len = Math.min(data[nameOff] ?? 0, 30);
  return printableAsciiAt(data, nameOff + 1, len, '_');
}

function validHeader(data: Uint8Array, block: number, totalBlocks: number): boolean {
  if (block <= 0 || block >= totalBlocks) return false;
  return r32(data, blockOffset(block), 'be') === T_HEADER;
}

/**
 * Like `validHeader`, but also accepts `T_LIST` ("file extension") blocks —
 * used only when following a file's extension-block chain in
 * `readAdfFile`. A file's *first* header block is always `T_HEADER`, but
 * every subsequent block in the chain (holding the data-block pointers
 * past the first block's own 72-entry table, needed once a file exceeds
 * ~72 data blocks — roughly 35 KB on OFS, 36 KB on FFS) is `T_LIST`, not
 * `T_HEADER`. Requiring `T_HEADER` unconditionally here silently truncated
 * every file larger than that to just its first block's worth of data —
 * caught reverse-engineering Chaos Strikes Back's 435,397-byte
 * `Graphics.DAT` (crawl project): it decoded plausible image content for
 * ~30 KB, then all-zero padding to EOF, even though the on-disk extension
 * chain itself (12 more `T_LIST` blocks, verified by a raw walk) was
 * completely intact.
 */
function validChainBlock(data: Uint8Array, block: number, totalBlocks: number): boolean {
  if (block <= 0 || block >= totalBlocks) return false;
  const t = r32(data, blockOffset(block), 'be');
  return t === T_HEADER || t === T_LIST;
}

function secType(data: Uint8Array, block: number): number {
  const v = r32(data, blockOffset(block) + BLOCK - 4, 'be');
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

/**
 * List every file and directory on a DOS-filesystem ADF. Returns null
 * when the image is not a walkable AmigaDOS disk (NDOS/KICK bootblock,
 * or a root block that doesn't parse).
 */
export function listAdf(data: Uint8Array): AdfEntry[] | null {
  const boot = adfBootblockType(data);
  if (boot === 'NDOS' || boot === 'KICK') return null;
  const totalBlocks = Math.floor(data.length / BLOCK);
  const root = totalBlocks >> 1;
  if (!validHeader(data, root, totalBlocks) || secType(data, root) !== ST_ROOT) return null;

  const entries: AdfEntry[] = [];
  const seen = new Set<number>();

  const walkDir = (dirBlock: number, prefix: string): void => {
    const base = blockOffset(dirBlock);
    for (let slot = 0; slot < HT_SIZE; slot++) {
      let block = r32(data, base + 24 + slot * 4, 'be');
      // Follow the hash chain; `seen` guards against pointer loops on
      // corrupt disks.
      while (block !== 0 && validHeader(data, block, totalBlocks) && !seen.has(block)) {
        seen.add(block);
        const st = secType(data, block);
        const name = bcplName(data, blockOffset(block));
        const path = prefix ? `${prefix}/${name}` : name;
        if (st === ST_FILE) {
          // A file cannot be larger than the disk holding it. The size
          // field is unvalidated on-disk data: a corrupt or non-DOS
          // block yields values near 2^32, and trusting one means
          // allocating gigabytes for an 880 KB floppy.
          const raw = r32(data, blockOffset(block) + BLOCK - 47 * 4, 'be');
          const size = raw > data.length ? 0 : raw;
          entries.push({ path, type: 'file', size, headerBlock: block });
        } else if (st === ST_USERDIR) {
          entries.push({ path, type: 'dir', size: 0, headerBlock: block });
          walkDir(block, path);
        }
        block = r32(data, blockOffset(block) + BLOCK - 4 * 4, 'be'); // next in hash chain
      }
    }
  };

  walkDir(root, '');
  return entries;
}

/**
 * Read a file's bytes by walking its header's data-block table (and
 * extension blocks). OFS data blocks carry a 24-byte header; FFS blocks
 * are raw.
 */
export function readAdfFile(data: Uint8Array, entry: AdfEntry): Uint8Array {
  const boot = adfBootblockType(data);
  const ffs = boot.startsWith('FFS');
  const totalBlocks = Math.floor(data.length / BLOCK);
  // Clamped for the same reason `listAdf` clamps: never size an
  // allocation from an unvalidated on-disk field.
  const out = new Uint8Array(Math.min(entry.size, data.length));
  let written = 0;

  let header = entry.headerBlock;
  const visited = new Set<number>();
  while (header !== 0 && !visited.has(header) && validChainBlock(data, header, totalBlocks)) {
    visited.add(header);
    const base = blockOffset(header);
    const highSeq = r32(data, base + 8, 'be');
    // Data-block pointers are stored in reverse order in the table.
    for (let i = 0; i < Math.min(highSeq, HT_SIZE); i++) {
      const dataBlock = r32(data, base + 24 + (HT_SIZE - 1 - i) * 4, 'be');
      if (dataBlock <= 0 || dataBlock >= totalBlocks || written >= entry.size) break;
      const src = blockOffset(dataBlock) + (ffs ? 0 : 24);
      const chunk = Math.min(ffs ? BLOCK : BLOCK - 24, entry.size - written);
      out.set(data.subarray(src, src + chunk), written);
      written += chunk;
    }
    header = r32(data, base + BLOCK - 2 * 4, 'be'); // extension block
  }
  return out;
}
