/**
 * Raw CD sector primitives shared by every PSX/PS-family disc format: the
 * 2352-byte MODE1/MODE2 sector layout, CD-XA subheaders, and the BCD/MSF/LBA
 * math used to address them.
 *
 *   0..11   sync pattern (00 FF*10 00)
 *   12..14  address (min,sec,frame BCD)
 *   15      mode (1 = MODE1/plain data or audio-track framing, 2 = MODE2/CD-XA)
 *   16..19  CD-XA subheader (file#, channel#, submode, coding_info) -- MODE2 only
 *   20..23  subheader copy (redundancy)
 *   24..    user data:
 *             Form 1 (submode & 0x20 == 0): 2048B data + 4 EDC + 172 ECC-P + 104 ECC-Q
 *             Form 2 (submode & 0x20 != 0): 2324B data + 4 EDC/spare
 *
 * submode bits: 0x01 EOR, 0x02 Video, 0x04 Audio, 0x08 Data, 0x10 Trigger,
 *               0x20 Form2, 0x40 RealTime, 0x80 EOF
 *
 * A plain MODE1 sector (as used by non-XA data and Red Book audio tracks)
 * has no subheader at all: sync+header (16 bytes) is followed directly by
 * 2048 bytes of user data (or, for audio, the full 2336 bytes to the end of
 * the sector).
 */

export const RAW_SECTOR_SIZE = 2352;
export const SYNC_PATTERN = new Uint8Array([
  0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00,
]);
/** Sync (12) + minute/second/frame/mode (4) preceding a sector's own subheader/user data. */
export const HEADER_SIZE = 16;
/** CD-XA subheader size in bytes (4 real bytes + a mandated duplicate copy). */
export const SUBHEADER_SIZE = 8;
/** Byte offset of the submode byte within a CD-XA subheader. */
const SUBHEADER_SUBMODE_OFFSET = 2;
/** User-data start for a MODE2/CD-XA sector (past header + subheader). */
export const USER_DATA_OFFSET = HEADER_SIZE + SUBHEADER_SIZE;
export const FORM1_USER_SIZE = 2048;
export const FORM2_USER_SIZE = 2324;
export const FORM2_FLAG = 0x20;

/** Sectors in the 2-second lead-in that separates absolute Red Book MSF from LBA. */
export const LEAD_IN_SECTORS = 150;
export const SECTORS_PER_SECOND = 75;
/** 16-bit stereo sample frames per raw (2352-byte) sector. */
export const SAMPLES_PER_SECTOR = RAW_SECTOR_SIZE / 4;
export const REDBOOK_SAMPLE_RATE = 44100;

// CD-XA submode bits (nocash psxspx / standard CD-XA subheader spec).
export const SUBMODE_EOR = 0x01;
export const SUBMODE_VIDEO = 0x02;
export const SUBMODE_AUDIO = 0x04;
export const SUBMODE_DATA = 0x08;
export const SUBMODE_TRIGGER = 0x10;
export const SUBMODE_FORM2 = 0x20;
export const SUBMODE_REALTIME = 0x40;
export const SUBMODE_EOF = 0x80;

export interface CdxaSubheader {
  fileNumber: number;
  channel: number;
  submode: number;
  codingInfo: number;
}

export function bcdEncode(n: number): number {
  return ((Math.floor(n / 10) & 0xf) << 4) | (n % 10 & 0xf);
}

export function bcdDecode(b: number): number {
  return (b >> 4) * 10 + (b & 0xf);
}

/**
 * A physical sector number (LBA, i.e. sectors from the start of the raw
 * image) to Minute/Second/Frame. Callers that need Red Book *absolute* MSF
 * (which includes the 2-second lead-in) should add `LEAD_IN_SECTORS` first,
 * e.g. via `lbaToAbsolute`.
 */
export function lbaToMsf(lba: number): { m: number; s: number; f: number } {
  return {
    m: Math.floor(lba / (60 * SECTORS_PER_SECOND)),
    s: Math.floor(lba / SECTORS_PER_SECOND) % 60,
    f: lba % SECTORS_PER_SECOND,
  };
}

export function msfToLba(msf: { m: number; s: number; f: number }): number {
  return (msf.m * 60 + msf.s) * SECTORS_PER_SECOND + msf.f;
}

/** Parse a cue-sheet-style "MM:SS:FF" timecode into a sector count. */
export function msfStringToSectors(msf: string): number {
  const m = /^(\d+):(\d+):(\d+)$/.exec(msf.trim());
  if (!m) throw new Error(`Malformed MSF timecode: "${msf}"`);
  const [, mm, ss, ff] = m;
  const seconds = Number(ss);
  const frames = Number(ff);
  if (seconds > 59) throw new Error(`MSF seconds out of range: "${msf}"`);
  if (frames > 74) throw new Error(`MSF frames out of range: "${msf}"`);
  return msfToLba({ m: Number(mm), s: seconds, f: frames });
}

