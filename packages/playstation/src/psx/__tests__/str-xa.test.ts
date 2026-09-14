import { describe, it, expect } from 'vitest';
import { SUBMODE_AUDIO, SUBMODE_DATA, SUBMODE_FORM2, SUBMODE_VIDEO } from '../../cd/sector.js';
import {
  parseStrVideoHeader,
  strMagicCoverage,
  wrapAsCdxa,
  classifySubheaderStream,
  extractXaChannel,
  STR_MAGIC,
} from '../str-xa.js';

describe('parseStrVideoHeader', () => {
  it('parses a real sector-0 header (a version-2, 320x112 clip)', () => {
    // Byte-exact real header captured from a real STR video stream.
    const hex = '6001018000000a0001000000f804000040017000600300380100020000000000';
    const buf = Uint8Array.from(Buffer.from(hex, 'hex'));
    const h = parseStrVideoHeader(buf, 0)!;
    expect(h).not.toBeNull();
    expect(h.chunkNumber).toBe(0);
    expect(h.chunksInFrame).toBe(10);
    expect(h.frameNumber).toBe(1);
    expect(h.demuxedSize).toBe(1272);
    expect(h.width).toBe(320);
    expect(h.height).toBe(112);
    expect(h.quantScale).toBe(1);
    expect(h.version).toBe(2);
  });

  it('returns null when the magic does not match', () => {
    expect(parseStrVideoHeader(new Uint8Array(32), 0)).toBeNull();
  });

  it('returns null when the buffer is shorter than the header', () => {
    expect(parseStrVideoHeader(new Uint8Array(10), 0)).toBeNull();
  });
});

describe('strMagicCoverage (video-only, 2048-byte stride, no subheader)', () => {
  it('returns 1.0 when every sector starts with the STR magic', () => {
    const sector = new Uint8Array(2048);
    new DataView(sector.buffer).setUint32(0, STR_MAGIC, true);
    const buf = new Uint8Array(2048 * 3);
    buf.set(sector, 0);
    buf.set(sector, 2048);
    buf.set(sector, 4096);
    expect(strMagicCoverage(buf, 2048, 0)).toBe(1);
  });

  it('returns a fraction less than 1.0 when some sectors do not match', () => {
    const sector = new Uint8Array(2048);
    new DataView(sector.buffer).setUint32(0, STR_MAGIC, true);
    const buf = new Uint8Array(2048 * 4);
    buf.set(sector, 0);
    buf.set(sector, 2048);
    expect(strMagicCoverage(buf, 2048, 0)).toBe(0.5);
  });

  it('returns 0 for an empty buffer', () => {
    expect(strMagicCoverage(new Uint8Array(0), 2048, 0)).toBe(0);
  });
});

describe('wrapAsCdxa: synthesized-subheader (video-only, 2048-byte stride)', () => {
  it('produces one 2352-byte raw sector per 2048-byte logical sector', () => {
    const logical = new Uint8Array(2048 * 3);
    const raw = wrapAsCdxa(logical, 2048, { subheader: { fileNumber: 0, channel: 0, submode: SUBMODE_VIDEO, codingInfo: 0 } });
    expect(raw.length).toBe(2352 * 3);
  });

  it('places the CD sync pattern and a video-type CD-XA submode at the documented offsets', () => {
    const logical = new Uint8Array(2048);
    const raw = wrapAsCdxa(logical, 2048, { subheader: { fileNumber: 0, channel: 0, submode: SUBMODE_VIDEO, codingInfo: 0 } });
    expect(raw[0]).toBe(0x00);
    for (let i = 1; i <= 10; i++) expect(raw[i]).toBe(0xff);
    expect(raw[11]).toBe(0x00);
    // A standard demuxer's psxstr probe requires (sector[0x12] & 0x0E) === 0x02 (CDXA_TYPE_VIDEO).
    expect(raw[0x12] & 0x0e).toBe(0x02);
    expect(raw[0x11]).toBeLessThan(32);
  });

  it('copies the real logical sector bytes starting at offset 24 of each raw sector', () => {
    const logical = new Uint8Array(2048);
    logical.set([0x60, 0x01, 0x01, 0x80], 0); // STR magic
    const raw = wrapAsCdxa(logical, 2048, { subheader: { fileNumber: 0, channel: 0, submode: SUBMODE_VIDEO, codingInfo: 0 } });
    expect(Array.from(raw.subarray(24, 28))).toEqual([0x60, 0x01, 0x01, 0x80]);
  });
});

