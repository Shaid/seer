import { describe, expect, it } from 'vitest';
import { parseBcstmInfo } from '../bcstm.js';

function u16le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}
function u32le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
}

/**
 * Build a minimal CSTM buffer with one INFO section holding a StreamInfo.
 * Mirrors the real layout verified against an actual Fire Emblem: Awakening
 * `.bcstm` — not just what the parser expects.
 */
function makeCstm(opts: {
  codec: number;
  loopFlag: number;
  channelCount: number;
  sampleRate: number;
  loopStart: number;
  totalSamples: number;
}): Uint8Array {
  const headerSize = 0x14 + 12; // header + one section reference
  const infoOffset = headerSize;
  const streamInfoRelOffset = 8; // StreamInfo ref points 8 bytes past its own field
  const streamInfoOffset = infoOffset + 8 + streamInfoRelOffset;
  const infoSize = 8 + streamInfoRelOffset + 16;
  const fileSize = infoOffset + infoSize;

  const buf = new Uint8Array(fileSize);
  buf.set(u32le(0x4d545343), 0); // "CSTM"
  buf.set(u16le(0xfeff), 4); // BOM
  buf.set(u16le(headerSize), 6);
  buf.set(u32le(2), 8); // version (opaque)
  buf.set(u32le(fileSize), 0xc);
  buf.set(u16le(1), 0x10); // one section
  buf.set(u16le(0), 0x12); // reserved

  // Section reference for INFO.
  buf.set(u16le(0x4000), 0x14);
  buf.set(u16le(0), 0x16);
  buf.set(u32le(infoOffset), 0x18);
  buf.set(u32le(infoSize), 0x1c);

  buf.set(u32le(0x4f464e49), infoOffset); // "INFO"
  buf.set(u32le(infoSize), infoOffset + 4);
  // StreamInfo ref (type u16 + pad u16 + relative offset u32).
  buf.set(u16le(0x4100), infoOffset + 8);
  buf.set(u32le(streamInfoRelOffset), infoOffset + 8 + 4);

  buf[streamInfoOffset] = opts.codec;
  buf[streamInfoOffset + 1] = opts.loopFlag;
  buf[streamInfoOffset + 2] = opts.channelCount;
  buf.set(u32le(opts.sampleRate), streamInfoOffset + 4);
  buf.set(u32le(opts.loopStart), streamInfoOffset + 8);
  buf.set(u32le(opts.totalSamples), streamInfoOffset + 12);

  return buf;
}

describe('BCSTM header', () => {
  it('parses codec, sample rate, channel count and loop points', () => {
    const buf = makeCstm({
      codec: 2,
      loopFlag: 1,
      channelCount: 2,
      sampleRate: 32728,
      loopStart: 43008,
      totalSamples: 525406,
    });
    const info = parseBcstmInfo(buf);
    expect(info.codec).toBe('dsp-adpcm');
    expect(info.channelCount).toBe(2);
    expect(info.sampleRate).toBe(32728);
    expect(info.loopFlag).toBe(true);
    expect(info.loopStartSample).toBe(43008);
    expect(info.totalSamples).toBe(525406);
    expect(info.durationSeconds).toBeCloseTo(525406 / 32728, 5);
  });

  it('maps every known codec id', () => {
    for (const [id, name] of [
      [0, 'pcm8'],
      [1, 'pcm16'],
      [2, 'dsp-adpcm'],
      [3, 'ima-adpcm'],
    ] as const) {
      const buf = makeCstm({
        codec: id,
        loopFlag: 0,
        channelCount: 1,
        sampleRate: 22050,
        loopStart: 0,
        totalSamples: 100,
      });
      expect(parseBcstmInfo(buf).codec).toBe(name);
    }
  });

  it('throws on a non-CSTM buffer', () => {
    expect(() => parseBcstmInfo(new Uint8Array([1, 2, 3, 4]))).toThrow(/BCSTM|BFSTM/);
  });

  it('throws on an unknown codec id', () => {
    const buf = makeCstm({
      codec: 99,
      loopFlag: 0,
      channelCount: 1,
      sampleRate: 22050,
      loopStart: 0,
      totalSamples: 100,
    });
    expect(() => parseBcstmInfo(buf)).toThrow(/unknown codec/);
  });
});

describe('parseBcstmInfo TrackInfo', () => {
  // First 0x100 bytes (header + INFO up to both track byte-tables) of a real
  // FE Awakening 4-channel BGM: two tracks, (vol 115, ch 0+1) and (vol 127, ch 2+3).
  const real = Buffer.from(
    [
      '4353544dfffe400000000002c0d8c000030000000040000040000000a0010000',
      '01400000e00100004018000002400000201a0000a0bec0000000000000000000',
      '494e464fa0010000004100001800000001010000500000000101000064000000',
      '02010400d87f000000c00100d25254008201000000200000003800009d0f0000',
      'd21a0000a00f00000400000000380000001f0000180000000200000001410000',
      '38000000014100004c00000004000000024100004c0000000241000054000000',
      '024100005c000000024100006400000073400000000100000c00000002000000',
      '000100007f400000000100000c00000002000000020300000003000020000000'
    ].join(''),
    'hex',
  );
  it('reads two stereo tracks', () => {
    const info = parseBcstmInfo(new Uint8Array(real));
    expect(info.channelCount).toBe(4);
    expect(info.tracks).toEqual([
      { volume: 115, pan: 64, channels: [0, 1] },
      { volume: 127, pan: 64, channels: [2, 3] },
    ]);
  });
  it('null control: a file with no TrackInfo ref yields no tracks', () => {
    const bytes = new Uint8Array(real);
    // Blank the TrackInfo ref (type + offset) at INFO+0x10 = 0x50.
    bytes.fill(0, 0x50, 0x58);
    expect(parseBcstmInfo(bytes).tracks).toEqual([]);
  });
});
