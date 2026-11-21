/**
 * CWAV/BCWAV wave decoder (CTR SDK "CWAV" — the sound-effect/voice waves held
 * in a CWAR wave archive inside a BCSAR, and also shipped standalone as
 * `.bcwav`). Decodes DSP-ADPCM, PCM8, PCM16 and IMA-ADPCM to PCM16 per
 * channel; BCSTM streams share the same codec set (see `bcstm.ts`).
 *
 * Layout (little-endian; every "ref" is `u16 type, u16 pad, u32 offset`):
 *   0x00 "CWAV"  0x04 u16 BOM 0xFEFF  0x06 u16 headerSize 0x40  0x08 u32 version
 *   0x0c u32 fileSize  0x10 u16 blockCount (2)  0x12 u16 pad
 *   0x14 ref 0x7000 INFO  (u32 offset, u32 size at +4/+8 of the 12-byte entry)
 *   0x20 ref 0x7001 DATA
 *   INFO: "INFO" u32 size, then
 *     +0x08 u8 codec (0 PCM8, 1 PCM16, 2 DSP-ADPCM, 3 IMA-ADPCM)  +0x09 u8 loop
 *     +0x0c u32 sampleRate  +0x10 u32 loopStart  +0x14 u32 totalSamples (loop end)
 *     +0x1c u32 channelCount, then channelCount x ref 0x7100 -> ChannelInfo
 *        (offsets relative to the count word at INFO+0x1c)
 *   ChannelInfo: ref 0x1f00 sample data (offset relative to DATA+8),
 *     ref adpcm info (0x0300 DSP / 0x0301 IMA, offset relative to the
 *     ChannelInfo start; 0 for PCM), u32 reserved.
 *   DspAdpcmInfo (0x2e B): s16 coef[16], u16 ps, s16 yn1, yn2, u16 loopPs, s16 loopYn1, loopYn2.
 *   ImaAdpcmInfo: s16 data, u8 tableIndex, u8 pad (then the same for the loop).
 *   Channels are stored one after another (not interleaved); DSP frames are
 *   8 B = 1 header byte (coef index << 4 | scale exponent) + 14 nibbles.
 */
import { u16At, u32At } from './le.js';

export type CwavCodec = 'pcm8' | 'pcm16' | 'dsp-adpcm' | 'ima-adpcm';

export interface CwavChannel {
  /** Byte offset of this channel's samples, relative to the DATA block payload (DATA+8). */
  dataOffset: number;
  /** DSP-ADPCM coefficients (8 pairs), or empty. */
  coefs: number[];
  /** Initial history (DSP: yn1/yn2; IMA: step index in `ps`, predictor in `yn1`). */
  ps: number;
  yn1: number;
  yn2: number;
}

export interface CwavInfo {
  codec: CwavCodec;
  codecId: number;
  loopFlag: boolean;
  sampleRate: number;
  loopStartSample: number;
  totalSamples: number;
  channels: CwavChannel[];
  /** Absolute offset of the DATA block payload (DATA+8). */
  dataStart: number;
  fileSize: number;
}

const CODECS: Record<number, CwavCodec> = { 0: 'pcm8', 1: 'pcm16', 2: 'dsp-adpcm', 3: 'ima-adpcm' };

const s16At = (d: Uint8Array, o: number): number => (u16At(d, o) << 16) >> 16;

/** True when `d` starts with the `CWAV` magic and a plausible size. */
export function isCwav(d: Uint8Array): boolean {
  return d.length >= 0x40 && u32At(d, 0) === 0x56415743 && u16At(d, 4) === 0xfeff;
}

/** Parse a CWAV header. Throws on a malformed file. */
export function parseCwav(d: Uint8Array): CwavInfo {
  if (!isCwav(d)) throw new Error('Not a CWAV');
  const n = u16At(d, 0x10);
  let info = -1;
  let data = -1;
  for (let i = 0; i < Math.min(n, 4); i++) {
    const t = u16At(d, 0x14 + 12 * i);
    if (t === 0x7000) info = u32At(d, 0x14 + 12 * i + 4);
    else if (t === 0x7001) data = u32At(d, 0x14 + 12 * i + 4);
  }
  if (info < 0 || data < 0 || info + 0x20 > d.length || data + 8 > d.length) throw new Error('CWAV: missing INFO/DATA');
  if (u32At(d, info) !== 0x4f464e49) throw new Error('CWAV: bad INFO magic');
  const codecId = d[info + 8]!;
  const codec = CODECS[codecId];
  if (!codec) throw new Error(`CWAV: unknown codec ${codecId}`);
  const tbl = info + 0x1c;
  const count = u32At(d, tbl);
  if (count < 1 || count > 16) throw new Error(`CWAV: bad channel count ${count}`);
  const channels: CwavChannel[] = [];
  for (let c = 0; c < count; c++) {
    const rp = tbl + 4 + 8 * c;
    if (u16At(d, rp) !== 0x7100) throw new Error('CWAV: bad channel ref');
    const ci = tbl + u32At(d, rp + 4);
    if (ci + 0x14 > d.length) throw new Error('CWAV: channel info out of range');
    const dataOffset = u32At(d, ci + 4);
    const adType = u16At(d, ci + 8);
    const adOff = u32At(d, ci + 12);
    const ch: CwavChannel = { dataOffset, coefs: [], ps: 0, yn1: 0, yn2: 0 };
    if (codec === 'dsp-adpcm') {
      if (adType !== 0x0300) throw new Error(`CWAV: DSP channel without 0x0300 info (${adType})`);
      const a = ci + adOff;
      for (let k = 0; k < 16; k++) ch.coefs.push(s16At(d, a + 2 * k));
      ch.ps = u16At(d, a + 32);
      ch.yn1 = s16At(d, a + 34);
      ch.yn2 = s16At(d, a + 36);
    } else if (codec === 'ima-adpcm') {
      if (adType !== 0x0301) throw new Error(`CWAV: IMA channel without 0x0301 info (${adType})`);
      const a = ci + adOff;
      ch.yn1 = s16At(d, a);
      ch.ps = d[a + 2]!;
    }
    channels.push(ch);
  }
  return {
    codec,
    codecId,
    loopFlag: d[info + 9] !== 0,
    sampleRate: u32At(d, info + 0xc),
    loopStartSample: u32At(d, info + 0x10),
    totalSamples: u32At(d, info + 0x14),
    channels,
    dataStart: data + 8,
    fileSize: u32At(d, 0xc),
  };
}

