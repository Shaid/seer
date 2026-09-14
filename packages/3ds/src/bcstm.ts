/**
 * BCSTM/BFSTM header parser (3DS/Wii U streamed audio — Nintendo's "CSTM"
 * container).
 *
 * This module only reads the header metadata (codec, sample rate, channel
 * count, loop points) — the actual sample data is DSP-ADPCM/IMA-ADPCM/PCM
 * and is typically decoded by shelling out to ffmpeg's own `bfstm` demuxer,
 * the same way `@seer-project/pipeline` uses `node:zlib`/`node:crypto` for
 * other well-established codecs rather than reimplementing them.
 *
 * Verified against real Fire Emblem: Awakening `.bcstm` files: the computed
 * section offsets (INFO → SEEK → DATA, each starting exactly where the prior
 * section ends) line up with the "DATA"/"INFO" sub-magics actually present
 * at those offsets, and the derived sample rate/channel count/duration match
 * ffprobe's independent decode of the same file byte-for-byte.
 *
 * Layout (all little-endian):
 *   0x00 "CSTM", 0x04 u16 BOM (0xFEFF), 0x06 u16 headerSize, 0x08 u32 version,
 *   0x0C u32 fileSize, 0x10 u16 sectionCount, 0x12 u16 reserved,
 *   0x14 + i*12: one section reference per section — u16 id (0x4000 INFO,
 *   0x4001 SEEK, 0x4002 DATA), u16 pad, u32 offset, u32 size.
 *
 * INFO section: "INFO" + u32 size, then at +8 a "ref" (u16 type, u16 pad,
 * u32 offset-from-the-ref's-own-position) to the StreamInfo struct:
 *   +0x00 u8 codec (0 PCM8, 1 PCM16, 2 DSP-ADPCM, 3 IMA-ADPCM)
 *   +0x01 u8 loopFlag, +0x02 u8 channelCount
 *   +0x04 u32 sampleRate, +0x08 u32 loopStartSample, +0x0C u32 totalSamples
 */
import { u16At, u32At } from './le.js';

export type BcstmCodec = 'pcm8' | 'pcm16' | 'dsp-adpcm' | 'ima-adpcm';

export interface BcstmInfo {
  codec: BcstmCodec;
  codecId: number;
  channelCount: number;
  sampleRate: number;
  loopFlag: boolean;
  loopStartSample: number;
  totalSamples: number;
  durationSeconds: number;
}

const CODEC_NAMES: Record<number, BcstmCodec> = {
  0: 'pcm8',
  1: 'pcm16',
  2: 'dsp-adpcm',
  3: 'ima-adpcm',
};

const SECTION_INFO = 0x4000;

/** Parse a BCSTM/BFSTM header. Throws on a bad magic or missing INFO section. */
export function parseBcstmInfo(data: Uint8Array): BcstmInfo {
  if (data.length < 0x14 || u32At(data, 0) !== 0x4d545343 /* "CSTM" LE */) {
    throw new Error('Not a BCSTM/BFSTM file');
  }
  const sectionCount = Math.min(u16At(data, 0x10), 0x10);

  let infoOffset = -1;
  for (let i = 0; i < sectionCount; i++) {
    const eo = 0x14 + i * 12;
    if (eo + 12 > data.length) break;
    if (u16At(data, eo) === SECTION_INFO) {
      infoOffset = u32At(data, eo + 4);
      break;
    }
  }
  if (infoOffset < 0 || infoOffset + 12 > data.length) {
    throw new Error('BCSTM: no INFO section found');
  }

  // The StreamInfo ref sits at INFO+8; its offset is relative to its own
  // field position (the general "ref" convention this container family uses
  // throughout — same pattern as CGFX's relOffset).
  const refPos = infoOffset + 8;
  const streamInfoOffset = refPos + u32At(data, refPos + 4);
  if (streamInfoOffset < 0 || streamInfoOffset + 16 > data.length) {
    throw new Error('BCSTM: StreamInfo out of range');
  }

  const codecId = data[streamInfoOffset]!;
  const codec = CODEC_NAMES[codecId];
  if (!codec) throw new Error(`BCSTM: unknown codec id ${codecId}`);
  const loopFlag = data[streamInfoOffset + 1] !== 0;
  const channelCount = data[streamInfoOffset + 2]!;
  const sampleRate = u32At(data, streamInfoOffset + 4);
  const loopStartSample = u32At(data, streamInfoOffset + 8);
  const totalSamples = u32At(data, streamInfoOffset + 12);

  return {
    codec,
    codecId,
    channelCount,
    sampleRate,
    loopFlag,
    loopStartSample,
    totalSamples,
    durationSeconds: sampleRate > 0 ? totalSamples / sampleRate : 0,
  };
}
