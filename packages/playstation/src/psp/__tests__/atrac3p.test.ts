import { describe, it, expect } from 'vitest';
import { extractAtrac3pFromPsmf, buildEa3Header, wrapAtrac3pAsOma, EA3_HEADER_SIZE } from '../atrac3p.js';

describe('buildEa3Header', () => {
  it('matches a real, hand-built 96-byte EA3 header that decodes real PSP movie audio via a standard decoder', () => {
    // Real bytes of an EA3 header confirmed to produce a clean, zero-error
    // decode ("Stream #0:0: Audio: atrac3p ..., 44100 Hz, stereo, fltp, 64
    // kb/s") of real disc content, later verified non-degenerate.
    const realHeader = new Uint8Array([
      69, 65, 51, 0, 0, 96, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 40,
      46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const header = buildEa3Header({ frameSizeBytes: 376, channelId: 2, sampleRateHz: 44100 });
    expect(header.length).toBe(EA3_HEADER_SIZE);
    expect(Array.from(header)).toEqual(Array.from(realHeader));
  });

  it('rejects a frameSizeBytes that does not encode to a valid 10-bit field', () => {
    expect(() => buildEa3Header({ frameSizeBytes: 9 })).toThrow();
  });

  it('rejects an unsupported sample rate', () => {
    expect(() => buildEa3Header({ frameSizeBytes: 376, sampleRateHz: 22050 })).toThrow();
  });

  it('wrapAtrac3pAsOma concatenates the header and ES bytes in order', () => {
    const es = new Uint8Array([1, 2, 3, 4]);
    const oma = wrapAtrac3pAsOma(es, { frameSizeBytes: 376 });
    expect(oma.length).toBe(EA3_HEADER_SIZE + 4);
    expect(Array.from(oma.slice(0, 3))).toEqual([0x45, 0x41, 0x33]);
    expect(Array.from(oma.slice(EA3_HEADER_SIZE))).toEqual([1, 2, 3, 4]);
  });
});

describe('extractAtrac3pFromPsmf', () => {
  function buildSyntheticPsmf(slotPayloads: number[][]): Uint8Array {
    const slots: number[] = [];
    for (const payload of slotPayloads) {
      const slotSize = 8 + payload.length;
      const raw = slotSize - 0x10;
      const code1 = (raw >> 8) & 0x03;
      const code2 = (raw & 0xff) / 8;
      if (!Number.isInteger(code2)) throw new Error('test payload length must make code2 an integer');
      slots.push(0x0f, 0xd0, code1, code2, 0, 0, 0, 0, ...payload);
    }
    const pesPayload = [0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...slots];
    const pesPacketLength = pesPayload.length;
    const pesPacket = [0x00, 0x00, 0x01, 0xbd, (pesPacketLength >> 8) & 0xff, pesPacketLength & 0xff, ...pesPayload];
    const packHeader = [0x00, 0x00, 0x01, 0xba, 0x44, 0, 0x04, 0, 0x04, 1, 0, 0, 3, 0];
    return new Uint8Array([...packHeader, ...pesPacket]);
  }

  it('extracts a single 376-byte ATRAC3+ frame, stripping the 8-byte slot header', () => {
    const payload = Array.from({ length: 376 }, (_, i) => i % 256);
    const buf = buildSyntheticPsmf([payload]);
    const result = extractAtrac3pFromPsmf(buf);
    expect(result).not.toBeNull();
    expect(result!.packetCount).toBe(1);
    expect(result!.frameSizeBytes).toBe(376);
    expect(result!.frameCount).toBe(1);
    expect(result!.clean).toBe(true);
    expect(Array.from(result!.esBytes)).toEqual(payload);
  });

  it('extracts multiple frames and concatenates them in order', () => {
    const p1 = Array.from({ length: 376 }, () => 0xaa);
    const p2 = Array.from({ length: 376 }, () => 0xbb);
    const buf = buildSyntheticPsmf([p1, p2]);
    const result = extractAtrac3pFromPsmf(buf);
    expect(result).not.toBeNull();
    expect(result!.frameCount).toBe(2);
    expect(result!.clean).toBe(true);
    expect(result!.esBytes.length).toBe(752);
  });

  it('returns null when no 0xBD packets are present', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x01, 0xba, 0x44, 0, 0x04, 0, 0x04, 1, 0, 0, 3, 0]);
    expect(extractAtrac3pFromPsmf(buf)).toBeNull();
  });

  it('reports clean:false rather than throwing when a slot header claims an implausible size', () => {
    const payload = Array.from({ length: 376 }, () => 0x11);
    const buf = buildSyntheticPsmf([payload]);
    const corrupted = new Uint8Array(buf);
    corrupted[30] = 0xff;
    const result = extractAtrac3pFromPsmf(corrupted);
    expect(result).not.toBeNull();
    expect(result!.clean).toBe(false);
  });
});