const clamp16 = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * Decode DSP-ADPCM (the GameCube/Wii/3DS "DSPADPCM") nibbles. `coefs` is 8
 * (c1,c2) pairs; frames are 8 bytes / 14 samples; history starts at yn1/yn2.
 */
export function decodeDspAdpcm(
  src: Uint8Array,
  start: number,
  sampleCount: number,
  coefs: ArrayLike<number>,
  yn1 = 0,
  yn2 = 0,
): Int16Array {
  const out = new Int16Array(sampleCount);
  let h1 = yn1;
  let h2 = yn2;
  let o = 0;
  for (let f = start; o < sampleCount; f += 8) {
    const hdr = src[f]!;
    const scale = 1 << (hdr & 0xf);
    const idx = (hdr >> 4) & 7;
    const c1 = coefs[idx * 2]!;
    const c2 = coefs[idx * 2 + 1]!;
    for (let k = 0; k < 14 && o < sampleCount; k++) {
      const b = src[f + 1 + (k >> 1)]!;
      let nib = k & 1 ? b & 0xf : b >> 4;
      if (nib >= 8) nib -= 16;
      const s = clamp16((((nib * scale) << 11) + 1024 + c1 * h1 + c2 * h2) >> 11);
      out[o++] = s;
      h2 = h1;
      h1 = s;
    }
  }
  return out;
}

const IMA_STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166,
  1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
  8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

/** Nintendo IMA-ADPCM (4 bit, low nibble first, no per-frame header; state comes from the channel info). */
export function decodeImaAdpcm(src: Uint8Array, start: number, sampleCount: number, predictor = 0, stepIndex = 0): Int16Array {
  const out = new Int16Array(sampleCount);
  let p = predictor;
  let si = stepIndex;
  for (let i = 0; i < sampleCount; i++) {
    const b = src[start + (i >> 1)]!;
    const nib = i & 1 ? b >> 4 : b & 0xf;
    const step = IMA_STEP[si]!;
    let diff = step >> 3;
    if (nib & 1) diff += step >> 2;
    if (nib & 2) diff += step >> 1;
    if (nib & 4) diff += step;
    p = clamp16(nib & 8 ? p - diff : p + diff);
    si = Math.max(0, Math.min(88, si + IMA_INDEX[nib & 7]!));
    out[i] = p;
  }
  return out;
}

/** Decode every channel of a CWAV to PCM16. */
export function decodeCwav(d: Uint8Array, info: CwavInfo = parseCwav(d)): Int16Array[] {
  const n = info.totalSamples;
  return info.channels.map((ch) => {
    const at = info.dataStart + ch.dataOffset;
    switch (info.codec) {
      case 'dsp-adpcm':
        return decodeDspAdpcm(d, at, n, ch.coefs, ch.yn1, ch.yn2);
      case 'ima-adpcm':
        return decodeImaAdpcm(d, at, n, ch.yn1, ch.ps);
      case 'pcm16': {
        const o = new Int16Array(n);
        for (let i = 0; i < n; i++) o[i] = s16At(d, at + 2 * i);
        return o;
      }
      case 'pcm8': {
        const o = new Int16Array(n);
        for (let i = 0; i < n; i++) o[i] = ((d[at + i]! << 24) >> 24) << 8;
        return o;
      }
    }
  });
}

/** Interleave per-channel PCM16 into a RIFF/WAVE (PCM16) file. */
export function pcm16ChannelsToWav(channels: Int16Array[], sampleRate: number): Uint8Array {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = frames * nch * 2;
  const out = new Uint8Array(44 + bytes);
  const dv = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + bytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * 2, true);
  dv.setUint16(32, nch * 2, true);
  dv.setUint16(34, 16, true);
  tag(36, 'data');
  dv.setUint32(40, bytes, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      dv.setInt16(p, channels[c]![i]!, true);
      p += 2;
    }
  }
  return out;
}
