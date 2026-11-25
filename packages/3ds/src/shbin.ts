/**
 * PICA200 shader binaries (DVLB / SHBIN): the vertex and geometry shaders the CTR SDK links into a game. FE Awakening keeps them in
 * a CGFX shader object (`shaders/nwgfx_DefaultShader.r`), Fates and Echoes in the shader table of `common/SharedData.bch`; the
 * standalone `shaders/*.shbin` files are the same container.
 *
 * Layout (3dbrew "SHBIN"): `DVLB` = [count][DVLE offsets...][DVLP]; DVLP = the instruction words and the operand-descriptor
 * (swizzle) table; each DVLE = an entry point and its constant / label / output-map / uniform / symbol tables.
 */
import { u32At } from './le.js';

export interface ShbinUniform {
  name: string;
  /** First and last register of the uniform: 0x00-0x0F inputs, 0x10-0x6F float constants c0-c95, 0x70-0x73 int i0-i3, 0x78-0x87 bool b0-b15. */
  start: number;
  end: number;
}

export interface ShbinEntry {
  /** 0 = vertex shader, 1 = geometry shader. */
  type: number;
  /** Instruction index of the entry point and of its end. */
  main: number;
  end: number;
  uniforms: ShbinUniform[];
  labels: { id: number; offset: number; size: number; name: string }[];
  /** Float constants `[register, x, y, z, w]` (float24 values decoded). */
  floatConstants: { register: number; value: [number, number, number, number] }[];
}

export interface Shbin {
  /** Instruction words. */
  code: Uint32Array;
  /** Operand descriptors `[descriptor, mask]`. */
  descriptors: [number, number][];
  entries: ShbinEntry[];
}

/** PICA float24 (1 sign, 7 exponent bias 63, 16 mantissa) to a JS number. */
export function float24(bits: number): number {
  const sign = (bits >>> 23) & 1;
  const exp = (bits >>> 16) & 0x7f;
  const man = bits & 0xffff;
  if (exp === 0 && man === 0) return 0;
  const v = (1 + man / 65536) * 2 ** (exp - 63);
  return sign ? -v : v;
}

function cstr(data: Uint8Array, off: number): string {
  let e = off;
  while (e < data.length && data[e] !== 0) e++;
  return new TextDecoder('latin1').decode(data.subarray(off, e));
}

/** Parses the DVLB at `base`. Throws when the magic or a table is out of range. */
export function parseShbin(data: Uint8Array, base = 0): Shbin {
  if (String.fromCharCode(...data.subarray(base, base + 4)) !== 'DVLB') throw new Error('Not a DVLB');
  const count = u32At(data, base + 4);
  if (count === 0 || count > 64) throw new Error(`implausible DVLE count ${count}`);
  const offsets = Array.from({ length: count }, (_, i) => u32At(data, base + 8 + 4 * i));
  const lp = base + 8 + 4 * count;
  if (String.fromCharCode(...data.subarray(lp, lp + 4)) !== 'DVLP') throw new Error('DVLP missing');
  const binOff = u32At(data, lp + 8);
  const binWords = u32At(data, lp + 12);
  const opdOff = u32At(data, lp + 16);
  const opdCount = u32At(data, lp + 20);
  if (lp + binOff + binWords * 4 > data.length || lp + opdOff + opdCount * 8 > data.length) throw new Error('DVLP table out of range');
  const code = new Uint32Array(binWords);
  for (let i = 0; i < binWords; i++) code[i] = u32At(data, lp + binOff + 4 * i);
  const descriptors: [number, number][] = [];
  for (let i = 0; i < opdCount; i++) descriptors.push([u32At(data, lp + opdOff + 8 * i), u32At(data, lp + opdOff + 8 * i + 4)]);
  const entries = offsets.map((o): ShbinEntry => {
    const e = base + o;
    if (String.fromCharCode(...data.subarray(e, e + 4)) !== 'DVLE') throw new Error('DVLE missing');
    const [ct, cn, lt, ln, , , ut, un, st] = Array.from({ length: 9 }, (_, i) => u32At(data, e + 0x18 + 4 * i));
    const uniforms: ShbinUniform[] = [];
    for (let i = 0; i < un!; i++) {
      const q = e + ut! + 8 * i;
      uniforms.push({ name: cstr(data, e + st! + u32At(data, q)), start: data[q + 4]! | (data[q + 5]! << 8), end: data[q + 6]! | (data[q + 7]! << 8) });
    }
    const labels = [];
    for (let i = 0; i < ln!; i++) {
      const q = e + lt! + 16 * i;
      labels.push({ id: u32At(data, q), offset: u32At(data, q + 4), size: u32At(data, q + 8), name: cstr(data, e + st! + u32At(data, q + 12)) });
    }
    const floatConstants: ShbinEntry['floatConstants'] = [];
    for (let i = 0; i < cn!; i++) {
      const q = e + ct! + 20 * i;
      if (data[q] === 2) floatConstants.push({ register: data[q + 2]! | (data[q + 3]! << 8), value: [0, 1, 2, 3].map((k) => float24(u32At(data, q + 4 + 4 * k) & 0xffffff)) as [number, number, number, number] });
    }
    return { type: data[e + 6]!, main: u32At(data, e + 8), end: u32At(data, e + 12), uniforms, labels, floatConstants };
  });
  return { code, descriptors, entries };
}