/** Format a sector count back as "MM:SS:FF". */
export function sectorsToMsfString(sectors: number): string {
  if (sectors < 0) throw new Error(`Negative sector count: ${sectors}`);
  const { m, s, f } = lbaToMsf(sectors);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(m)}:${p(s)}:${p(f)}`;
}

/** LBA (cue-relative, 0 at the first sector of user data) to absolute Red Book sector, adding the 2-second lead-in. */
export function lbaToAbsolute(lba: number): number {
  return lba + LEAD_IN_SECTORS;
}
export function absoluteToLba(absolute: number): number {
  return absolute - LEAD_IN_SECTORS;
}

export function hasSyncPattern(buf: Uint8Array, offset = 0): boolean {
  if (buf.length - offset < SYNC_PATTERN.length) return false;
  for (let i = 0; i < SYNC_PATTERN.length; i++) {
    if (buf[offset + i] !== SYNC_PATTERN[i]) return false;
  }
  return true;
}

/**
 * Write the 16-byte sync+MSF+mode header of a raw CD sector at `offset` into
 * `out`. `lba` is an absolute (post-lead-in) sector number, since that's what
 * a real disc's header encodes; a synthesized/reconstructed image just needs
 * *a* monotonic value here (most demuxers don't validate it).
 */
export function writeRawSectorHeader(out: Uint8Array, offset: number, lba: number, mode = 2): void {
  out.set(SYNC_PATTERN, offset);
  const { m, s, f } = lbaToMsf(lba);
  out[offset + 12] = bcdEncode(m);
  out[offset + 13] = bcdEncode(s);
  out[offset + 14] = bcdEncode(f);
  out[offset + 15] = mode;
}

/** Write an 8-byte CD-XA subheader (4 real bytes + its mandated duplicate) at `offset`. */
export function writeCdxaSubheader(out: Uint8Array, offset: number, sub: CdxaSubheader): void {
  out[offset] = sub.fileNumber;
  out[offset + 1] = sub.channel;
  out[offset + 2] = sub.submode;
  out[offset + 3] = sub.codingInfo;
  out.set(out.subarray(offset, offset + 4), offset + 4);
}

/** Read an 8-byte CD-XA subheader (the first of its two duplicate copies) at `offset`. */
export function readCdxaSubheader(buf: Uint8Array, offset: number): CdxaSubheader {
  return {
    fileNumber: buf[offset]!,
    channel: buf[offset + 1]!,
    submode: buf[offset + 2]!,
    codingInfo: buf[offset + 3]!,
  };
}

export function isForm2Submode(submode: number): boolean {
  return (submode & FORM2_FLAG) !== 0;
}

/** Anything that can serve 2048-byte-block-addressed logical reads, regardless of the underlying raw-sector stride -- what the ISO9660 walker (`../cd/iso9660.js`) needs. */
export interface DiscReader {
  readLogical(lba: number, length: number): Uint8Array;
}

/**
 * Wraps a raw byte-range reader (2352-byte MODE2/CD-XA sectors, Form1/Form2
 * auto-detect) as a `DiscReader` plus raw-sector access. Browser-safe: takes
 * a `readBytes` callback rather than opening a file itself -- see `../node.js`
 * for a real file-backed constructor.
 */
export class RawCdReader implements DiscReader {
  private readonly readBytes: (offset: number, length: number) => Uint8Array;

  constructor(readBytes: (offset: number, length: number) => Uint8Array) {
    this.readBytes = readBytes;
  }

  readRawSector(lba: number): Uint8Array {
    return this.readBytes(lba * RAW_SECTOR_SIZE, RAW_SECTOR_SIZE);
  }

  isForm2(lba: number): boolean {
    const b = this.readBytes(lba * RAW_SECTOR_SIZE + HEADER_SIZE + SUBHEADER_SUBMODE_OFFSET, 1);
    return isForm2Submode(b[0]!);
  }

  /** Read `length` bytes of Form 1 logical data (2048B/sector) starting at `lba`. Use for ISO9660 filesystem structures, which are always Form 1. */
  readLogical(lba: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let written = 0;
    let cur = lba;
    while (written < length) {
      const sec = this.readRawSector(cur);
      const take = Math.min(FORM1_USER_SIZE, length - written);
      out.set(sec.subarray(USER_DATA_OFFSET, USER_DATA_OFFSET + take), written);
      written += take;
      cur++;
    }
    return out;
  }

  /** Read a large logical byte range in chunks, yielding each with its starting byte offset (relative to `lba`) -- avoids allocating the whole range at once for multi-hundred-MB scans. */
  *readLogicalChunks(
    lba: number,
    totalBytes: number,
    chunkSectors = 4096,
  ): Generator<{ offset: number; data: Uint8Array }> {
    let sec = 0;
    const totalSectors = Math.ceil(totalBytes / FORM1_USER_SIZE);
    while (sec < totalSectors) {
      const take = Math.min(chunkSectors, totalSectors - sec);
      const data = this.readLogical(lba + sec, take * FORM1_USER_SIZE);
      yield { offset: sec * FORM1_USER_SIZE, data };
      sec += take;
    }
  }

  /** Read a file's byte content given its starting LBA + byte length, auto-detecting per-sector Form1 (2048B) vs Form2 (2324B, CD-XA streaming audio/video). */
  readFileExtent(lba: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let written = 0;
    let cur = lba;
    while (written < length) {
      const sec = this.readRawSector(cur);
      const form2 = isForm2Submode(sec[HEADER_SIZE + SUBHEADER_SUBMODE_OFFSET]!);
      const userSize = form2 ? FORM2_USER_SIZE : FORM1_USER_SIZE;
      const take = Math.min(userSize, length - written);
      out.set(sec.subarray(USER_DATA_OFFSET, USER_DATA_OFFSET + take), written);
      written += take;
      cur++;
    }
    return out;
  }
}

/** A plain fixed-stride logical-sector reader (PSP UMD-style ISO9660: no raw CD-XA layer, byte offset = lba * sectorSize). */
export class PlainSectorReader implements DiscReader {
  private readonly readBytes: (offset: number, length: number) => Uint8Array;
  private readonly sectorSize: number;

  constructor(readBytes: (offset: number, length: number) => Uint8Array, sectorSize: number = FORM1_USER_SIZE) {
    this.readBytes = readBytes;
    this.sectorSize = sectorSize;
  }

  readLogical(lba: number, length: number): Uint8Array {
    return this.readBytes(lba * this.sectorSize, length);
  }
}
