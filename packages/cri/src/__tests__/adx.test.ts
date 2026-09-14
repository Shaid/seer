import { describe, it, expect } from 'vitest';
import { parseAdxHeader, verifyAdxCopyrightTag, computeAdxCoefficients, decodeAdx, interleaveChannels } from '../adx.js';

/**
 * Build a minimal synthetic standard (type-3, unencrypted) mono ADX stream:
 * fixed header, "(c)CRI" copyright tag, one 18-byte block (32 nibbles/32
 * samples/channel capacity) holding just `sampleCount` real samples.
 */
function buildAdx(opts: { sampleRate: number; sampleCount: number; highpassFrequency: number; nibbleBytes: number[]; scale: number }): Uint8Array {
  const copyrightOffset = 0x1a;
  const dataOffset = copyrightOffset + 4;
  const blockSize = 18;
  const total = dataOffset + blockSize;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 0x8000, false); // magic
  view.setUint16(2, copyrightOffset, false);
  buf[4] = 3; // encodingType: standard
  buf[5] = blockSize;
  buf[6] = 4; // bitDepth
  buf[7] = 1; // channelCount (mono)
  view.setUint32(8, opts.sampleRate, false);
  view.setUint32(12, opts.sampleCount, false);
  view.setUint16(16, opts.highpassFrequency, false);
  view.setUint16(18, 0x0300, false); // version: unencrypted
  // "(c)CRI" tag at [copyrightOffset - 2, copyrightOffset + 4)
  const tag = '(c)CRI';
  for (let i = 0; i < tag.length; i++) buf[copyrightOffset - 2 + i] = tag.charCodeAt(i);

  view.setInt16(dataOffset, (opts.scale - 1) | 0, false); // block scale (stored as scale-1)
  buf.set(opts.nibbleBytes, dataOffset + 2);
  return buf;
}

describe('adx', () => {
  it('parses the synthetic header (magic, copyright tag, standard type-3 encoding)', () => {
    const buf = buildAdx({ sampleRate: 8000, sampleCount: 2, highpassFrequency: 500, nibbleBytes: [0xd3], scale: 1 });
    const header = parseAdxHeader(buf);
    expect(header).not.toBeNull();
    expect(header!.encodingType).toBe(3);
    expect(header!.encrypted).toBe(false);
    expect(header!.channelCount).toBe(1);
    expect(header!.sampleRate).toBe(8000);
    expect(header!.sampleCount).toBe(2);
    expect(verifyAdxCopyrightTag(buf, header!)).toBe(true);
  });

  it('computeAdxCoefficients returns a stable integer 2-tap predictor', () => {
    const { coef1, coef2 } = computeAdxCoefficients(500, 8000);
    expect(Number.isInteger(coef1)).toBe(true);
    expect(Number.isInteger(coef2)).toBe(true);
  });

  it('decodes the first sample exactly (history-independent: predicted=0 before any prior sample exists)', () => {
    // nibble 0xd (13) sign-extends to -3; scale=1 -> sample0 = clamp16(-3*1 + 0) = -3.
    const buf = buildAdx({ sampleRate: 8000, sampleCount: 2, highpassFrequency: 500, nibbleBytes: [0xd3], scale: 1 });
    const decoded = decodeAdx(buf);
    expect(decoded.channelCount).toBe(1);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channelData.length).toBe(1);
    expect(decoded.channelData[0]!.length).toBe(2);
    expect(decoded.channelData[0]![0]).toBe(-3);
  });

  it('a stream of all-zero nibbles/scale decodes to genuine silence', () => {
    const buf = buildAdx({ sampleRate: 8000, sampleCount: 8, highpassFrequency: 500, nibbleBytes: new Array(16).fill(0), scale: 1 });
    const decoded = decodeAdx(buf);
    expect(decoded.channelData[0]!.every((s) => s === 0)).toBe(true);
  });

  it('interleaveChannels produces the standard WebAudio frame order', () => {
    const buf = buildAdx({ sampleRate: 8000, sampleCount: 2, highpassFrequency: 500, nibbleBytes: [0xd3], scale: 1 });
    const decoded = decodeAdx(buf);
    const interleaved = interleaveChannels(decoded.channelData, decoded.sampleCount);
    expect(interleaved.length).toBe(decoded.sampleCount * decoded.channelCount);
    expect(interleaved[0]).toBe(decoded.channelData[0]![0]);
    expect(interleaved[1]).toBe(decoded.channelData[0]![1]);
  });

  it('rejects a buffer with the wrong magic', () => {
    const buf = buildAdx({ sampleRate: 8000, sampleCount: 2, highpassFrequency: 500, nibbleBytes: [0xd3], scale: 1 });
    buf[0] = 0;
    expect(parseAdxHeader(buf)).toBeNull();
  });

  it('throws for encrypted (KEYCODE) ADX version markers', () => {
    const buf = buildAdx({ sampleRate: 8000, sampleCount: 2, highpassFrequency: 500, nibbleBytes: [0xd3], scale: 1 });
    new DataView(buf.buffer).setUint16(18, 0x0408, false);
    expect(() => decodeAdx(buf)).toThrow(/Encrypted ADX/);
  });

  it('throws for an unsupported encoding type', () => {
    const buf = buildAdx({ sampleRate: 8000, sampleCount: 2, highpassFrequency: 500, nibbleBytes: [0xd3], scale: 1 });
    buf[4] = 4; // AHX family, not decoded here
    expect(() => decodeAdx(buf)).toThrow(/Unsupported ADX encoding type/);
  });
});