const ARITH: Record<number, string> = {
  0x00: 'add', 0x01: 'dp3', 0x02: 'dp4', 0x03: 'dph', 0x04: 'dst', 0x05: 'ex2', 0x06: 'lg2', 0x07: 'litp', 0x08: 'mul', 0x09: 'sge', 0x0a: 'slt',
  0x0b: 'flr', 0x0c: 'max', 0x0d: 'min', 0x0e: 'rcp', 0x0f: 'rsq', 0x12: 'mova', 0x13: 'mov', 0x18: 'dphi', 0x19: 'dsti', 0x1a: 'sgei', 0x1b: 'slti',
};
/** Flow-control opcodes (PICA200 ISA; the table of 3dbrew / Citra: BREAK 0x20, NOP 0x21, END 0x22, ... JMPC 0x2C, JMPU 0x2D, CMP 0x2E-0x2F). */
const FLOW: Record<number, string> = {
  0x20: 'break', 0x21: 'nop', 0x22: 'end', 0x23: 'breakc', 0x24: 'call', 0x25: 'callc', 0x26: 'callu', 0x27: 'ifu', 0x28: 'ifc', 0x29: 'loop',
  0x2a: 'emit', 0x2b: 'setemit', 0x2c: 'jmpc', 0x2d: 'jmpu',
};
/** Opcodes whose first source is 5 bits and second 7 bits (the "inverted" forms). */
const INVERTED = new Set([0x18, 0x19, 0x1a, 0x1b]);
const ONE_SRC = new Set([0x05, 0x06, 0x07, 0x0b, 0x0e, 0x0f, 0x12, 0x13]);
const IDX = ['', '[a0.x]', '[a0.y]', '[aL]'];
const CMP_OPS = ['==', '!=', '<', '<=', '>', '>=', '?', '?'];

function swz(bits: number): string {
  const s = [0, 1, 2, 3].map((i) => 'xyzw'[(bits >>> (6 - 2 * i)) & 3]).join('');
  return s === 'xyzw' ? '' : `.${s}`;
}
/** Source operand: `n` the 7-bit (or 5-bit) register field, `idx` the address-register selector (only meaningful on the constant range). */
function srcReg(n: number, neg: boolean | number, bits: number, idx = 0): string {
  const r = n < 0x10 ? `v${n}` : n < 0x20 ? `r${n - 0x10}` : `c${n - 0x20}${IDX[idx]}`;
  return `${neg ? '-' : ''}${r}${swz(bits)}`;
}
function dstReg(dst: number, d: number): string {
  const mask = [0, 1, 2, 3].map((i) => ((d >>> (3 - i)) & 1 ? 'xyzw'[i] : '')).join('');
  return `${dst < 0x10 ? `o${dst}` : `r${dst - 0x10}`}.${mask}`;
}

