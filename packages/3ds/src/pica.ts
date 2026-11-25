/**
 * PICA200 fragment-pipeline state, as the CTR SDK stores it in model materials.
 *
 * A BCH or CGFX material keeps the GPU's own register writes: the texture-environment (TEV) combiner stages
 * (registers 0xC0-0xFD), fragment lighting (0x1C0-0x1D9, LUT data through 0x1C8) and fragment operations (0x100-0x107). The layout
 * is the publicly documented one (3dbrew "GPU/Internal Registers"); this module reads it, it does not emulate it. Used by `bch.ts`
 * (`BchMaterialShading`) and `cgfx.ts` (`CgfxMaterialShading`); the lucina docs/3ds-formats.md section "Material shading (all three
 * titles)" has the per-title findings.
 *
 * Command stream: `[data word][header word][extra data words...]`, header = register (bits 0-15) | byte-enable mask (16-19) | extra
 * count (20-30) | consecutive (31). A block is padded to an even word count. The mask is a per-byte write enable (bit i = byte i);
 * an earlier reader in this package treated it as a bit mask and OR-ed old register contents into rewrites.
 */

export interface PicaWrite {
  reg: number;
  value: number;
  /** Byte-enable mask (4 bits). */
  mask: number;
}

/** Splits a PICA command buffer into its register writes (consecutive blocks expanded). Stops at a zero header or the end. */
export function readPicaWrites(words: ArrayLike<number>, start = 0, count = words.length - start): PicaWrite[] {
  const out: PicaWrite[] = [];
  let i = start;
  const end = Math.min(words.length, start + count);
  while (i + 1 < end) {
    const value = words[i]! >>> 0;
    const header = words[i + 1]! >>> 0;
    i += 2;
    const reg = header & 0xffff;
    const mask = (header >>> 16) & 0xf;
    const extra = (header >>> 20) & 0x7ff;
    const consecutive = (header & 0x80000000) !== 0;
    out.push({ reg, value, mask });
    for (let k = 0; k < extra && i < end; k++, i++) out.push({ reg: consecutive ? reg + k + 1 : reg, value: words[i]! >>> 0, mask });
    if (extra % 2 === 1) i++; // the block is padded to an even number of words
  }
  return out;
}

/** A register file: `apply` honours the byte-enable mask. */
export class PicaRegisterFile {
  private readonly regs = new Map<number, number>();
  apply(writes: readonly PicaWrite[]): this {
    for (const w of writes) {
      let v = this.regs.get(w.reg) ?? 0;
      for (let b = 0; b < 4; b++) if ((w.mask >> b) & 1) v = (v & ~(0xff << (8 * b))) | (w.value & (0xff << (8 * b)));
      this.regs.set(w.reg, v >>> 0);
    }
    return this;
  }
  get(reg: number): number {
    return this.regs.get(reg) ?? 0;
  }
  has(reg: number): boolean {
    return this.regs.has(reg);
  }
  entries(): [number, number][] {
    return [...this.regs.entries()].sort((a, b) => a[0] - b[0]);
  }
}

// ---------------------------------------------------------------------------
// Texture environment (TEV)
// ---------------------------------------------------------------------------

/** Register base of TEV stages 0..5 (stages 4 and 5 sit after the buffer registers). Each stage: +0 source, +1 operand, +2 combine, +3 constant, +4 scale. */
export const PICA_TEV_STAGE_BASE = [0xc0, 0xc8, 0xd0, 0xd8, 0xf0, 0xf8] as const;
/** 0xE0: buffer update flags (bits 8-11 rgb, 12-15 alpha, stages 0-3; the buffer seen by stage n+1 is the output of an updating stage n-1... see lucina docs). 0xFD: initial buffer colour. */
export const PICA_TEV_UPDATE_BUFFER = 0xe0;
export const PICA_TEV_BUFFER_COLOR = 0xfd;

