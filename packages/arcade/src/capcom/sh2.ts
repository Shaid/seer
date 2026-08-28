/**
 * Hitachi SH-2 (SH7600 family) interpreter — TypeScript port of FBNeo's
 * proven core (src/cpu/sh2/sh2.cpp, © Juergen Buchmueller, OopsWare, FBNeo).
 *
 * Semantics (flags, delay slot, cycle accounting, overflow/carry helpers) are
 * ported opcode-for-opcode from the C interpreter — no re-derived encodings.
 * The memory interface is deliberately minimal and *logical big-endian*: all
 * reads/writes go through pluggable byte handlers, and readWord/readLong are
 * assembled big-endian over those bytes. (FBNeo's `A ^= n` storage tricks for
 * x86 hosts are not needed here.)
 *
 * Registers: r0..r15 (r15 = SP), PC, SR, GBR, VBR, MACH, MACL, PR.
 * SR bits: T=1, S=2, I=0xf0, Q=0x100, M=0x200.
 *
 * Branch architecture: `delay` holds the PC of the pending delay slot; when
 * non-zero the next fetch happens there without advancing PC.
 */
export interface Sh2Bus {
  readByte(a: number): number;
  writeByte(a: number, v: number): void;
  /** Optional faster word/long reads; defaults to assembling from readByte. */
  readWord?(a: number): number;
  readLong?(a: number): number;
  writeWord?(a: number, v: number): void;
  writeLong?(a: number, v: number): void;
}

export const SR_T = 0x00000001;
export const SR_S = 0x00000002;
export const SR_I = 0x000000f0;
export const SR_Q = 0x00000100;
export const SR_M = 0x00000200;
export const SR_FLAGS = SR_M | SR_Q | SR_I | SR_S | SR_T;

const u32 = (v: number) => v >>> 0;
const s32 = (v: number) => v | 0;
const s8 = (v: number) => (v & 0x80 ? v - 0x100 : v);
const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v);

/** Interrupt line status constants (FBNeo CPU_IRQSTATUS_*). */
export const IRQ_HOLD = 1;
export const IRQ_ACK = 2;
export const IRQ_NONE = 0;
const IRQ_15 = 15;

export class Sh2 {
  r = new Int32Array(16);
  pc = 0;
  pr = 0;
  sr = 0;
  gbr = 0;
  vbr = 0;
  mach = 0;
  macl = 0;
  ppc = 0;
  ea = 0;
  delay = 0;
  totalCycles = 0;
  endRun = false;
  /** per-instruction extra budget drain — FBNeo initializes sh2_eat_cycles = 1. */
  eatCycles = 1;

  pendingIrq = 0;
  internalIrqLevel = -1;
  internalIrqVector = 0;
  private irqLineState = new Int32Array(16);
  testIrq = false;

  /** Optional per-instruction tracer (pc, opcode). Set only while diagnosing. */
  tracer?: (pc: number, op: number) => void;

  private bus: Sh2Bus;
  private icount = 0;

  constructor(bus: Sh2Bus) {
    this.bus = bus;
  }

  // ---- byte/bus accessors ----
  private fetch(a: number): number {
    const b = this.bus;
    if (b.readWord) return b.readWord(u32(a)) & 0xffff;
    return ((b.readByte(a) << 8) | b.readByte(a + 1)) & 0xffff;
  }
  private rb(a: number): number { return this.bus.readByte(u32(a)) & 0xff; }
  private rw(a: number): number {
    const b = this.bus;
    if (b.readWord) return b.readWord(u32(a)) & 0xffff;
    return ((b.readByte(a) << 8) | b.readByte(a + 1)) & 0xffff;
  }
  private rl(a: number): number {
    const b = this.bus;
    if (b.readLong) return u32(b.readLong(u32(a)));
    return u32((b.readByte(a) << 24) | (b.readByte(a + 1) << 16) | (b.readByte(a + 2) << 8) | b.readByte(a + 3));
  }
  private wb(a: number, v: number): void { this.bus.writeByte(u32(a), v & 0xff); }
  private ww(a: number, v: number): void {
    const b = this.bus;
    if (b.writeWord) b.writeWord(u32(a), v & 0xffff);
    else { b.writeByte(a, (v >> 8) & 0xff); b.writeByte(a + 1, v & 0xff); }
  }
  private wl(a: number, v: number): void {
    const b = this.bus;
    if (b.writeLong) { b.writeLong(u32(a), u32(v)); return; }
    const x = u32(v);
    b.writeByte(a, (x >>> 24) & 0xff);
    b.writeByte(a + 1, (x >>> 16) & 0xff);
    b.writeByte(a + 2, (x >>> 8) & 0xff);
    b.writeByte(a + 3, x & 0xff);
  }

  /** set/raise a hardware interrupt line (level 0..15, or 16 = NMI). */
  setIrqLine(line: number, state: number): void {
    if (state === IRQ_NONE) {
      this.pendingIrq &= ~(1 << line);
      this.irqLineState[line] = IRQ_NONE;
      return;
    }
    if (this.irqLineState[line] === state) return;
    this.irqLineState[line] = state;
    this.pendingIrq |= 1 << line;
    if (this.delay) this.testIrq = true;
    else this.checkIrq();
  }

  private exception(irqline: number): void {
    let vector: number;
    if (irqline === 16) vector = 11;
    else if (this.internalIrqLevel === irqline) vector = this.internalIrqVector;
    else vector = 64 + (irqline >> 1);

    this.r[15] -= 4;
    this.wl(this.r[15], u32(this.sr));
    this.r[15] -= 4;
    this.wl(this.r[15], u32(this.pc));

    if (irqline > IRQ_15) this.sr |= SR_I;
    else this.sr = (this.sr & ~SR_I) | ((irqline & 15) << 4);

    this.pc = this.rl(u32(this.vbr + vector * 4));
  }

  private checkIrq(): void {
    let irq = -1;
    for (let i = 0; i <= 15; i++) if (this.pendingIrq & (1 << i)) { irq = i; break; }
    if (this.internalIrqLevel !== -1 && this.internalIrqLevel > irq) irq = this.internalIrqLevel;
    if (irq >= 0) {
      if (irq <= ((this.sr >> 4) & 15)) return; // masked by I field
      this.exception(irq);
    }
  }

