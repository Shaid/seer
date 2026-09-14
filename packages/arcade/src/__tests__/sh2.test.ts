import { describe, expect, it } from 'vitest';
import { Sh2, SR_T } from '../capcom/sh2.js';

class TestMem {
  ram = new Uint8Array(0x10000);
  prog = new Uint8Array(0x10000);
  writeByte = (a: number, v: number): void => {
    const A = a >>> 0;
    if (A >= 0x08000000 && A < 0x08010000) this.ram[(A - 0x08000000) & 0xffff] = v & 0xff;
  };
  readByte = (a: number): number => {
    const A = a >>> 0;
    if (A >= 0x08000000 && A < 0x08010000) return this.ram[(A - 0x08000000) & 0xffff] ?? 0;
    if (A >= 0x04000000 && A < 0x04010000) return this.prog[(A - 0x04000000) & 0xffff] ?? 0;
    return 0;
  };
  readWord = (a: number): number => ((this.readByte(a) << 8) | this.readByte(a + 1)) & 0xffff;
  readLong = (a: number): number =>
    ((this.readByte(a) << 24) | (this.readByte(a + 1) << 16) | (this.readByte(a + 2) << 8) | this.readByte(a + 3)) >>> 0;

  constructor(program: Uint8Array) {
    this.prog.set(program, 0);
  }
}

function makeCpu(program: number[]): { cpu: Sh2; mem: TestMem } {
  const mem = new TestMem(Uint8Array.from(program.flatMap((w) => [(w >> 8) & 0xff, w & 0xff])));
  const cpu = new Sh2(mem);
  return { cpu, mem };
}

describe('Sh2 (FBNeo-port) targeted semantics', () => {
  it('m field = bits 7-4 (mov register forms)', () => {
    const { cpu } = makeCpu([0xe255, 0x6323]); // mov #0x55,r2 ; mov r2,r3
    cpu.reset(0x04000000, 0x100);
    cpu.run(2);
    expect(cpu.r[2]).toBe(0x55);
    expect(cpu.r[3]).toBe(0x55);
  });

  it('op0100 JSR uses Rn (bits 11-8): 0x430b = jsr @r3; PR = addr+4', () => {
    const { cpu, mem } = makeCpu([0x430b, 0x0009]); // jsr @r3 ; nop(delay)
    mem.prog.set([0x00, 0x0b, 0x00, 0x09], 0x10); // rts ; nop at 0x04000010
    cpu.reset(0x04000000, 0x100);
    cpu.r[3] = 0x04000010;
    cpu.run(4);
    // jsr -> pr=0x04000004, pc=0x04000010; delay nop; rts -> pc=pr; delay nop
    expect(cpu.pc >>> 0).toBe(0x04000004);
    expect(cpu.pr >>> 0).toBe(0x04000004);
  });

  it('BRAF uses Rn (bits 11-8): 0x0323 branches through r3', () => {
    const { cpu, mem } = makeCpu([0x0323, 0x0009, 0x0009, 0x0009]);
    cpu.reset(0x04000000, 0x100);
    cpu.r[3] = 0x10;
    cpu.run(1);
    expect(cpu.pc >>> 0).toBe(0x04000014);
    void mem;
  });

  it('LDC.L @Rn+,SR uses bits 11-8: 0x4007 = ldc.l @r0+,sr', () => {
    const { cpu, mem } = makeCpu([0x4007]); // ldc.l @r0+,sr
    mem.ram.set([0x00, 0x00, 0x00, 0xf0], 0x4000); // SR dword at 0x08004000
    cpu.reset(0x04000000, 0x100);
    cpu.r[0] = 0x08004000;
    cpu.run(1);
    expect(cpu.sr & 0xfff).toBe(0xf0);
    expect(cpu.r[0] >>> 0).toBe(0x08004004);
  });

  it('LDS.L @Rn+,PR uses bits 11-8: 0x4f26 restores PR from the stack', () => {
    const { cpu, mem } = makeCpu([0x4f26]); // lds.l @r15+,pr
    mem.ram.set([0x04, 0x00, 0x00, 0x10], 0x4000);
    cpu.reset(0x04000000, 0x08004000);
    cpu.run(1);
    expect(cpu.pr >>> 0).toBe(0x04000010);
    expect(cpu.r[15] >>> 0).toBe(0x08004004);
  });

  it('delay slot executes before the branch takes effect (rts to pr)', () => {
    const { cpu, mem } = makeCpu([0x430b, 0x0009]); // jsr @r3 ; nop(delay)
    mem.prog.set([0x00, 0x0b, 0x00, 0x09], 0x10); // rts ; nop at 0x04000010
    cpu.reset(0x04000000, 0x100);
    cpu.r[3] = 0x04000010; // point at the rts stub
    cpu.run(4);
    expect(cpu.pc >>> 0).toBe(0x04000004);
  });

  it('addc r3,r2 (323e) adds carry and sets T on overflow out', () => {
    const { cpu } = makeCpu([0xe2ff, 0xe301, 0x323e]);
    cpu.reset(0x04000000, 0x100);
    cpu.run(3);
    expect(cpu.r[2]).toBe(0); // -1 + 1 = 0, carry out
    expect(cpu.sr & SR_T).toBe(SR_T);
  });
});