export const TEV_SOURCE = { PrimaryColor: 0, FragmentPrimaryColor: 1, FragmentSecondaryColor: 2, Texture0: 3, Texture1: 4, Texture2: 5, Texture3: 6, PreviousBuffer: 13, Constant: 14, Previous: 15 } as const;
export const TEV_SOURCE_NAMES: Record<number, string> = {
  0: 'PrimaryColor',
  1: 'FragmentPrimaryColor',
  2: 'FragmentSecondaryColor',
  3: 'Texture0',
  4: 'Texture1',
  5: 'Texture2',
  6: 'Texture3',
  13: 'PreviousBuffer',
  14: 'Constant',
  15: 'Previous',
};
export const TEV_RGB_OPERAND_NAMES: Record<number, string> = {
  0: 'SrcColor',
  1: 'OneMinusSrcColor',
  2: 'SrcAlpha',
  3: 'OneMinusSrcAlpha',
  4: 'SrcRed',
  5: 'OneMinusSrcRed',
  8: 'SrcGreen',
  9: 'OneMinusSrcGreen',
  12: 'SrcBlue',
  13: 'OneMinusSrcBlue',
};
export const TEV_ALPHA_OPERAND_NAMES: Record<number, string> = {
  0: 'SrcAlpha',
  1: 'OneMinusSrcAlpha',
  2: 'SrcRed',
  3: 'OneMinusSrcRed',
  4: 'SrcGreen',
  5: 'OneMinusSrcGreen',
  6: 'SrcBlue',
  7: 'OneMinusSrcBlue',
};
export const TEV_COMBINE_NAMES: Record<number, string> = {
  0: 'Replace',
  1: 'Modulate',
  2: 'Add',
  3: 'AddSigned',
  4: 'Interpolate',
  5: 'Subtract',
  6: 'Dot3Rgb',
  7: 'Dot3Rgba',
  8: 'MultiplyAdd',
  9: 'AddMultiply',
};

export interface TevStage {
  rgbSource: [number, number, number];
  alphaSource: [number, number, number];
  rgbOperand: [number, number, number];
  alphaOperand: [number, number, number];
  rgbCombine: number;
  alphaCombine: number;
  /** Constant colour (the `Constant` source), r, g, b, a 0-255. */
  constant: [number, number, number, number];
  rgbScale: 1 | 2 | 4;
  alphaScale: 1 | 2 | 4;
}

/** Decodes TEV stage `index` (0-5) from a register reader. */
export function decodeTevStage(get: (reg: number) => number, index: number): TevStage {
  const b = PICA_TEV_STAGE_BASE[index]!;
  const src = get(b) >>> 0;
  const opr = get(b + 1) >>> 0;
  const cmb = get(b + 2) >>> 0;
  const col = get(b + 3) >>> 0;
  const scl = get(b + 4) >>> 0;
  const scale = (v: number): 1 | 2 | 4 => (v === 1 ? 2 : v === 2 ? 4 : 1);
  return {
    rgbSource: [src & 15, (src >>> 4) & 15, (src >>> 8) & 15],
    alphaSource: [(src >>> 16) & 15, (src >>> 20) & 15, (src >>> 24) & 15],
    rgbOperand: [opr & 15, (opr >>> 4) & 15, (opr >>> 8) & 15],
    alphaOperand: [(opr >>> 12) & 7, (opr >>> 16) & 7, (opr >>> 20) & 7],
    rgbCombine: cmb & 15,
    alphaCombine: (cmb >>> 16) & 15,
    constant: [col & 255, (col >>> 8) & 255, (col >>> 16) & 255, (col >>> 24) & 255],
    rgbScale: scale(scl & 3),
    alphaScale: scale((scl >>> 16) & 3),
  };
}

/** True when every field of the stage is in the hardware's valid set (sources, operands, combine modes, scale). The structural check the lucina census runs over every material. */
export function isValidTevStage(s: TevStage): boolean {
  return (
    s.rgbSource.every((x) => x in TEV_SOURCE_NAMES) &&
    s.alphaSource.every((x) => x in TEV_SOURCE_NAMES) &&
    s.rgbOperand.every((x) => x in TEV_RGB_OPERAND_NAMES) &&
    s.alphaOperand.every((x) => x in TEV_ALPHA_OPERAND_NAMES) &&
    s.rgbCombine in TEV_COMBINE_NAMES &&
    s.alphaCombine in TEV_COMBINE_NAMES
  );
}

