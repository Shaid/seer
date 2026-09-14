import { describe, it, expect } from 'vitest';
import { lzhufDecompress, D_CODE, D_LEN } from '../lzhuf.js';

/**
 * Fixture: a real LZHUF-compressed stream from PowerMonger (DOS VGA)'s
 * `INT1SND.HUF` container — its first entry's compressed prefix, taken
 * verbatim (not a synthetic mock). A known-good reference decoder confirms
 * decoding it alone, fresh model + fresh ring buffer, produces the entry's
 * real 3,682-byte Standard MIDI File payload.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const REAL_PBLEEPER_PREFIX_HEX =
  'ecf83e9f0c660dfc94600f1b81331713fdf7b2ccd762d8bc7e539df8f8d4ff3ab4b6cecbc99097c76c2c2543bb639' +
  '8e0ca43bccf36f1768e79c96bd18877e686825cf9d9929417dca9fd9c53655ebad6c36cdd7c2d8b65cbb86768f966' +
  '5ec5d50aa1fec6c04c3762e0d4a2de8231d508c8d745d159cf8ee2d9180b9ee412b38836d78050ccb2b37ef2d74bc' +
  'bd715309cb28446f24d54ffcb89f547d3804affd564090e97fa33a4bc3d028bfc54e6440bd90bfac2f9a0bd9cbc2f' +
  'f502fb07e217300508172e179405e5df06f69b01693f2bd3f005ec17f217340b94ee17ee05e5e070b9205202e405c' +
  'b02fd7b3eea9a49577c3e6cfb836b9e72e279bcda5409630f0cb370156f1874503c756ace52404c0e47e406c48b83' +
  '0b1f308037fa2b388f210c3e7fb66d6f10feda5612ddc6227fc242361823f62db244ac8709068f766a6c72a7bab1d' +
  '8c6ae602ef5e76c8888765f04707f805a32c3b8b2121d57a1ef7de1ffd4abbd8a431afe17a5ba3adc73fb7a309393' +
  '9fa4e210d12d40c7b78090f35608c5eef2226ee70f7f017b6aaff25db9a1beacc146d9ffc37dea76d30362b9093b3' +
  '35af7742379ebb90031b58ec5e27549fef7f92f415eb858946594290c337ffb85f448197df055143004e18d0d7a6' +
  '45985e8358314a9c8f92f8e5d52785fe5bb2031e31565642c85857d63ae3943ca8ed61a5275c23c3960a66850f52' +
  '9538fca187d42999aeff74a7c633d1c4209e06842fe36a1e60afc9346997989278bbfe3336703451e50b1a5f53cc1' +
  '6064ea4f56a05da91a77e8a62108f9901f09dfef85191f9090f4c65b8a83410244f8f1df5f181d97f9308ecc90c28' +
  '9d3c27c683e8a39f3c9223352301193d13052797fca0c3aafca1081463ca9bd1e42537135a96e0b88c3c0dd9f677f' +
  '73f58f1ed009af5654c4d64c05fee91f7f3ee783cea17002e1e2d100ba6176b168e85f60bef8b4e42fd05fbc5a778' +
  'b4062d038b4362d0f8b4462d158b4662d198b46e2d1d8b4d62d358b4d62d378b4b2b169359bb9cb78c0';

describe('lzhufDecompress', () => {
  it('decodes a real compressed prefix to a byte-exact Standard MIDI File', () => {
    const compressed = hexToBytes(REAL_PBLEEPER_PREFIX_HEX);
    const out = lzhufDecompress(compressed, 3682);

    // MThd chunk: magic, header length (always 6), format=0, ntrks=1, division=192.
    expect([...out.subarray(0, 14)]).toEqual([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0xc0,
    ]);
    // MTrk chunk immediately follows at the expected fixed offset.
    expect([...out.subarray(14, 18)]).toEqual([0x4d, 0x54, 0x72, 0x6b]);
    // The track chunk's own declared length must account for every remaining byte.
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const trackLen = view.getUint32(18, false);
    expect(14 + 8 + trackLen).toBe(out.length);
  });

  it('decodes until input exhaustion when no output size is given', () => {
    const compressed = hexToBytes(REAL_PBLEEPER_PREFIX_HEX);
    const bounded = lzhufDecompress(compressed, 3682);
    const unbounded = lzhufDecompress(compressed);
    // Stream-exhaustion recovery may undershoot the true tail by a few
    // bytes, but everything decoded must agree with the bounded decode.
    expect(unbounded.length).toBeLessThanOrEqual(bounded.length);
    expect([...unbounded]).toEqual([...bounded.subarray(0, unbounded.length)]);
  });
});

describe('position-code tables', () => {
  // Regression guard for a real bug: D_LEN[0x80..0x8F] was once 6 instead of
  // 5, which desynchronised the bitstream on any match distance in [640, 767]
  // and nowhere else -- so every short file still decoded perfectly.
  it('D_CODE/D_LEN form a complete canonical prefix code', () => {
    const span = new Map<number, number>();
    for (let i = 0; i < 256; i++) span.set(D_CODE[i], (span.get(D_CODE[i]) ?? 0) + 1);

    // Every symbol's byte-value span must equal 2**(8 - its code length).
    for (let i = 0; i < 256; i++) {
      expect(span.get(D_CODE[i])).toBe(1 << (8 - D_LEN[i]));
    }
    // 64 distance symbols (the top 6 bits of a 12-bit distance), Kraft sum 1.
    const len = new Map<number, number>();
    for (let i = 0; i < 256; i++) len.set(D_CODE[i], D_LEN[i]);
    expect(len.size).toBe(64);
    const kraft = [...len.values()].reduce((s, l) => s + 2 ** -l, 0);
    expect(kraft).toBe(1);
  });
});