describe('wrapAsCdxa: real-subheader passthrough (subheader-preserved, 2336-byte stride)', () => {
  function buildRaw2336Sector(submode: number, userDataFill = 0): Uint8Array {
    const sector = new Uint8Array(2336);
    sector[0] = 0; // fileNumber
    sector[1] = 1; // channel
    sector[2] = submode;
    sector[3] = 0; // codingInfo
    sector.set(sector.subarray(0, 4), 4); // duplicate
    sector.fill(userDataFill, 8);
    return sector;
  }

  it('copies each real subheader through unchanged rather than forcing one', () => {
    const sectors = new Uint8Array(2336 * 2);
    sectors.set(buildRaw2336Sector(SUBMODE_DATA, 0x11), 0);
    sectors.set(buildRaw2336Sector(SUBMODE_AUDIO | SUBMODE_FORM2, 0x22), 2336);
    const raw = wrapAsCdxa(sectors, 2336);
    expect(raw.length).toBe(2352 * 2);
    expect(raw[16 + 2]).toBe(SUBMODE_DATA); // submode byte of sector 0's subheader
    expect(raw[2352 + 16 + 2]).toBe(SUBMODE_AUDIO | SUBMODE_FORM2);
    expect(raw[16 + 8]).toBe(0x11); // first byte of sector 0's user data
  });
});

describe('classifySubheaderStream', () => {
  function buildVideoSector(frameNumber: number): Uint8Array {
    const sector = new Uint8Array(2336);
    sector[2] = SUBMODE_DATA;
    const dv = new DataView(sector.buffer);
    dv.setUint32(8, STR_MAGIC, true);
    dv.setUint32(16, frameNumber, true); // frameNumber field
    dv.setUint16(24, 320, true); // width
    dv.setUint16(26, 112, true); // height
    dv.setUint16(34, 2, true); // version
    return sector;
  }
  function buildAudioSector(): Uint8Array {
    const sector = new Uint8Array(2336);
    sector[2] = SUBMODE_AUDIO | SUBMODE_FORM2;
    return sector;
  }
  function buildFillerSector(): Uint8Array {
    return new Uint8Array(2336); // submode 0
  }

  it('counts video/audio/filler sectors and reports frame geometry', () => {
    const stream = new Uint8Array(2336 * 4);
    stream.set(buildVideoSector(0), 0);
    stream.set(buildVideoSector(1), 2336);
    stream.set(buildAudioSector(), 2336 * 2);
    stream.set(buildFillerSector(), 2336 * 3);
    const stats = classifySubheaderStream(stream, 2336);
    expect(stats.sectors).toBe(4);
    expect(stats.videoSectors).toBe(2);
    expect(stats.realAudioSectors).toBe(1);
    expect(stats.fillerSectors).toBe(1);
    expect(stats.frameCount).toBe(2);
    expect(stats.width).toBe(320);
    expect(stats.height).toBe(112);
    expect(stats.hasAudio).toBe(true);
  });

  it('reports hasAudio: false when no real audio sectors are present', () => {
    const stream = new Uint8Array(2336 * 2);
    stream.set(buildVideoSector(0), 0);
    stream.set(buildFillerSector(), 2336);
    expect(classifySubheaderStream(stream, 2336).hasAudio).toBe(false);
  });
});

describe('extractXaChannel', () => {
  it('extracts only real-audio sectors matching the requested channel', () => {
    const stream = new Uint8Array(2336 * 3);
    const mk = (channel: number, submode: number, fill: number) => {
      const s = new Uint8Array(2336);
      s[1] = channel;
      s[2] = submode;
      s.fill(fill, 8);
      return s;
    };
    stream.set(mk(0, SUBMODE_AUDIO | SUBMODE_FORM2, 0xaa), 0);
    stream.set(mk(1, SUBMODE_AUDIO | SUBMODE_FORM2, 0xbb), 2336);
    stream.set(mk(0, SUBMODE_AUDIO | SUBMODE_FORM2, 0xcc), 2336 * 2);
    const extracted = extractXaChannel(stream, 2336, 0);
    expect(extracted.length).toBe(2336 * 2);
    expect(extracted[8]).toBe(0xaa);
    expect(extracted[2336 + 8]).toBe(0xcc);
  });

  it('skips non-audio and wrong-channel sectors', () => {
    const stream = new Uint8Array(2336 * 2);
    const video = new Uint8Array(2336);
    video[2] = SUBMODE_DATA;
    stream.set(video, 0);
    const audioCh1 = new Uint8Array(2336);
    audioCh1[1] = 1;
    audioCh1[2] = SUBMODE_AUDIO | SUBMODE_FORM2;
    stream.set(audioCh1, 2336);
    expect(extractXaChannel(stream, 2336, 0).length).toBe(0);
  });
});
