/**
 * PSP `sceMpeg`/`MpegDemux` private-stream-1 ATRAC3+ audio extraction, and a
 * minimal Sony OMA/`"EA3"` container writer, so the extracted elementary
 * stream can be handed to a standard, trusted decoder (ffmpeg's stock
 * `oma`/`atrac3plus` support) rather than hand-reimplementing the codec.
 * Confirmed byte-exact/zero-remainder against a real PSMF movie stream: a
 * frame walk with zero remainder, decoded via a hand-built EA3 header to
 * verified non-degenerate PCM.
 *
 * PSX-vs-PSP note: this is a genuinely PSP-specific mechanism, not shared
 * with PSX (whose own FMV audio is hardware CD-XA ADPCM, physically
 * interleaved into disc sectors -- no software audio codec at all; see
 * `../psx/str-xa.js`).
 *
 * Framing, confirmed from PPSSPP's own `Core/HW/MpegDemux.cpp` source
 * (`hrydgard/ppsspp`), not guesswork:
 *  - Each `0xBD` (`private_stream_1`) PES packet's payload (after the
 *    standard PES header, respecting the real `PES_header_data_length`
 *    field) begins with a 1-byte "channel" id. A channel byte outside
 *    `[0x80,0xCF]` takes the "PSP audio has additional 3 bytes in header"
 *    branch -- 4 bytes total consumed before real ES data starts.
 *  - The concatenated ES bytes across a movie's `0xBD` packets are a sequence
 *    of fixed-size "slots", each beginning with a 2-byte sync word (`0x0F
 *    0xD0`) then 2 "code" bytes encoding the *whole slot's* size: `slotSize =
 *    (((code1 & 0x03) << 8) | (code2 * 8)) + 0x10`.
 *  - The real, headerless ATRAC3+ bitstream frame a standards-compliant
 *    decoder consumes is the *trailing* `slotSize - 8` bytes of each slot
 *    (confirmed against `libavcodec/atrac3plusdec.c`, which has no
 *    sync-word/sub-header handling of its own) -- the leading 8 bytes (sync
 *    word + code1 + code2 + 4 further, still-unresolved bytes) are pure PSP
 *    mux-layer framing, not part of the codec's own bitstream.
 */

export interface Atrac3pExtraction {
  /** Raw, headerless ATRAC3+ elementary-stream bytes (concatenated frames). */
  esBytes: Uint8Array;
  /** Per-frame payload size in bytes (slotSize - 8), constant within one movie. */
  frameSizeBytes: number;
  /** Number of 0xBD PES packets consumed. */
  packetCount: number;
  /** Number of ATRAC3+ frames extracted. */
  frameCount: number;
  /** True if the whole concatenated slot stream walked with zero remainder and zero sync loss. */
  clean: boolean;
}

/**
 * Walk an entire raw PSMF/MPEG-PS movie buffer, extract every `0xBD`
 * (`private_stream_1`) packet's payload bytes (after the PES header + the
 * confirmed 4-byte channel sub-header skip), concatenate them into one "slot
 * stream", then strip each slot's 8-byte PSP mux framing header. Returns
 * `null` if no `0xBD` packets are found at all.
 */