/** One line per stage, e.g. `RGB Interpolate[Texture1(SrcColor), Texture2(SrcColor), Constant(SrcAlpha)] x1 | A ... | K=f8ffffff`. */
export function describeTevStage(s: TevStage): string {
  const part = (src: number[], op: number[], names: Record<number, string>) => src.map((x, i) => `${TEV_SOURCE_NAMES[x] ?? `?${x}`}(${names[op[i]!] ?? `?${op[i]}`})`).join(', ');
  const k = s.constant.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `RGB ${TEV_COMBINE_NAMES[s.rgbCombine] ?? `?${s.rgbCombine}`}[${part(s.rgbSource, s.rgbOperand, TEV_RGB_OPERAND_NAMES)}] x${s.rgbScale} | A ${TEV_COMBINE_NAMES[s.alphaCombine] ?? `?${s.alphaCombine}`}[${part(s.alphaSource, s.alphaOperand, TEV_ALPHA_OPERAND_NAMES)}] x${s.alphaScale} | K=${k}`;
}

// ---------------------------------------------------------------------------
// Fragment lighting
// ---------------------------------------------------------------------------

/** LUT inputs (`LIGHTING_LUTINPUT_SELECT` nibbles): 0 N.H, 1 V.H, 2 N.V, 3 L.N, 4 -L.P (spot), 5 cos(phi). */
export const LIGHTING_INPUT_NAMES = ['N.H', 'V.H', 'N.V', 'L.N', '-L.P', 'cosPhi'] as const;
/** `LIGHTING_LUTINPUT_SCALE` nibbles: 0 x1, 1 x2, 2 x4, 3 x8, 4 x1/4, 5 x1/2. */
export const LIGHTING_SCALE_VALUES = [1, 2, 4, 8, 0.25, 0.5] as const;
/** The seven LUT slots in register-nibble order: D0, D1, SP (spot), FR (fresnel), RB, RG, RR (reflectance blue / green / red). */
export const LIGHTING_LUT_SLOTS = ['D0', 'D1', 'SP', 'FR', 'RB', 'RG', 'RR'] as const;
export type LightingLutSlot = (typeof LIGHTING_LUT_SLOTS)[number];

export interface LightingLutInput {
  /** Index into `LIGHTING_INPUT_NAMES`. */
  input: number;
  inputName: string;
  /** True when the input is passed through |x| (register 0x1D0 nibble bit 1 clear); false = signed input, the whole 256-entry table is addressed. */
  abs: boolean;
  scale: number;
}

/** Decodes registers 0x1D0 (absolute-value flags: bit 1 of each nibble *disables* abs), 0x1D1 (input select) and 0x1D2 (input scale). */
export function decodeLightingLutInputs(absReg: number, selectReg: number, scaleReg: number): Record<LightingLutSlot, LightingLutInput> {
  const out = {} as Record<LightingLutSlot, LightingLutInput>;
  LIGHTING_LUT_SLOTS.forEach((slot, i) => {
    const input = (selectReg >>> (4 * i)) & 7;
    out[slot] = {
      input,
      inputName: LIGHTING_INPUT_NAMES[input] ?? `?${input}`,
      abs: ((absReg >>> (4 * i + 1)) & 1) === 0,
      scale: LIGHTING_SCALE_VALUES[(scaleReg >>> (4 * i)) & 7] ?? 1,
    };
  });
  return out;
}

/** Light permutation register 0x1D9: nibbles name the enabled light slots in order (`0x3210` = lights 0-3). */
export function decodeLightPermutation(reg: number, lights = 8): number[] {
  const out: number[] = [];
  for (let i = 0; i < lights; i++) out.push((reg >>> (4 * i)) & 7);
  return out;
}

/**
 * A 256-entry lighting LUT: each word is a 12-bit value (0.12 fixed point) and the difference to the next entry
 * (bits 12-23: sign-magnitude, 0.11 fixed). Index 0-127 is input 0..1, 128-255 is -1..0 (two's complement of x*128) when the input is signed.
 */
