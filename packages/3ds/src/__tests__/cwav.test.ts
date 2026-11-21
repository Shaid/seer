import { describe, expect, it } from 'vitest';
import { decodeCwav, decodeDspAdpcm, decodeImaAdpcm, isCwav, parseCwav, pcm16ChannelsToWav } from '../cwav.js';

function w32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
  b[o + 2] = (v >> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function w16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
}

interface Chan {
  data: number[];
  /** DSP: 16 coefs + ps,yn1,yn2; IMA: [predictor, stepIndex]. */
  adpcm?: number[];
}

/** Hand-assembled CWAV matching the real layout (INFO at 0x40, DATA after it, channel infos after the ref table). */
function makeCwav(codecId: number, sampleRate: number, totalSamples: number, chans: Chan[]): Uint8Array {
  const nch = chans.length;
  const adpcmSize = codecId === 2 ? 0x2e : codecId === 3 ? 8 : 0;
  const chInfoSize = 0x14 + adpcmSize + (adpcmSize ? 2 : 0);
  const infoSize = 0x20 + 8 * (nch - 1) + nch * chInfoSize;
  const infoAligned = (infoSize + 0x1f) & ~0x1f;
  const dataStart = 0x40 + infoAligned;
  // sample data: each channel padded to 4
  const offs: number[] = [];
  let cur = 0x18; // payload starts 0x18 past DATA+8 in real files; keep the quirk
  for (const c of chans) {
    offs.push(cur);
    cur += (c.data.length + 3) & ~3;
  }
  const dataSize = 8 + cur;
  const out = new Uint8Array(dataStart + dataSize);
  out.set([0x43, 0x57, 0x41, 0x56]);
  w16(out, 4, 0xfeff);
  w16(out, 6, 0x40);
  w32(out, 8, 0x02010000);
  w32(out, 0xc, out.length);
  w16(out, 0x10, 2);
  w16(out, 0x14, 0x7000);
  w32(out, 0x18, 0x40);
  w32(out, 0x1c, infoAligned);
  w16(out, 0x20, 0x7001);
  w32(out, 0x24, dataStart);
  w32(out, 0x28, dataSize);
  out.set([0x49, 0x4e, 0x46, 0x4f], 0x40);
  w32(out, 0x44, infoAligned);
  out[0x48] = codecId;
  w32(out, 0x4c, sampleRate);
  w32(out, 0x54, totalSamples);
  const tbl = 0x40 + 0x1c;
  w32(out, tbl, nch);
  let ci = tbl + 4 + 8 * nch;
  for (let c = 0; c < nch; c++) {
    w16(out, tbl + 4 + 8 * c, 0x7100);
    w32(out, tbl + 4 + 8 * c + 4, ci - tbl);
    w16(out, ci, 0x1f00);
    w32(out, ci + 4, offs[c]!);
    if (adpcmSize) {
      w16(out, ci + 8, codecId === 2 ? 0x0300 : 0x0301);
      w32(out, ci + 12, 0x14);
      const a = ci + 0x14;
      const ad = chans[c]!.adpcm!;
      if (codecId === 2) {
        for (let k = 0; k < 16; k++) w16(out, a + 2 * k, ad[k]!);
        w16(out, a + 32, ad[16]!);
        w16(out, a + 34, ad[17]!);
        w16(out, a + 36, ad[18]!);
      } else {
        w16(out, a, ad[0]!);
        out[a + 2] = ad[1]!;
      }
    }
    ci += chInfoSize;
  }
  out.set([0x44, 0x41, 0x54, 0x41], dataStart);
  w32(out, dataStart + 4, dataSize);
  chans.forEach((c, i) => out.set(c.data, dataStart + 8 + offs[i]!));
  return out;
}

