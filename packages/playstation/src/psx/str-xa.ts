/**
 * PSX "STR" MDEC video + CD-XA ADPCM audio container.
 *
 * A standard PSX "STR" v2 stream (see jpsxdec's public
 * `PlayStation1_STR_format.txt`) carries a classic 32-byte per-sector video
 * header (magic, chunk/frame counters, dimensions, MDEC-code-count marker,
 * quantization scale, frame version). Two real on-disk shapes exist,
 * differing only in whether the CD-XA subheader survived extraction:
 *
 *  - **Subheader-stripped, video-only** (`sectorStride` 2048): some
 *    extraction pipelines discard the CD-XA layer entirely, leaving pure
 *    logical (Form1) sectors with the STR magic right at sector start. There
 *    is no audio in this shape and no submode/coding_info to read -- wrapping
 *    it back into a raw CD-XA sector for a standard decoder (e.g. ffmpeg's
 *    `psxstr` demuxer) means *synthesizing* a subheader (`wrapAsCdxa` with an
 *    explicit `subheader` option).
 *  - **Subheader-preserved, video+audio interleaved** (`sectorStride` 2336,
 *    a `dumpsxiso`-style "Mode2/2336" extraction): each sector is the real
 *    8-byte CD-XA subheader (file#, channel#, submode, coding_info, each
 *    duplicated once) followed by user data + EDC/ECC, with the 12-byte sync
 *    pattern and 4-byte MSF/mode header stripped (2352 − 16 = 2336). Real
 *    audio (CD-XA ADPCM, submode Audio+Form2) is genuinely interleaved with
 *    video (submode Data) and filler (all-zero) sectors here -- wrapping just
 *    copies each sector's own real subheader through unchanged (`wrapAsCdxa`
 *    with no `subheader` option).
 *
 * Both shapes wrap to full, standard raw 2352-byte CD-XA sectors that a
 * standard, trusted, independent decoder (ffmpeg's native `mdec`/`adpcm_xa`
 * codecs) can decode without reimplementing the MDEC Huffman/IDCT pipeline or
 * the ADPCM codec by hand.
 */
import {
  HEADER_SIZE,
  RAW_SECTOR_SIZE,
  SUBHEADER_SIZE,
  SUBMODE_AUDIO,
  SUBMODE_DATA,
  SUBMODE_FORM2,
  USER_DATA_OFFSET,
  type CdxaSubheader,
  readCdxaSubheader,
  writeCdxaSubheader,
  writeRawSectorHeader,
} from '../cd/sector.js';

/** The fixed 4-byte value at userdata offset 0 of every STR video sector (0x60 0x01 0x01 0x80 read as LE u32). */
export const STR_MAGIC = 0x80010160;

export interface StrVideoSectorHeader {
  chunkNumber: number;
  chunksInFrame: number;
  frameNumber: number;
  /** Bytes of real (demuxed) MDEC data used by this frame, rounded up to a multiple of 4. */
  demuxedSize: number;
  width: number;
  height: number;
  /** Number of MDEC codes in the frame, rounded up to a multiple of 64, divided by 2 (raw field; multiply by 2 for the real count). */
  mdecCodeCountHalf: number;
  quantScale: number;
  /** 2 = fixed 10-bit signed DC; 3 = variable-length-coded DC. */
  version: number;
}

/** Parse the 32-byte STR video-sector header at absolute buffer `offset` (i.e. already past any CD-XA subheader). Returns null if the magic doesn't match. */
export function parseStrVideoHeader(buf: Uint8Array, offset: number): StrVideoSectorHeader | null {
  if (offset + 32 > buf.length) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 32);
  if (dv.getUint32(0, true) !== STR_MAGIC) return null;
  return {
    chunkNumber: dv.getUint16(4, true),
    chunksInFrame: dv.getUint16(6, true),
    frameNumber: dv.getUint32(8, true),
    demuxedSize: dv.getUint32(12, true),
    width: dv.getUint16(16, true),
    height: dv.getUint16(18, true),
    mdecCodeCountHalf: dv.getUint16(20, true),
    quantScale: dv.getUint16(24, true),
    version: dv.getUint16(26, true),
  };
}

/**
 * Check whether every `sectorStride`-byte sector in `buf` (up to `maxSectors`)
 * has the STR magic at `userDataOffset` within it -- the structural
 * invariant that confirms a stream is a pure STR video stream with no
 * interleaved audio/other sector types. Returns the fraction of sectors that
 * matched (1.0 = every sector matched).
 */
export function strMagicCoverage(
  buf: Uint8Array,
  sectorStride: number,
  userDataOffset = 0,
  maxSectors = Infinity,
): number {
  const nSectors = Math.min(Math.floor(buf.length / sectorStride), maxSectors);
  if (nSectors === 0) return 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let hits = 0;
  for (let s = 0; s < nSectors; s++) {
    if (dv.getUint32(s * sectorStride + userDataOffset, true) === STR_MAGIC) hits++;
  }
  return hits / nSectors;
}

