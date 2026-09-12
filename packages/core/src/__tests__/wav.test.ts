import { describe, it, expect } from 'vitest';
import { encodeWav, int16FromFloat32, int16FromSigned8 } from '../wav.js';

function u32le(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset).getUint32(off, true);
}

function u16le(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset).getUint16(off, true);
}

function i16le(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset).getInt16(off, true);
}

describe('encodeWav', () => {
  it('writes mono 8-bit unsigned PCM byte-for-byte with no scaling', () => {
    const buf = encodeWav([new Uint8Array([0, 128, 255])], { sampleRate: 8000, bits: 8 });

    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(buf.subarray(8, 12))).toBe('WAVE');
    expect(u16le(buf, 22)).toBe(1); // numChannels
    expect(u32le(buf, 24)).toBe(8000); // sampleRate
    expect(u16le(buf, 34)).toBe(8); // bitsPerSample
    expect(u32le(buf, 40)).toBe(3); // dataSize
    expect(Array.from(buf.subarray(44, 47))).toEqual([0, 128, 255]);
  });

  it('writes interleaved stereo 16-bit signed PCM', () => {
    const left = new Int16Array([0, 32767, -32768]);
    const right = new Int16Array([0, -32768, 32767]);
    const buf = encodeWav([left, right], { sampleRate: 44100 });

    expect(u16le(buf, 22)).toBe(2); // numChannels
    expect(u16le(buf, 34)).toBe(16); // bitsPerSample
    expect(u32le(buf, 40)).toBe(3 * 2 * 2); // 3 samples x 2 channels x 2 bytes

    const dataOff = 44;
    expect(i16le(buf, dataOff + 0)).toBe(0); // L[0]
    expect(i16le(buf, dataOff + 2)).toBe(0); // R[0]
    expect(i16le(buf, dataOff + 4)).toBe(32767); // L[1]
    expect(i16le(buf, dataOff + 6)).toBe(-32768); // R[1]
  });
});

describe('int16FromFloat32', () => {
  it('quantizes and clamps normalized float samples', () => {
    const out = int16FromFloat32(new Float32Array([0, 1, -1, 2, -2]));
    expect(Array.from(out)).toEqual([0, 32767, -32767, 32767, -32767]);
  });
});

describe('int16FromSigned8', () => {
  it('sign-extends signed 8-bit PCM to 16-bit by scaling x256', () => {
    const out = int16FromSigned8(new Uint8Array([0, 1, 127, 128, 255]));
    expect(Array.from(out)).toEqual([0, 256, 127 * 256, -128 * 256, -1 * 256]);
  });
});