export interface LightingLut {
  values: Float32Array;
  deltas: Float32Array;
}

export function decodeLightingLutWords(words: ArrayLike<number>): LightingLut {
  const values = new Float32Array(256);
  const deltas = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const w = (words[i] ?? 0) >>> 0;
    values[i] = (w & 0xfff) / 4095;
    // sign-magnitude: bit 23 = sign, bits 12-22 = magnitude in 1/2048 steps (a 0.11 fixed-point difference); measured on 18 + 19 tables
    // (two's complement made the negative slopes read as -1.0: 'RimLight_Strong' deltas 0x800 / 0x801 are -0 / -1/2048)
    const mag = (w >>> 12) & 0x7ff;
    deltas[i] = ((w >>> 23) & 1 ? -mag : mag) / 2048;
  }
  return { values, deltas };
}

/** Pulls the 256 data words of a LUT out of its command buffer (the writes to port 0x1C8). */
export function lightingLutFromCommands(words: ArrayLike<number>, start = 0, count = words.length - start): LightingLut | null {
  const data = readPicaWrites(words, start, count)
    .filter((w) => w.reg === 0x1c8)
    .map((w) => w.value);
  return data.length >= 256 ? decodeLightingLutWords(data) : null;
}

/** Looks a LUT up like the hardware does: signed input in [-1, 1), or |x| when `abs`. */
export function sampleLightingLut(lut: LightingLut, x: number, abs: boolean): number {
  if (abs) x = Math.abs(x);
  const f = Math.max(-1, Math.min(0.9999, x)) * 128;
  const i = Math.floor(f);
  const index = i < 0 ? i + 256 : i;
  return lut.values[index]! + lut.deltas[index]! * (f - i);
}

/** True when the table is a plausible LUT (monotone-free check: 256 values in [0, 1]). */
export function isValidLightingLut(lut: LightingLut): boolean {
  return lut.values.length === 256 && lut.values.every((v) => v >= 0 && v <= 1);
}

// ---------------------------------------------------------------------------
// Fragment operations
// ---------------------------------------------------------------------------

export const PICA_BLEND_FACTOR_NAMES = ['Zero', 'One', 'SrcColor', 'OneMinusSrcColor', 'DstColor', 'OneMinusDstColor', 'SrcAlpha', 'OneMinusSrcAlpha', 'DstAlpha', 'OneMinusDstAlpha', 'ConstantColor', 'OneMinusConstantColor', 'ConstantAlpha', 'OneMinusConstantAlpha', 'SrcAlphaSaturate'];
export const PICA_COMPARE_NAMES = ['Never', 'Always', 'Equal', 'NotEqual', 'Less', 'LessEqual', 'Greater', 'GreaterEqual'];

export interface PicaBlend {
  rgbEquation: number;
  alphaEquation: number;
  srcRgb: string;
  dstRgb: string;
  srcAlpha: string;
  dstAlpha: string;
}

/** Register 0x101 (blend function): equations in bits 0-2 / 8-10, factors src rgb 16-19, dst rgb 20-23, src alpha 24-27, dst alpha 28-31. */
export function decodeBlendFunc(reg: number): PicaBlend {
  const f = (n: number) => PICA_BLEND_FACTOR_NAMES[n] ?? `?${n}`;
  return { rgbEquation: reg & 7, alphaEquation: (reg >>> 8) & 7, srcRgb: f((reg >>> 16) & 15), dstRgb: f((reg >>> 20) & 15), srcAlpha: f((reg >>> 24) & 15), dstAlpha: f((reg >>> 28) & 15) };
}

/** Register 0x104 (alpha test): bit 0 enable, bits 4-6 function, bits 8-15 reference. */
export function decodeAlphaTest(reg: number): { enabled: boolean; func: string; ref: number } {
  return { enabled: (reg & 1) !== 0, func: PICA_COMPARE_NAMES[(reg >>> 4) & 7] ?? '?', ref: (reg >>> 8) & 255 };
}