  reset(pc: number, r15 = 0): void {
    this.r.fill(0);
    this.pc = u32(pc);
    this.r[15] = r15 | 0;
    this.sr = SR_I;
    this.delay = 0;
    this.pr = 0;
    this.gbr = 0;
    this.vbr = 0;
    this.mach = 0;
    this.macl = 0;
    this.internalIrqLevel = -1;
    this.testIrq = false;
    this.endRun = false;
  }

  /** Execute until `budget` instructions/cycles are consumed or endRun set; returns budget left. */
  run(budget: number): number {
    this.icount = budget;
    while (this.icount > 0 && !this.endRun) {
      this.step();
      this.totalCycles++;
      this.icount -= this.eatCycles;
      if (this.testIrq && !this.delay) {
        this.checkIrq();
        this.testIrq = false;
      }
    }
    const left = this.icount;
    this.icount = 0;
    return left;
  }

  // ---- the interpreter ----
  private step(): void {
    const pc = u32(this.pc);
    let op: number;
    let execPc = pc;
    if (this.delay) {
      op = this.fetch(u32(this.delay));
      execPc = u32(this.delay);
      this.delay = 0;
    } else {
      op = this.fetch(pc);
      this.pc = u32(pc + 2);
    }
    this.ppc = this.pc;
    if (this.tracer) this.tracer(execPc, op);

    const n = (op >> 8) & 0xf;
    // FBNeo: #define Rm ((opcode>>4)&15) — the register field lives in bits
    // 7-4 for the @Rm/@(disp,Rm) forms; bits 3-0 are the sub-opcode nibble.
    const m = (op >> 4) & 0xf;
    const d = op & 0xff;
    void d;

    switch (op & 0xf000) {
      case 0x0000: this.op0000(op, n, m); break;
      case 0x1000: this.op0001(op, n, m); break;
      case 0x2000: this.op0010(op, n, m); break;
      case 0x3000: this.op0011(op, n, m); break;
      case 0x4000: this.op0100(op, n, m); break;
      case 0x5000: this.op0101(op, n, m); break;
      case 0x6000: this.op0110(op, n, m); break;
      case 0x7000: this.op0111(op, n, m); break;
      case 0x8000: this.op1000(op, n, m); break;
      case 0x9000: this.op1001(op, n, m); break;
      case 0xa000: this.op1010(op, n, m); break;
      case 0xb000: this.op1011(op, n, m); break;
      case 0xc000: this.op1100(op, n, m); break;
      case 0xd000: this.op1101(op, n, m); break;
      case 0xe000: this.op1110(op, n, m); break;
      default: this.op1111(op, n, m); break;
    }
  }

  // ---- inline helpers (port of the SH2_INLINE C functions) ----
  private charge(cycles: number): void { this.icount -= cycles; this.totalCycles += cycles; }