export function extractAtrac3pFromPsmf(buf: Uint8Array): Atrac3pExtraction | null {
  const slotStream: number[] = [];
  let packetCount = 0;
  let i = 0;
  while (i < buf.length - 6) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const code = buf[i + 3]!;
      if (code === 0xba) {
        // Pack header: fixed 14-byte header + a variable stuffing-length tail.
        if (i + 14 > buf.length) break;
        const stuffingLen = buf[i + 13]! & 0x7;
        i += 14 + stuffingLen;
        continue;
      } else if (code === 0xbd || code === 0xe0) {
        if (i + 6 > buf.length) break;
        const pesPacketLength = (buf[i + 4]! << 8) | buf[i + 5]!;
        if (code === 0xbd) {
          const pesHeaderDataLength = buf[i + 8] ?? 0;
          const payloadStart = i + 9 + pesHeaderDataLength;
          const payloadEnd = i + 6 + pesPacketLength;
          if (payloadStart < payloadEnd && payloadEnd <= buf.length) {
            const channel = buf[payloadStart]!;
            const skip = channel >= 0x80 && channel <= 0xcf ? (channel >= 0xb0 && channel <= 0xbf ? 4 : 3) : 3;
            const esStart = payloadStart + 1 + skip;
            for (let p = esStart; p < payloadEnd; p++) slotStream.push(buf[p]!);
            packetCount++;
          }
        }
        i += 6 + pesPacketLength;
        continue;
      } else {
        i += 4;
      }
    } else {
      i++;
    }
  }

  if (packetCount === 0 || slotStream.length < 4) return null;

  // Walk the slot stream: sync word (0x0F 0xD0) + code1 + code2 at each slot
  // start, slotSize = (((code1&3)<<8)|(code2*8))+0x10, constant
  // frameSizeBytes = slotSize - 8 across the whole movie.
  const slots = new Uint8Array(slotStream);
  const es: number[] = [];
  let pos = 0;
  let frameSizeBytes = 0;
  let clean = true;
  while (pos + 4 <= slots.length) {
    if (slots[pos] !== 0x0f || slots[pos + 1] !== 0xd0) {
      clean = false;
      break;
    }
    const code1 = slots[pos + 2]!;
    const code2 = slots[pos + 3]!;
    const slotSize = (((code1 & 0x03) << 8) | (code2 * 8)) + 0x10;
    if (pos + slotSize > slots.length) {
      clean = false;
      break;
    }
    frameSizeBytes = slotSize - 8;
    for (let p = pos + 8; p < pos + slotSize; p++) es.push(slots[p]!);
    pos += slotSize;
  }
  if (pos !== slots.length) clean = false;

  return {
    esBytes: new Uint8Array(es),
    frameSizeBytes,
    packetCount,
    frameCount: frameSizeBytes > 0 ? es.length / frameSizeBytes : 0,
    clean,
  };
}

export const EA3_HEADER_SIZE = 96;

export interface Ea3HeaderOptions {
  /** Raw ATRAC3+ frame payload size in bytes (post 8-byte-slot-header-strip). */
  frameSizeBytes: number;
  /** 1 = mono, 2 = stereo, ... 7 = 7.1 -- see `oma_chid_to_native_layout` in ffmpeg's omadec.c. */
  channelId?: number;
  /** Sample rate in Hz -- must be one of ff_oma_srate_tab's non-zero entries (32000/44100/48000/88200/96000). */
  sampleRateHz?: number;
}

const OMA_SRATE_TAB = [32000, 44100, 48000, 88200, 96000, 0, 0, 0];

/**
 * Build a minimal, valid 96-byte Sony OMA/`"EA3"` header wrapping a raw
 * ATRAC3+ elementary stream, so a standard decoder (ffmpeg's `oma` demuxer +
 * `atrac3plus` decoder) can read it with zero custom codec work. Field
 * derivation confirmed against ffmpeg's own `libavformat/omadec.c`
 * (`oma_read_header`, `OMA_CODECID_ATRAC3P` case).
 */
export function buildEa3Header(opts: Ea3HeaderOptions): Uint8Array {
  const channelId = opts.channelId ?? 2;
  const sampleRateHz = opts.sampleRateHz ?? 44100;
  const srateIdx = OMA_SRATE_TAB.indexOf(sampleRateHz);
  if (srateIdx < 0) throw new Error(`buildEa3Header: unsupported sample rate ${sampleRateHz}`);
  const framesizeField = (opts.frameSizeBytes - 8) / 8;
  if (!Number.isInteger(framesizeField) || framesizeField < 0 || framesizeField > 0x3ff) {
    throw new Error(`buildEa3Header: frameSizeBytes ${opts.frameSizeBytes} does not encode to a valid 10-bit field`);
  }

  const buf = new Uint8Array(EA3_HEADER_SIZE);
  buf[0] = 0x45; // 'E'
  buf[1] = 0x41; // 'A'
  buf[2] = 0x33; // '3'
  buf[4] = 0;
  buf[5] = EA3_HEADER_SIZE;
  buf[6] = 0xff; // encryption id = -1 (unencrypted path in oma_read_header)
  buf[7] = 0xff;

  const codecParams = (srateIdx << 13) | (channelId << 10) | framesizeField;
  buf[32] = 1; // OMA_CODECID_ATRAC3P
  buf[33] = (codecParams >> 16) & 0xff;
  buf[34] = (codecParams >> 8) & 0xff;
  buf[35] = codecParams & 0xff;
  return buf;
}

/** Concatenate a built EA3 header + raw ATRAC3+ ES bytes into one `.oma`-ready buffer. */
export function wrapAtrac3pAsOma(esBytes: Uint8Array, opts: Ea3HeaderOptions): Uint8Array {
  const header = buildEa3Header(opts);
  const out = new Uint8Array(header.length + esBytes.length);
  out.set(header, 0);
  out.set(esBytes, header.length);
  return out;
}
