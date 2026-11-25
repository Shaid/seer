import { describe, expect, it } from 'vitest';
import { disassembleShaderInstruction, type Shbin } from '../shbin.js';

/** One-instruction programs with descriptor 0 (identity swizzle, full mask). */
function dis(word: number, desc = 0x0000000f | (0x1b << 5) | (0x1b << 14) | (0x1b << 23)): string {
  const shbin: Shbin = { code: Uint32Array.from([word >>> 0]), descriptors: [[desc >>> 0, 0]], entries: [] };
  return disassembleShaderInstruction(shbin, 0);
}

describe('PICA200 shader disassembler', () => {
  it('decodes arithmetic with the 7-bit first source and the register-file split', () => {
    // mul r15.xyzw, c7.xyzw, v0: op 0x08, dest 0x1f, src1 0x27, src2 0
    expect(dis((0x08 << 26) | (0x1f << 21) | (0x27 << 12) | (0 << 7))).toBe('mul r15.xyzw, c7, v0');
  });
  it('decodes the inverted forms with the 7-bit second source (dphi, slti)', () => {
    // slti r1, v0, c3: op 0x1b, src1 5-bit at 14, src2 7-bit at 7
    expect(dis((0x1b << 26) | (0x11 << 21) | (0 << 14) | (0x23 << 7))).toBe('slti r1.xyzw, v0, c3');
  });
  it('decodes the flow-control group at the Citra / 3dbrew opcode numbers (end 0x22, call 0x24, ifu 0x27, jmpc 0x2c)', () => {
    expect(dis(0x22 << 26)).toBe('end');
    expect(dis(0x21 << 26)).toBe('nop');
    expect(dis((0x24 << 26) | (311 << 10) | 12)).toBe('call 311 (+12)');
    expect(dis((0x27 << 26) | (6 << 22) | (331 << 10) | 0)).toBe('ifu b6 -> 331 (+0)');
    expect(dis((0x2d << 26) | (3 << 22) | (10 << 10) | 1)).toBe('jmpu b3 -> 10 (+1)');
  });
  it('decodes MAD with the 5-bit src1 / 7-bit src2 / 5-bit src3 layout and MADI inverted', () => {
    // mad r4, r2, r1, r3: dest 0x14 at 24, src1 r2 = 0x12 at 17, src2 r1 = 0x11 at 10, src3 r3 = 0x13 at 5
    expect(dis((0x38 << 26) | (0x14 << 24 >>> 0) | (0x12 << 17) | (0x11 << 10) | (0x13 << 5))).toMatch(/^mad r4\.xyzw, r2, r1, r3$/);
  });
});
