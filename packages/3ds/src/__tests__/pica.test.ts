import { describe, expect, it } from 'vitest';
import {
  PicaRegisterFile,
  decodeAlphaTest,
  decodeBlendFunc,
  decodeLightingLutInputs,
  decodeLightingLutWords,
  decodeTevStage,
  describeTevStage,
  isValidTevStage,
  readPicaWrites,
  sampleLightingLut,
} from '../pica.js';
import { float24 } from '../shbin.js';

describe('PICA command stream', () => {
  it('expands a consecutive block, honours padding and the byte-enable mask', () => {
    // TEV stage 0 of a Fates body material: data C0, header (consecutive, 4 extra, mask f), C1..C4; then a lone write with mask 2.
    const words = [0x0e5e0e54, 0x804f00c0, 0x00002200, 0x00040004, 0xf8ffffff, 0, 0x00000100, 0x000200e0];
    const writes = readPicaWrites(words);
    expect(writes.map((w) => w.reg)).toEqual([0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xe0]);
    expect(writes[5]!.mask).toBe(2);
  });

  it('pads an odd-extra block (a LUT: 1 + 255 data words) to an even length', () => {
    const lut = [5, 0x0fff01c8, ...new Array(255).fill(7), 0 /* pad */, 1, 0x000f023d];
    const writes = readPicaWrites(lut);
    expect(writes.filter((w) => w.reg === 0x1c8).length).toBe(256);
    expect(writes.at(-1)).toEqual({ reg: 0x23d, value: 1, mask: 0xf });
  });

  it('a rewritten register is replaced, not OR-merged (the position-scale bug: 0x3c010204 | 0x396b17b6 = 0x3d6b17b6, 256x too large)', () => {
    const regs = new PicaRegisterFile().apply([
      { reg: 0x2c1, value: 0x3c010204, mask: 0xf },
      { reg: 0x2c1, value: 0x396b17b6, mask: 0xf },
    ]);
    expect(regs.get(0x2c1)).toBe(0x396b17b6);
    const partial = new PicaRegisterFile().apply([{ reg: 0xe0, value: 0xffffffff, mask: 0xf }, { reg: 0xe0, value: 0x0, mask: 0x2 }]);
    expect(partial.get(0xe0)).toBe(0xffff00ff);
  });
});

describe('TEV stage decode', () => {
  const regs = new PicaRegisterFile().apply(readPicaWrites([0x0e5e0e54, 0x804f00c0, 0x00002200, 0x00040004, 0xf8ffffff, 0]));
  it('decodes the swordmaster body stage 0: lerp(Texture1, Texture2, Constant.a), K = ffffff f8', () => {
    const s = decodeTevStage((r) => regs.get(r), 0);
    expect(s.rgbSource).toEqual([4, 5, 14]);
    expect(s.rgbOperand).toEqual([0, 0, 2]);
    expect(s.rgbCombine).toBe(4);
    expect(s.constant).toEqual([255, 255, 255, 248]);
    expect(isValidTevStage(s)).toBe(true);
    expect(describeTevStage(s)).toContain('Interpolate[Texture1(SrcColor), Texture2(SrcColor), Constant(SrcAlpha)]');
  });
  it('rejects an out-of-set field (source 7 does not exist)', () => {
    const s = decodeTevStage(() => 0x00000007, 0);
    expect(isValidTevStage(s)).toBe(false);
  });
});

describe('lighting', () => {
  it('reads input select / abs / scale nibbles: 0x22 select, 0x02222222 abs register (all signed), scale 1', () => {
    const l = decodeLightingLutInputs(0x02222222, 0x22, 0x1);
    expect(l.D0).toMatchObject({ inputName: 'N.V', abs: false, scale: 2 });
    expect(l.D1).toMatchObject({ inputName: 'N.V', abs: false, scale: 1 });
    expect(l.FR.inputName).toBe('N.H');
  });
  it('decodes a LUT word (12-bit value + signed 12-bit delta) and samples both halves', () => {
    const words = new Array(256).fill(0);
    words[0] = 0x00842666; // value 0x666 = 0.4, delta 0x084 / 2047
    words[255] = 0x00000fff;
    const lut = decodeLightingLutWords(words);
    expect(lut.values[0]).toBeCloseTo(0.4, 3);
    expect(sampleLightingLut(lut, -0.0078125, false)).toBeCloseTo(1, 2);
    expect(sampleLightingLut(lut, 0, false)).toBeCloseTo(0.4, 2);
  });
  it('decodes fragment operations', () => {
    expect(decodeAlphaTest(0xf361)).toEqual({ enabled: true, func: 'Greater', ref: 0xf3 });
    expect(decodeBlendFunc(0x01dc0000)).toMatchObject({ srcRgb: 'ConstantAlpha', dstRgb: 'OneMinusConstantAlpha', srcAlpha: 'One', dstAlpha: 'Zero' });
  });
});

describe('float24', () => {
  it('converts 1.0 and -2.0', () => {
    expect(float24(0x3f0000)).toBe(1);
    expect(float24(0xc00000 | (0x40 << 16))).toBe(-2);
  });
});