export interface Raw2336CorpusStats {
  sectors: number;
  videoSectors: number;
  /** Real (Audio+Form2) sectors -- actual encoded ADPCM audio data. */
  realAudioSectors: number;
  /** Submode-0 placeholder sectors (all-zero subheader+payload) that pad out the audio track's interleave slot once the real audio track has ended but the video continues. */
  fillerSectors: number;
  otherSectors: number;
  width: number | null;
  height: number | null;
  version: number | null;
  frameCount: number;
  hasAudio: boolean;
}

/**
 * Classify every sector in a subheader-preserved (real CD-XA subheader per
 * sector) STR/XA stream. Used both to generate doc/manifest evidence and to
 * decide per-file build behavior (e.g. whether a movie has any real audio to
 * demux at all).
 */
export function classifySubheaderStream(buf: Uint8Array, sectorStride: number): Raw2336CorpusStats {
  const n = Math.floor(buf.length / sectorStride);
  let videoSectors = 0;
  let realAudioSectors = 0;
  let fillerSectors = 0;
  let otherSectors = 0;
  let width: number | null = null;
  let height: number | null = null;
  let version: number | null = null;
  const frames = new Set<number>();

  for (let i = 0; i < n; i++) {
    const { submode } = readCdxaSubheader(buf, i * sectorStride);
    if ((submode & (SUBMODE_DATA | SUBMODE_FORM2)) === SUBMODE_DATA) {
      videoSectors++;
      const vh = parseStrVideoHeader(buf, i * sectorStride + SUBHEADER_SIZE);
      if (vh) {
        width = vh.width;
        height = vh.height;
        version = vh.version;
        frames.add(vh.frameNumber);
      }
    } else if ((submode & (SUBMODE_AUDIO | SUBMODE_FORM2)) === (SUBMODE_AUDIO | SUBMODE_FORM2)) {
      realAudioSectors++;
    } else if (submode === 0) {
      fillerSectors++;
    } else {
      otherSectors++;
    }
  }

  return {
    sectors: n,
    videoSectors,
    realAudioSectors,
    fillerSectors,
    otherSectors,
    width,
    height,
    version,
    frameCount: frames.size,
    hasAudio: realAudioSectors > 0,
  };
}

/**
 * Extract only the real (Audio+Form2) sectors for one CD-XA channel number
 * from a subheader-preserved stream, dropping every filler/other/other-channel
 * sector -- used for a file that multiplexes more than one selectable music
 * channel across a single physical stream (BIOS-style `CdlSetfilter` channel
 * selection). Concatenating just the matching real sectors and wrapping the
 * result with `wrapAsCdxa` gives a standard decoder a clean, contiguous,
 * single-channel ADPCM stream to decode.
 */
export function extractXaChannel(
  raw: Uint8Array,
  sectorStride: number,
  channel: number,
  fileNumber?: number,
): Uint8Array {
  const n = Math.floor(raw.length / sectorStride);
  const out = new Uint8Array(n * sectorStride); // upper bound; sliced to the real written length below
  let written = 0;
  for (let i = 0; i < n; i++) {
    const hdr = readCdxaSubheader(raw, i * sectorStride);
    if (hdr.channel !== channel) continue;
    if (fileNumber !== undefined && hdr.fileNumber !== fileNumber) continue;
    if ((hdr.submode & (SUBMODE_AUDIO | SUBMODE_FORM2)) !== (SUBMODE_AUDIO | SUBMODE_FORM2)) continue;
    out.set(raw.subarray(i * sectorStride, (i + 1) * sectorStride), written);
    written += sectorStride;
  }
  return out.subarray(0, written);
}

/**
 * Reconstitute full, standard raw 2352-byte CD-XA sectors from a stripped
 * STR/XA sector stream at `sectorStride`. Pass `opts.subheader` to synthesize
 * a fixed subheader for every sector (the video-only, 2048-byte-stride
 * shape); omit it to copy each sector's own real subheader through unchanged
 * (the 2336-byte-stride, subheader-preserved shape) -- see this module's doc
 * comment for which shape needs which. `opts.startLba` seeds the synthetic
 * (monotonic, but otherwise arbitrary -- most demuxers don't validate MSF
 * values) sector addresses, default 150 (the standard lead-in-relative start).
 */
export function wrapAsCdxa(
  sectors: Uint8Array,
  sectorStride: number,
  opts: { startLba?: number; subheader?: CdxaSubheader } = {},
): Uint8Array {
  const startLba = opts.startLba ?? 150;
  const n = Math.floor(sectors.length / sectorStride);
  const out = new Uint8Array(n * RAW_SECTOR_SIZE);
  for (let i = 0; i < n; i++) {
    const o = i * RAW_SECTOR_SIZE;
    writeRawSectorHeader(out, o, startLba + i, 2);
    const src = sectors.subarray(i * sectorStride, (i + 1) * sectorStride);
    if (opts.subheader) {
      writeCdxaSubheader(out, o + HEADER_SIZE, opts.subheader);
      out.set(src, o + USER_DATA_OFFSET);
    } else {
      out.set(src, o + HEADER_SIZE);
    }
  }
  return out;
}