/**
 * Disassembles one PICA200 instruction: arithmetic (format 1 / 1i), MAD / MADI, CMP and the flow-control group (call / if / loop / jmp with
 * their target and length, `end`, `nop`). Registers: `vN` input, `rN` temporary, `cN` float constant, `oN` output; `[a0.x]`-style
 * suffixes are the address-register index. Targets are absolute instruction indices.
 */
export function disassembleShaderInstruction(shbin: Shbin, pc: number): string {
  const w = shbin.code[pc]!;
  const op = w >>> 26;
  if (op >= 0x30) {
    const inv = op < 0x38;
    const d = shbin.descriptors[w & 0x1f]?.[0] ?? 0;
    const idx = (w >>> 22) & 3;
    const src1 = (w >>> 17) & 0x1f;
    const src2 = inv ? (w >>> 12) & 0x1f : (w >>> 10) & 0x7f;
    const src3 = inv ? (w >>> 5) & 0x7f : (w >>> 5) & 0x1f;
    const idx2 = inv ? 0 : idx; // the index register applies to the 7-bit (constant-capable) operand
    const idx3 = inv ? idx : 0;
    return `mad ${dstReg((w >>> 24) & 0x1f, d)}, ${srcReg(src1, (d >>> 4) & 1, d >>> 5)}, ${srcReg(src2, (d >>> 13) & 1, d >>> 14, idx2)}, ${srcReg(src3, (d >>> 22) & 1, d >>> 23, idx3)}`;
  }
  const flow = FLOW[op];
  if (flow) {
    const dest = (w >>> 10) & 0xfff;
    const num = w & 0xff;
    const cond = ['or', 'and', 'x', 'y'][(w >>> 22) & 3];
    const refs = `${(w >>> 25) & 1 ? '' : '!'}cc.x ${cond} ${(w >>> 24) & 1 ? '' : '!'}cc.y`;
    switch (op) {
      case 0x23: case 0x25: case 0x28: case 0x2c: return `${flow} ${refs} -> ${dest} (+${num})`;
      case 0x24: return `call ${dest} (+${num})`;
      case 0x26: case 0x27: case 0x2d: return `${flow} b${(w >>> 22) & 15} -> ${dest} (+${num})`;
      case 0x29: return `loop i${(w >>> 22) & 3} -> ${dest}`;
      default: return flow;
    }
  }
  if (op === 0x2e || op === 0x2f) {
    const d = shbin.descriptors[w & 0x7f]?.[0] ?? 0;
    return `cmp ${srcReg((w >>> 12) & 0x7f, (d >>> 4) & 1, d >>> 5, (w >>> 19) & 3)} ${CMP_OPS[(w >>> 24) & 7]}x, ${srcReg((w >>> 7) & 0x1f, (d >>> 13) & 1, d >>> 14)} (y ${CMP_OPS[(w >>> 21) & 7]})`;
  }
  const name = ARITH[op];
  if (!name) return `op${op.toString(16)} ${w.toString(16).padStart(8, '0')}`;
  const d = shbin.descriptors[w & 0x7f]?.[0] ?? 0;
  const idx = (w >>> 19) & 3;
  const inv = INVERTED.has(op);
  const a = inv ? (w >>> 14) & 0x1f : (w >>> 12) & 0x7f;
  const b = inv ? (w >>> 7) & 0x7f : (w >>> 7) & 0x1f;
  const s1 = srcReg(a, ((d >>> 4) & 1) === 1, d >>> 5, inv ? 0 : idx);
  const s2 = srcReg(b, ((d >>> 13) & 1) === 1, d >>> 14, inv ? idx : 0);
  const o = dstReg((w >>> 21) & 0x1f, d);
  return ONE_SRC.has(op) ? `${name} ${o}, ${s1}` : `${name} ${o}, ${s1}, ${s2}`;
}