describe('cwav', () => {
  // coefs all zero: sample = (nibble * scale) with no prediction
  const zeroCoefs = [...new Array(16).fill(0), 0, 0, 0];
  // frame: header scale exp 2 (x4), coef idx 0; nibbles 1,2,-1,-2,7,-8,0,3,...
  const frame = [0x02, 0x12, 0xff - 0x0 + 0, 0x7 << 4 | 0x8, 0x03, 0x00, 0x00, 0x00];
  // nibbles: 1,2 | f,f(-1,-1) | 7,8(-8) | 0,3 | 0,0 | 0,0 | 0,0
  const expect14 = [1, 2, -1, -1, 7, -8, 0, 3, 0, 0, 0, 0, 0, 0].map((n) => n * 4);

  it('decodes DSP-ADPCM nibbles (zero predictor) exactly and honours frame order', () => {
    const out = decodeDspAdpcm(new Uint8Array(frame), 0, 14, zeroCoefs);
    expect([...out]).toEqual(expect14);
  });

  it('applies the 2-tap predictor with the stored history (null: wrong coefs diverge)', () => {
    // idx 0 coefs (2048, 0) = identity predictor: s[n] = nib*scale + s[n-1]
    const coefs = [2048, 0, ...new Array(14).fill(0)];
    const src = new Uint8Array([0x00, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11]);
    const good = decodeDspAdpcm(src, 0, 14, coefs, 100, 0);
    expect([...good]).toEqual(Array.from({ length: 14 }, (_, i) => 101 + i));
    const bad = decodeDspAdpcm(src, 0, 14, [0, 0, ...new Array(14).fill(0)], 100, 0);
    expect([...bad]).not.toEqual([...good]);
  });

  it('round-trips a stereo DSP CWAV and keeps channels independent', () => {
    const l = new Uint8Array(frame);
    const r = new Uint8Array([0x00, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77]);
    const w = makeCwav(2, 32728, 14, [
      { data: [...l], adpcm: zeroCoefs },
      { data: [...r], adpcm: zeroCoefs },
    ]);
    expect(isCwav(w)).toBe(true);
    const info = parseCwav(w);
    expect(info.codec).toBe('dsp-adpcm');
    expect(info.sampleRate).toBe(32728);
    expect(info.channels).toHaveLength(2);
    const pcm = decodeCwav(w, info);
    expect([...pcm[0]!]).toEqual(expect14);
    expect([...pcm[1]!]).toEqual(new Array(14).fill(7));
  });

  it('decodes PCM16 and PCM8', () => {
    const s16 = [0, 1, -1, 32767, -32768, 1234];
    const bytes: number[] = [];
    for (const v of s16) bytes.push(v & 0xff, (v >> 8) & 0xff);
    const w16c = makeCwav(1, 22050, s16.length, [{ data: bytes }]);
    expect([...decodeCwav(w16c)[0]!]).toEqual(s16);
    const s8 = [0, 1, 127, 0x80, 0xff];
    const w8c = makeCwav(0, 22050, s8.length, [{ data: s8 }]);
    expect([...decodeCwav(w8c)[0]!]).toEqual([0, 256, 127 * 256, -128 * 256, -256]);
  });

  it('decodes IMA-ADPCM with the stored predictor/step state', () => {
    // nibble 0x7 at step 7: diff = 0+1+3+7 = 11 -> +11, index +8
    const out = decodeImaAdpcm(new Uint8Array([0x77]), 0, 2, 0, 0);
    expect(out[0]).toBe(11);
    expect(out[1]).toBeGreaterThan(out[0]!);
    const cw = makeCwav(3, 16000, 2, [{ data: [0x77], adpcm: [0, 0] }]);
    expect([...decodeCwav(cw)[0]!]).toEqual([...out]);
    expect([...decodeImaAdpcm(new Uint8Array([0x77]), 0, 2, 500, 0)]).not.toEqual([...out]);
  });

  it('rejects non-CWAV data and writes a RIFF wav', () => {
    expect(() => parseCwav(new Uint8Array(0x80))).toThrow();
    const wav = pcm16ChannelsToWav([Int16Array.of(1, 2), Int16Array.of(3, 4)], 8000);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(wav.buffer).getInt16(44 + 2, true)).toBe(3);
    expect(wav.length).toBe(44 + 8);
  });
});