  private add(m: number, n: number): void { this.r[n] = s32(this.r[n]! + this.r[m]!); }
  private addi(i: number, n: number): void { this.r[n] = s32(this.r[n]! + s8(i)); }
  private addc(m: number, n: number): void {
    const tmp1 = u32(this.r[n]! + this.r[m]!);
    const tmp0 = u32(this.r[n]!);
    this.r[n] = s32(tmp1 + (this.sr & SR_T));
    if (tmp0 > tmp1) this.sr |= SR_T; else this.sr &= ~SR_T;
    if (tmp1 > u32(this.r[n]!)) this.sr |= SR_T;
  }
  private addv(m: number, n: number): void {
    const dest = this.r[n]! >= 0 ? 0 : 1;
    let src = this.r[m]! >= 0 ? 0 : 1;
    src += dest;
    this.r[n] = s32(this.r[n]! + this.r[m]!);
    const ans = this.r[n]! >= 0 ? 0 : 1;
    const ans2 = ans + dest;
    if (src === 0 || src === 2) {
      if (ans2 === 1) this.sr |= SR_T; else this.sr &= ~SR_T;
    } else this.sr &= ~SR_T;
  }
  private and(m: number, n: number): void { this.r[n] = s32(this.r[n]! & this.r[m]!); }
  private andi(i: number): void { this.r[0] = s32(this.r[0]! & i); }
  private andm(i: number): void {
    this.ea = u32(this.gbr + this.r[0]!);
    const temp = i & this.rb(this.ea);
    this.wb(this.ea, temp);
    this.charge(2);
  }
  private bf(dd: number): void {
    if ((this.sr & SR_T) === 0) {
      const disp = s8(dd);
      this.pc = this.ea = u32(this.pc + disp * 2 + 2);
      this.charge(2);
    }
  }
  private bfs(dd: number): void {
    if ((this.sr & SR_T) === 0) {
      const disp = s8(dd);
      this.delay = this.pc;
      this.pc = this.ea = u32(this.pc + disp * 2 + 2);
      this.charge(1);
    }
  }
  private bra(x: number): void {
    const disp = (s32(x << 20)) >> 20;
    this.delay = this.pc;
    this.pc = this.ea = u32(this.pc + disp * 2 + 2);
    this.charge(1);
  }
  private braf(m: number): void {
    this.delay = this.pc;
    this.pc = u32(this.pc + this.r[m]! + 2);
    this.charge(1);
  }
  private bsr(x: number): void {
    const disp = (s32(x << 20)) >> 20;
    this.pr = this.pc + 2;
    this.delay = this.pc;
    this.pc = this.ea = u32(this.pc + disp * 2 + 2);
    this.charge(1);
  }
  private bsrf(m: number): void {
    this.pr = this.pc + 2;
    this.delay = this.pc;
    this.pc = u32(this.pc + this.r[m]! + 2);
    this.charge(1);
  }
  private bt(dd: number): void {
    if ((this.sr & SR_T) !== 0) {
      const disp = s8(dd);
      this.pc = this.ea = u32(this.pc + disp * 2 + 2);
      this.charge(2);
    }
  }
  private bts(dd: number): void {
    if ((this.sr & SR_T) !== 0) {
      const disp = s8(dd);
      this.delay = this.pc;
      this.pc = this.ea = u32(this.pc + disp * 2 + 2);
      this.charge(1);
    }
  }
  private clrmac(): void { this.mach = 0; this.macl = 0; }
  private clrt(): void { this.sr &= ~SR_T; }
  private cmpeq(m: number, n: number): void {
    if (this.r[n]! === this.r[m]!) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private cmpge(m: number, n: number): void {
    if (this.r[n]! >= this.r[m]!) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private cmpgt(m: number, n: number): void {
    if (this.r[n]! > this.r[m]!) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private cmphi(m: number, n: number): void {
    if (u32(this.r[n]!) > u32(this.r[m]!)) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private cmphs(m: number, n: number): void {
    if (u32(this.r[n]!) >= u32(this.r[m]!)) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private cmppl(n: number): void {
    if (this.r[n]! > 0) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private cmppz(n: number): void {
    if (this.r[n]! >= 0) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private cmpstr(m: number, n: number): void {
    const temp = u32(this.r[n]! ^ this.r[m]!);
    const HH = (temp >> 24) & 0xff, HL = (temp >> 16) & 0xff;
    const LH = (temp >> 8) & 0xff, LL = temp & 0xff;
    if (HH && HL && LH && LL) this.sr &= ~SR_T; else this.sr |= SR_T;
  }
  private cmpim(i: number): void {
    const imm = u32(s8(i));
    if (u32(this.r[0]!) === imm) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private div0s(m: number, n: number): void {
    if ((this.r[n]! & 0x80000000) === 0) this.sr &= ~SR_Q; else this.sr |= SR_Q;
    if ((this.r[m]! & 0x80000000) === 0) this.sr &= ~SR_M; else this.sr |= SR_M;
    if ((this.r[m]! ^ this.r[n]!) & 0x80000000) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private div0u(): void { this.sr &= ~(SR_M | SR_Q | SR_T); }
  private div1(m: number, n: number): void {
    const old_q = this.sr & SR_Q;
    if (0x80000000 & this.r[n]!) this.sr |= SR_Q; else this.sr &= ~SR_Q;
    this.r[n] = s32(u32(this.r[n]! << 1) | (this.sr & SR_T));
    let tmp0: number;
    if (!old_q) {
      if (!(this.sr & SR_M)) {
        tmp0 = this.r[n]!;
        this.r[n] = s32(this.r[n]! - this.r[m]!);
        if (!(this.sr & SR_Q)) {
          if (this.r[n]! > tmp0) this.sr |= SR_Q; else this.sr &= ~SR_Q;
        } else {
          if (this.r[n]! > tmp0) this.sr &= ~SR_Q; else this.sr |= SR_Q;
        }
      } else {
        tmp0 = this.r[n]!;
        this.r[n] = s32(this.r[n]! + this.r[m]!);
        if (!(this.sr & SR_Q)) {
          if (this.r[n]! < tmp0) this.sr &= ~SR_Q; else this.sr |= SR_Q;
        } else {
          if (this.r[n]! < tmp0) this.sr |= SR_Q; else this.sr &= ~SR_Q;
        }
      }
    } else {
      if (!(this.sr & SR_M)) {
        tmp0 = this.r[n]!;
        this.r[n] = s32(this.r[n]! + this.r[m]!);
        if (!(this.sr & SR_Q)) {
          if (this.r[n]! < tmp0) this.sr |= SR_Q; else this.sr &= ~SR_Q;
        } else {
          if (this.r[n]! < tmp0) this.sr &= ~SR_Q; else this.sr |= SR_Q;
        }
      } else {
        tmp0 = this.r[n]!;
        this.r[n] = s32(this.r[n]! - this.r[m]!);
        if (!(this.sr & SR_Q)) {
          if (this.r[n]! > tmp0) this.sr &= ~SR_Q; else this.sr |= SR_Q;
        } else {
          if (this.r[n]! > tmp0) this.sr |= SR_Q; else this.sr &= ~SR_Q;
        }
      }
    }
    tmp0 = this.sr & (SR_Q | SR_M);
    if (!tmp0 || tmp0 === 0x300) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private dmuls(m: number, n: number): void {
    let tempn = this.r[n]!;
    let tempm = this.r[m]!;
    const fnLmL = (this.r[n]! ^ this.r[m]!) < 0 ? -1 : 0;
    if (tempn < 0) tempn = 0 - tempn;
    if (tempm < 0) tempm = 0 - tempm;
    let temp1 = u32(tempn);
    let temp2 = u32(tempm);
    const RnL = temp1 & 0xffff, RnH = (temp1 >> 16) & 0xffff;
    const RmL = temp2 & 0xffff, RmH = (temp2 >> 16) & 0xffff;
    const temp0 = RmL * RnL;
    temp1 = RmH * RnL;
    temp2 = RmL * RnH;
    const temp3 = RmH * RnH;
    let Res2 = 0;
    const Res1 = temp1 + temp2;
    if (Res1 < temp1) Res2 += 0x00010000;
    temp1 = (Res1 << 16) & 0xffff0000;
    let Res0 = temp0 + temp1;
    if (Res0 < temp0) Res2++;
    Res2 = Res2 + ((Res1 >> 16) & 0x0000ffff) + temp3;
    if (fnLmL < 0) {
      Res2 = ~Res2;
      if (Res0 === 0) Res2++;
      else Res0 = (~Res0) + 1;
    }
    this.mach = s32(Res2);
    this.macl = s32(Res0);
    this.charge(1);
  }
  private dmulu(m: number, n: number): void {
    const RnL = this.r[n]! & 0xffff, RnH = (this.r[n]! >>> 16) & 0xffff;
    const RmL = this.r[m]! & 0xffff, RmH = (this.r[m]! >>> 16) & 0xffff;
    const temp0 = RmL * RnL;
    let temp1 = RmH * RnL;
    const temp2 = RmL * RnH;
    const temp3 = RmH * RnH;
    let Res2 = 0;
    const Res1 = temp1 + temp2;
    if (Res1 < temp1) Res2 += 0x00010000;
    temp1 = (Res1 << 16) & 0xffff0000;
    const Res0 = temp0 + temp1;
    if (Res0 < temp0) Res2++;
    Res2 = Res2 + ((Res1 >> 16) & 0x0000ffff) + temp3;
    this.mach = s32(Res2);
    this.macl = s32(Res0);
    this.charge(1);
  }
  private dt(n: number): void {
    this.r[n] = s32(this.r[n]! - 1);
    if (this.r[n]! === 0) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private extsb(m: number, n: number): void { this.r[n] = s32((this.r[m]! << 24) >> 24); }
  private extsw(m: number, n: number): void { this.r[n] = s32((this.r[m]! << 16) >> 16); }
  private extub(m: number, n: number): void { this.r[n] = this.r[m]! & 0xff; }
  private extuw(m: number, n: number): void { this.r[n] = this.r[m]! & 0xffff; }
  private jmp(m: number): void {
    this.delay = this.pc;
    this.pc = this.ea = u32(this.r[m]!);
  }
  private jsr(m: number): void {
    this.delay = this.pc;
    this.pr = this.pc + 2;
    this.pc = this.ea = u32(this.r[m]!);
    this.charge(1);
  }
  private ldcsr(m: number): void {
    this.sr = this.r[m]! & SR_FLAGS;
    this.testIrq = true;
  }
  private ldcgbr(m: number): void { this.gbr = this.r[m]!; }
  private ldcvbr(m: number): void { this.vbr = this.r[m]!; }
  private ldcmsr(m: number): void {
    this.ea = this.r[m]!;
    this.sr = this.rl(this.ea) & SR_FLAGS;
    this.r[m] = s32(this.r[m]! + 4);
    this.charge(2);
    this.testIrq = true;
  }
  private ldcmgbr(m: number): void {
    this.ea = this.r[m]!;
    this.gbr = this.rl(this.ea);
    this.r[m] = s32(this.r[m]! + 4);
    this.charge(2);
  }
  private ldcmvbr(m: number): void {
    this.ea = this.r[m]!;
    this.vbr = this.rl(this.ea);
    this.r[m] = s32(this.r[m]! + 4);
    this.charge(2);
  }
  private ldsmach(m: number): void { this.mach = this.r[m]!; }
  private ldsmacl(m: number): void { this.macl = this.r[m]!; }
  private ldspr(m: number): void { this.pr = this.r[m]!; }
  private ldsmmach(m: number): void {
    this.ea = this.r[m]!;
    this.mach = this.rl(this.ea);
    this.r[m] = s32(this.r[m]! + 4);
  }
  private ldsmmacl(m: number): void {
    this.ea = this.r[m]!;
    this.macl = this.rl(this.ea);
    this.r[m] = s32(this.r[m]! + 4);
  }
  private ldsmpr(m: number): void {
    this.ea = this.r[m]!;
    this.pr = this.rl(this.ea);
    this.r[m] = s32(this.r[m]! + 4);
  }
  private mac_l(m: number, n: number): void {
    let tempn = this.rl(this.r[n]!);
    this.r[n] = s32(this.r[n]! + 4);
    let tempm = this.rl(this.r[m]!);
    this.r[m] = s32(this.r[m]! + 4);
    const fnLmL = (s32(tempn) ^ s32(tempm)) < 0 ? -1 : 0;
    if (s32(tempn) < 0) tempn = 0 - tempn;
    if (s32(tempm) < 0) tempm = 0 - tempm;
    let temp1 = u32(tempn);
    let temp2 = u32(tempm);
    const RnL = temp1 & 0xffff, RnH = (temp1 >> 16) & 0xffff;
    const RmL = temp2 & 0xffff, RmH = (temp2 >> 16) & 0xffff;
    const temp0 = RmL * RnL;
    temp1 = RmH * RnL;
    temp2 = RmL * RnH;
    const temp3 = RmH * RnH;
    let Res2 = 0;
    const Res1 = temp1 + temp2;
    if (Res1 < temp1) Res2 += 0x00010000;
    temp1 = (Res1 << 16) & 0xffff0000;
    let Res0 = temp0 + temp1;
    if (Res0 < temp0) Res2++;
    Res2 = Res2 + ((Res1 >> 16) & 0x0000ffff) + temp3;
    if (fnLmL < 0) {
      Res2 = ~Res2;
      if (Res0 === 0) Res2++;
      else Res0 = (~Res0) + 1;
    }
    if (this.sr & SR_S) {
      Res0 = this.macl + Res0;
      if (this.macl > Res0) Res2++;
      Res2 += (this.mach & 0xffff);
      if (s32(Res2) < 0 && Res2 < 0xffff8000) { Res2 = 0x00008000; Res0 = 0; }
      else if (s32(Res2) > 0 && Res2 > 0x00007fff) { Res2 = 0x00007fff; Res0 = 0xffffffff; }
      this.mach = s32(Res2);
      this.macl = s32(Res0);
    } else {
      Res0 = this.macl + Res0;
      if (this.macl > Res0) Res2++;
      Res2 += this.mach;
      this.mach = s32(Res2);
      this.macl = s32(Res0);
    }
    this.charge(2);
  }
  private mac_w(m: number, n: number): void {
    const tempn = this.rw(this.r[n]!);
    this.r[n] = s32(this.r[n]! + 2);
    const tempm = this.rw(this.r[m]!);
    this.r[m] = s32(this.r[m]! + 2);
    const templ = this.macl;
    const tempm16 = s16(tempn) * s16(tempm);
    const dest = this.macl >= 0 ? 0 : 1;
    let src: number, tempnX: number;
    if (s32(tempm16) >= 0) { src = 0; tempnX = 0; }
    else { src = 1; tempnX = 0xffffffff; }
    src += dest;
    this.macl = s32(this.macl + tempm16);
    const ans = this.macl >= 0 ? 0 : 1;
    const ans2 = ans + dest;
    if (this.sr & SR_S) {
      if (ans2 === 1) {
        if (src === 0) this.macl = 0x7fffffff;
        if (src === 2) this.macl = 0x80000000;
      }
    } else {
      this.mach = s32(this.mach + tempnX);
      if (templ > this.macl) this.mach = s32(this.mach + 1);
    }
    this.charge(2);
  }
  private mov(m: number, n: number): void { this.r[n] = this.r[m]!; }
  private movbs(m: number, n: number): void {
    this.ea = this.r[n]!;
    this.wb(this.ea, this.r[m]! & 0xff);
  }
  private movws(m: number, n: number): void {
    this.ea = this.r[n]!;
    this.ww(this.ea, this.r[m]! & 0xffff);
  }
  private movls(m: number, n: number): void {
    this.ea = this.r[n]!;
    this.wl(this.ea, this.r[m]!);
  }
  private movbl(m: number, n: number): void {
    this.ea = this.r[m]!;
    this.r[n] = s8(this.rb(this.ea));
  }
  private movwl(m: number, n: number): void {
    this.ea = this.r[m]!;
    this.r[n] = s16(this.rw(this.ea));
  }
  private movll(m: number, n: number): void {
    this.ea = this.r[m]!;
    this.r[n] = this.rl(this.ea);
  }
  private movbm(m: number, n: number): void {
    const data = this.r[m]! & 0xff;
    this.r[n] = s32(this.r[n]! - 1);
    this.wb(this.r[n]!, data);
  }
  private movwm(m: number, n: number): void {
    const data = this.r[m]! & 0xffff;
    this.r[n] = s32(this.r[n]! - 2);
    this.ww(this.r[n]!, data);
  }
  private movlm(m: number, n: number): void {
    const data = this.r[m]!;
    this.r[n] = s32(this.r[n]! - 4);
    this.wl(this.r[n]!, data);
  }
  private movbp(m: number, n: number): void {
    this.r[n] = s8(this.rb(this.r[m]!));
    if (n !== m) this.r[m] = s32(this.r[m]! + 1);
  }
  private movwp(m: number, n: number): void {
    this.r[n] = s16(this.rw(this.r[m]!));
    if (n !== m) this.r[m] = s32(this.r[m]! + 2);
  }
  private movlp(m: number, n: number): void {
    this.r[n] = this.rl(this.r[m]!);
    if (n !== m) this.r[m] = s32(this.r[m]! + 4);
  }
  private movbs0(m: number, n: number): void {
    this.ea = u32(this.r[n]! + this.r[0]!);
    this.wb(this.ea, this.r[m]! & 0xff);
  }
  private movws0(m: number, n: number): void {
    this.ea = u32(this.r[n]! + this.r[0]!);
    this.ww(this.ea, this.r[m]! & 0xffff);
  }
  private movls0(m: number, n: number): void {
    this.ea = u32(this.r[n]! + this.r[0]!);
    this.wl(this.ea, this.r[m]!);
  }
  private movbl0(m: number, n: number): void {
    this.ea = u32(this.r[m]! + this.r[0]!);
    this.r[n] = s8(this.rb(this.ea));
  }
  private movwl0(m: number, n: number): void {
    this.ea = u32(this.r[m]! + this.r[0]!);
    this.r[n] = s16(this.rw(this.ea));
  }
  private movll0(m: number, n: number): void {
    this.ea = u32(this.r[m]! + this.r[0]!);
    this.r[n] = this.rl(this.ea);
  }
  private movi(i: number, n: number): void { this.r[n] = s8(i); }
  private movwi(x: number, n: number): void {
    const disp = x & 0xff;
    this.ea = u32(this.pc + disp * 2 + 2);
    this.r[n] = s16(this.rw(this.ea));
  }
  private movli(x: number, n: number): void {
    const disp = x & 0xff;
    this.ea = u32(((this.pc + 2) & ~3) + disp * 4);
    this.r[n] = this.rl(this.ea);
  }
  private movblg(x: number): void {
    const disp = x & 0xff;
    this.ea = u32(this.gbr + disp);
    this.r[0] = s8(this.rb(this.ea));
  }
  private movwlg(x: number): void {
    const disp = x & 0xff;
    this.ea = u32(this.gbr + disp * 2);
    this.r[0] = s16(this.rw(this.ea));
  }
  private movllg(x: number): void {
    const disp = x & 0xff;
    this.ea = u32(this.gbr + disp * 4);
    this.r[0] = this.rl(this.ea);
  }
  private movbsg(x: number): void {
    const disp = x & 0xff;
    this.ea = u32(this.gbr + disp);
    this.wb(this.ea, this.r[0]! & 0xff);
  }
  private movwsg(x: number): void {
    const disp = x & 0xff;
    this.ea = u32(this.gbr + disp * 2);
    this.ww(this.ea, this.r[0]! & 0xffff);
  }
  private movlsg(x: number): void {
    const disp = x & 0xff;
    this.ea = u32(this.gbr + disp * 4);
    this.wl(this.ea, this.r[0]!);
  }
  private movbs4(x: number, n: number): void {
    const disp = x & 0x0f;
    this.ea = u32(this.r[n]! + disp);
    this.wb(this.ea, this.r[0]! & 0xff);
  }
  private movws4(x: number, n: number): void {
    const disp = x & 0x0f;
    this.ea = u32(this.r[n]! + disp * 2);
    this.ww(this.ea, this.r[0]! & 0xffff);
  }
  private movls4(m: number, x: number, n: number): void {
    const disp = x & 0x0f;
    this.ea = u32(this.r[n]! + disp * 4);
    this.wl(this.ea, this.r[m]!);
  }
  private movbl4(m: number, x: number): void {
    const disp = x & 0x0f;
    this.ea = u32(this.r[m]! + disp);
    this.r[0] = s8(this.rb(this.ea));
  }
  private movwl4(m: number, x: number): void {
    const disp = x & 0x0f;
    this.ea = u32(this.r[m]! + disp * 2);
    this.r[0] = s16(this.rw(this.ea));
  }
  private movll4(m: number, x: number, n: number): void {
    const disp = x & 0x0f;
    this.ea = u32(this.r[m]! + disp * 4);
    this.r[n] = this.rl(this.ea);
  }
  private mova(x: number): void {
    const disp = x & 0xff;
    this.ea = u32(((this.pc + 2) & ~3) + disp * 4);
    this.r[0] = this.ea;
  }
  private movt(n: number): void { this.r[n] = this.sr & SR_T; }
  private mull(m: number, n: number): void {
    this.macl = Math.imul(this.r[n]!, this.r[m]!);
    this.charge(1);
  }
  private muls(m: number, n: number): void {
    this.macl = s16(this.r[n]!) * s16(this.r[m]!);
  }
  private mulu(m: number, n: number): void {
    this.macl = (this.r[n]! & 0xffff) * (this.r[m]! & 0xffff);
  }
  private neg(m: number, n: number): void { this.r[n] = s32(0 - this.r[m]!); }
  private negc(m: number, n: number): void {
    const temp = this.r[m]!;
    this.r[n] = s32(-temp - (this.sr & SR_T));
    if (temp || (this.sr & SR_T)) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private not(m: number, n: number): void { this.r[n] = s32(~this.r[m]!); }
  private or(m: number, n: number): void { this.r[n] = s32(this.r[n]! | this.r[m]!); }
  private ori(i: number): void { this.r[0] = this.r[0]! | i; }
  private orm(i: number): void {
    this.ea = u32(this.gbr + this.r[0]!);
    let temp = this.rb(this.ea);
    temp |= i;
    this.wb(this.ea, temp);
    this.charge(2);
  }
  private rotcl(n: number): void {
    const temp = (this.r[n]! >>> 31) & SR_T;
    this.r[n] = s32(u32(this.r[n]! << 1) | (this.sr & SR_T));
    this.sr = (this.sr & ~SR_T) | temp;
  }
  private rotcr(n: number): void {
    const temp = (this.sr & SR_T) << 31;
    if (this.r[n]! & SR_T) this.sr |= SR_T; else this.sr &= ~SR_T;
    this.r[n] = s32((this.r[n]! >>> 1) | temp);
  }
  private rotl(n: number): void {
    this.sr = (this.sr & ~SR_T) | ((this.r[n]! >>> 31) & SR_T);
    this.r[n] = s32(u32(this.r[n]! << 1) | (this.r[n]! >>> 31));
  }
  private rotr(n: number): void {
    this.sr = (this.sr & ~SR_T) | (this.r[n]! & SR_T);
    this.r[n] = s32((this.r[n]! >>> 1) | (this.r[n]! << 31));
  }
  private rte(): void {
    this.ea = this.r[15]!;
    this.delay = this.pc;
    this.pc = this.rl(this.ea);
    this.r[15] = s32(this.r[15]! + 4);
    this.ea = this.r[15]!;
    this.sr = this.rl(this.ea) & SR_FLAGS;
    this.r[15] = s32(this.r[15]! + 4);
    this.charge(3);
    this.testIrq = true;
  }
  private rts(): void {
    this.delay = this.pc;
    this.pc = this.ea = this.pr;
    this.charge(1);
  }
  private sett(): void { this.sr |= SR_T; }
  private shal(n: number): void {
    this.sr = (this.sr & ~SR_T) | ((this.r[n]! >>> 31) & SR_T);
    this.r[n] = s32(this.r[n]! << 1);
  }
  private shar(n: number): void {
    this.sr = (this.sr & ~SR_T) | (this.r[n]! & SR_T);
    this.r[n] = this.r[n]! >> 1;
  }
  private shll(n: number): void {
    this.sr = (this.sr & ~SR_T) | ((this.r[n]! >>> 31) & SR_T);
    this.r[n] = s32(this.r[n]! << 1);
  }
  private shll2(n: number): void { this.r[n] = s32(this.r[n]! << 2); }
  private shll8(n: number): void { this.r[n] = s32(this.r[n]! << 8); }
  private shll16(n: number): void { this.r[n] = s32(this.r[n]! << 16); }
  private shlr(n: number): void {
    this.sr = (this.sr & ~SR_T) | (this.r[n]! & SR_T);
    this.r[n] = this.r[n]! >>> 1;
  }
  private shlr2(n: number): void { this.r[n] = this.r[n]! >>> 2; }
  private shlr8(n: number): void { this.r[n] = this.r[n]! >>> 8; }
  private shlr16(n: number): void { this.r[n] = this.r[n]! >>> 16; }
  private sleep(): void {
    this.pc -= 2;
    this.charge(2);
  }
  private stcsr(n: number): void { this.r[n] = this.sr; }
  private stcgbr(n: number): void { this.r[n] = this.gbr; }
  private stcvbr(n: number): void { this.r[n] = this.vbr; }
  private stcmsr(n: number): void {
    this.r[n] = s32(this.r[n]! - 4);
    this.ea = this.r[n]!;
    this.wl(this.ea, this.sr);
    this.charge(1);
  }
  private stcmgbr(n: number): void {
    this.r[n] = s32(this.r[n]! - 4);
    this.ea = this.r[n]!;
    this.wl(this.ea, this.gbr);
    this.charge(1);
  }
  private stcmvbr(n: number): void {
    this.r[n] = s32(this.r[n]! - 4);
    this.ea = this.r[n]!;
    this.wl(this.ea, this.vbr);
    this.charge(1);
  }
  private stsmach(n: number): void { this.r[n] = this.mach; }
  private stsmacl(n: number): void { this.r[n] = this.macl; }
  private stspr(n: number): void { this.r[n] = this.pr; }
  private stsmmach(n: number): void {
    this.r[n] = s32(this.r[n]! - 4);
    this.ea = this.r[n]!;
    this.wl(this.ea, this.mach);
  }
  private stsmmacl(n: number): void {
    this.r[n] = s32(this.r[n]! - 4);
    this.ea = this.r[n]!;
    this.wl(this.ea, this.macl);
  }
  private stsmpr(n: number): void {
    this.r[n] = s32(this.r[n]! - 4);
    this.ea = this.r[n]!;
    this.wl(this.ea, this.pr);
  }
  private sub(m: number, n: number): void { this.r[n] = s32(this.r[n]! - this.r[m]!); }
  private subc(m: number, n: number): void {
    const tmp1 = u32(this.r[n]! - this.r[m]!);
    const tmp0 = u32(this.r[n]!);
    this.r[n] = s32(tmp1 - (this.sr & SR_T));
    if (tmp0 < tmp1) this.sr |= SR_T; else this.sr &= ~SR_T;
    if (tmp1 < u32(this.r[n]!)) this.sr |= SR_T;
  }
  private subv(m: number, n: number): void {
    const dest = this.r[n]! >= 0 ? 0 : 1;
    let src = this.r[m]! >= 0 ? 0 : 1;
    src += dest;
    this.r[n] = s32(this.r[n]! - this.r[m]!);
    const ans = this.r[n]! >= 0 ? 0 : 1;
    const ans2 = ans + dest;
    if (src === 1) {
      if (ans2 === 1) this.sr |= SR_T; else this.sr &= ~SR_T;
    } else this.sr &= ~SR_T;
  }
  private swapb(m: number, n: number): void {
    const temp0 = this.r[m]! & 0xffff0000;
    const temp1 = (this.r[m]! & 0x000000ff) << 8;
    this.r[n] = (this.r[m]! >>> 8) & 0x000000ff;
    this.r[n] = s32(this.r[n]! | temp1 | temp0);
  }
  private swapw(m: number, n: number): void {
    const temp = (this.r[m]! >>> 16) & 0x0000ffff;
    this.r[n] = s32(u32(this.r[m]! << 16) | temp);
  }
  private tas(n: number): void {
    this.ea = this.r[n]!;
    let temp = this.rb(this.ea);
    if (temp === 0) this.sr |= SR_T; else this.sr &= ~SR_T;
    temp |= 0x80;
    this.wb(this.ea, temp);
    this.charge(3);
  }
  private trapa(i: number): void {
    const imm = i & 0xff;
    this.ea = u32(this.vbr + imm * 4);
    this.r[15] = s32(this.r[15]! - 4);
    this.wl(this.r[15]!, this.sr);
    this.r[15] = s32(this.r[15]! - 4);
    this.wl(this.r[15]!, this.pc);
    this.pc = this.rl(this.ea);
    this.charge(7);
  }
  private tst(m: number, n: number): void {
    if ((this.r[n]! & this.r[m]!) === 0) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private tsti(i: number): void {
    const imm = i & 0xff;
    if ((imm & this.r[0]!) === 0) this.sr |= SR_T; else this.sr &= ~SR_T;
  }
  private tstm(i: number): void {
    const imm = i & 0xff;
    this.ea = u32(this.gbr + this.r[0]!);
    if ((imm & this.rb(this.ea)) === 0) this.sr |= SR_T; else this.sr &= ~SR_T;
    this.charge(2);
  }
  private xor(m: number, n: number): void { this.r[n] = s32(this.r[n]! ^ this.r[m]!); }
  private xori(i: number): void {
    const imm = i & 0xff;
    this.r[0] = s32(this.r[0]! ^ imm);
  }
  private xorm(i: number): void {
    const imm = i & 0xff;
    this.ea = u32(this.gbr + this.r[0]!);
    let temp = this.rb(this.ea);
    temp ^= imm;
    this.wb(this.ea, temp);
    this.charge(2);
  }
  private xtrct(m: number, n: number): void {
    const temp = (this.r[m]! << 16) & 0xffff0000;
    this.r[n] = (this.r[n]! >>> 16) & 0x0000ffff;
    this.r[n] = s32(this.r[n]! | temp);
  }

  // ---- opcode dispatchers (port of op0000..op1111) ----
  private op0000(op: number, n: number, m: number): void {
    switch (op & 0x3f) {
      case 0x00: case 0x01: break; // nop
      case 0x02: this.stcsr(n); break;
      case 0x03: this.bsrf(m); break;
      case 0x04: this.movbs0(m, n); break;
      case 0x05: this.movws0(m, n); break;
      case 0x06: this.movls0(m, n); break;
      case 0x07: this.mull(m, n); break;
      case 0x08: this.clrt(); break;
      case 0x09: break; // nop
      case 0x0a: this.stsmach(n); break;
      case 0x0b: this.rts(); break;
      case 0x0c: this.movbl0(m, n); break;
      case 0x0d: this.movwl0(m, n); break;
      case 0x0e: this.movll0(m, n); break;
      case 0x0f: this.mac_l(m, n); break;
      case 0x10: case 0x11: break; // nop
      case 0x12: this.stcgbr(n); break;
      case 0x13: break;
      case 0x14: this.movbs0(m, n); break;
      case 0x15: this.movws0(m, n); break;
      case 0x16: this.movls0(m, n); break;
      case 0x17: this.mull(m, n); break;
      case 0x18: this.sett(); break;
      case 0x19: this.div0u(); break;
      case 0x1a: this.stsmacl(n); break;
      case 0x1b: this.sleep(); break;
      case 0x1c: this.movbl0(m, n); break;
      case 0x1d: this.movwl0(m, n); break;
      case 0x1e: this.movll0(m, n); break;
      case 0x1f: this.mac_l(m, n); break;
      case 0x20: case 0x21: break;
      case 0x22: this.stcvbr(n); break;
      case 0x23: this.braf(m); break;
      case 0x24: this.movbs0(m, n); break;
      case 0x25: this.movws0(m, n); break;
      case 0x26: this.movls0(m, n); break;
      case 0x27: this.mull(m, n); break;
      case 0x28: this.clrmac(); break;
      case 0x29: this.movt(n); break;
      case 0x2a: this.stspr(n); break;
      case 0x2b: this.rte(); break;
      case 0x2c: this.movbl0(m, n); break;
      case 0x2d: this.movwl0(m, n); break;
      case 0x2e: this.movll0(m, n); break;
      case 0x2f: this.mac_l(m, n); break;
      case 0x30: case 0x31: case 0x32: case 0x33: break;
      case 0x34: this.movbs0(m, n); break;
      case 0x35: this.movws0(m, n); break;
      case 0x36: this.movls0(m, n); break;
      case 0x37: this.mull(m, n); break;
      case 0x38: case 0x39: case 0x3a: case 0x3b: break;
      case 0x3c: this.movbl0(m, n); break;
      case 0x3d: this.movwl0(m, n); break;
      case 0x3e: this.movll0(m, n); break;
      case 0x3f: this.mac_l(m, n); break;
    }
  }
  private op0001(op: number, n: number, m: number): void {
    this.movls4(m, op & 0x0f, n);
  }
  private op0010(op: number, n: number, m: number): void {
    switch (op & 15) {
      case 0: this.movbs(m, n); break;
      case 1: this.movws(m, n); break;
      case 2: this.movls(m, n); break;
      case 3: break;
      case 4: this.movbm(m, n); break;
      case 5: this.movwm(m, n); break;
      case 6: this.movlm(m, n); break;
      case 7: this.div0s(m, n); break;
      case 8: this.tst(m, n); break;
      case 9: this.and(m, n); break;
      case 10: this.xor(m, n); break;
      case 11: this.or(m, n); break;
      case 12: this.cmpstr(m, n); break;
      case 13: this.xtrct(m, n); break;
      case 14: this.mulu(m, n); break;
      case 15: this.muls(m, n); break;
    }
  }
  private op0011(op: number, n: number, m: number): void {
    switch (op & 15) {
      case 0: this.cmpeq(m, n); break;
      case 1: break;
      case 2: this.cmphs(m, n); break;
      case 3: this.cmpge(m, n); break;
      case 4: this.div1(m, n); break;
      case 5: this.dmulu(m, n); break;
      case 6: this.cmphi(m, n); break;
      case 7: this.cmpgt(m, n); break;
      case 8: this.sub(m, n); break;
      case 9: break;
      case 10: this.subc(m, n); break;
      case 11: this.subv(m, n); break;
      case 12: this.add(m, n); break;
      case 13: this.dmuls(m, n); break;
      case 14: this.addc(m, n); break;
      case 15: this.addv(m, n); break;
    }
  }
  private op0100(op: number, n: number, m: number): void {
    // Register-field placement per the SH-2 manual:
    //   - n (bits 11-8): shifts/rotates/div/DT/CMP/TAS/JMP/JSR and the
    //     decrement stores (STS.L */STC.L @-Rn).
    //   - m (bits 7-4): the load-from-memory family — LDS.L @Rm+ / LDC.L
    //     @Rm+ / LDS Rm / LDC Rm (e.g. LDC.L @Rm+,SR = 0100mmmm00000111).
    switch (op & 0x3f) {
      case 0x00: this.shll(n); break;
      case 0x01: this.shlr(n); break;
      case 0x02: this.stsmmach(n); break;
      case 0x03: this.stcmsr(n); break;
      case 0x04: this.rotl(n); break;
      case 0x05: this.rotr(n); break;
      case 0x06: this.ldsmmach(m); break;
      case 0x07: this.ldcmsr(m); break;
      case 0x08: this.shll2(n); break;
      case 0x09: this.shlr2(n); break;
      case 0x0a: this.ldsmach(m); break;
      case 0x0b: this.jsr(n); break;
      case 0x0c: case 0x0d: break;
      case 0x0e: this.ldcsr(m); break;
      case 0x0f: this.mac_w(m, n); break;
      case 0x10: this.dt(n); break;
      case 0x11: this.cmppz(n); break;
      case 0x12: this.stsmmacl(n); break;
      case 0x13: this.stcmgbr(n); break;
      case 0x14: break;
      case 0x15: this.cmppl(n); break;
      case 0x16: this.ldsmmacl(m); break;
      case 0x17: this.ldcmgbr(m); break;
      case 0x18: this.shll8(n); break;
      case 0x19: this.shlr8(n); break;
      case 0x1a: this.ldsmacl(m); break;
      case 0x1b: this.tas(n); break;
      case 0x1c: case 0x1d: break;
      case 0x1e: this.ldcgbr(m); break;
      case 0x1f: this.mac_w(m, n); break;
      case 0x20: this.shal(n); break;
      case 0x21: this.shar(n); break;
      case 0x22: this.stsmpr(n); break;
      case 0x23: this.stcmvbr(n); break;
      case 0x24: this.rotcl(n); break;
      case 0x25: this.rotcr(n); break;
      case 0x26: this.ldsmpr(m); break;
      case 0x27: this.ldcmvbr(m); break;
      case 0x28: this.shll16(n); break;
      case 0x29: this.shlr16(n); break;
      case 0x2a: this.ldspr(m); break;
      case 0x2b: this.jmp(n); break;
      case 0x2c: case 0x2d: break;
      case 0x2e: this.ldcvbr(m); break;
      case 0x2f: this.mac_w(m, n); break;
      case 0x30: case 0x31: case 0x32: case 0x33: break;
      case 0x34: case 0x35: case 0x36: case 0x37: break;
      case 0x38: case 0x39: case 0x3a: case 0x3b: break;
      case 0x3c: case 0x3d: case 0x3e: break;
      case 0x3f: this.mac_w(m, n); break;
    }
  }
  private op0101(op: number, n: number, m: number): void {
    this.movll4(m, op & 0x0f, n);
  }
  private op0110(op: number, n: number, m: number): void {
    switch (op & 15) {
      case 0: this.movbl(m, n); break;
      case 1: this.movwl(m, n); break;
      case 2: this.movll(m, n); break;
      case 3: this.mov(m, n); break;
      case 4: this.movbp(m, n); break;
      case 5: this.movwp(m, n); break;
      case 6: this.movlp(m, n); break;
      case 7: this.not(m, n); break;
      case 8: this.swapb(m, n); break;
      case 9: this.swapw(m, n); break;
      case 10: this.negc(m, n); break;
      case 11: this.neg(m, n); break;
      case 12: this.extub(m, n); break;
      case 13: this.extuw(m, n); break;
      case 14: this.extsb(m, n); break;
      case 15: this.extsw(m, n); break;
    }
  }
  private op0111(op: number, n: number, m: number): void {
    void m;
    this.addi(op & 0xff, n);
  }
  private op1000(op: number, n: number, m: number): void {
    void n;
    switch (op & (15 << 8)) {
      case 0 << 8: this.movbs4(op & 0x0f, m); break;
      case 1 << 8: this.movws4(op & 0x0f, m); break;
      case 4 << 8: this.movbl4(m, op & 0x0f); break;
      case 5 << 8: this.movwl4(m, op & 0x0f); break;
      case 8 << 8: this.cmpim(op & 0xff); break;
      case 9 << 8: this.bt(op & 0xff); break;
      case 11 << 8: this.bf(op & 0xff); break;
      case 13 << 8: this.bts(op & 0xff); break;
      case 15 << 8: this.bfs(op & 0xff); break;
      default: break;
    }
  }
  private op1001(op: number, n: number, m: number): void {
    void m;
    this.movwi(op & 0xff, n);
  }
  private op1010(op: number, n: number, m: number): void {
    void n; void m;
    this.bra(op & 0xfff);
  }
  private op1011(op: number, n: number, m: number): void {
    void n; void m;
    this.bsr(op & 0xfff);
  }
  private op1100(op: number, n: number, m: number): void {
    void n; void m;
    switch (op & (15 << 8)) {
      case 0 << 8: this.movbsg(op & 0xff); break;
      case 1 << 8: this.movwsg(op & 0xff); break;
      case 2 << 8: this.movlsg(op & 0xff); break;
      case 3 << 8: this.trapa(op & 0xff); break;
      case 4 << 8: this.movblg(op & 0xff); break;
      case 5 << 8: this.movwlg(op & 0xff); break;
      case 6 << 8: this.movllg(op & 0xff); break;
      case 7 << 8: this.mova(op & 0xff); break;
      case 8 << 8: this.tsti(op & 0xff); break;
      case 9 << 8: this.andi(op & 0xff); break;
      case 10 << 8: this.xori(op & 0xff); break;
      case 11 << 8: this.ori(op & 0xff); break;
      case 12 << 8: this.tstm(op & 0xff); break;
      case 13 << 8: this.andm(op & 0xff); break;
      case 14 << 8: this.xorm(op & 0xff); break;
      case 15 << 8: this.orm(op & 0xff); break;
    }
  }
  private op1101(op: number, n: number, m: number): void {
    void m;
    this.movli(op & 0xff, n);
  }
  private op1110(op: number, n: number, m: number): void {
    void m;
    this.movi(op & 0xff, n);
  }
  private op1111(op: number, n: number, m: number): void {
    void op; void n; void m;
    /* 0xffff = instruction (coprocessor) — treated as nop like FBNeo. */
  }
}