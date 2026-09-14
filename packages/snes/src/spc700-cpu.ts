/**
 * A real SPC700 CPU interpreter — full 64KB ARAM address space, all real
 * registers (A, X, Y, SP, PC, PSW), and instruction *execution* (not just
 * decode) for the complete real opcode set, plus the CPU-side memory-mapped
 * I/O region ($F0-$FF: DSP register port, hardware timers, main-CPU
 * communication ports).
 *
 * Fixed SNES hardware, not game-specific — shared machine knowledge across
 * every seer SNES project, the same tier as `snes-ppu.ts`/`snes-brr.ts`.
 *
 * **Ported directly from a real, proven reference implementation, not
 * derived from the opcode-encoding spec by hand**: blargg's `snes_spc`
 * (`~/Development/snes_spc/snes_spc/SPC_CPU.h` — the same lineage vendored
 * into `game_music_emu` and used by foobar2000/countless SPC players for
 * ~20 years). Every instruction's addressing-mode operand layout, flag
 * update formula (ADC/SBC's overflow-flag derivation, CMP's carry
 * convention, DAA/DAS's decimal-adjust thresholds, ADDW/SUBW/CMPW/DIV YA,X's
 * 16-bit arithmetic), and per-opcode cycle count (the packed 128-byte
 * `cycle_table`, `SNES_SPC_misc.cpp:44-59`) is transcribed from that file's
 * literal C macro/switch bodies, re-expressed as plain per-flag TypeScript
 * (not the packed `nz`/`c`-register bit tricks the C source uses for
 * performance) for clarity and lower transcription risk. Flag semantics for
 * every ALU/branch/bit-test instruction were read directly from
 * `SPC_CPU.h`'s own case bodies before being written here — not guessed from
 * generic 6502-family lore, even where they happen to agree with it.
 *
 * **Cross-checked against a second, independent real implementation**:
 * Mesen2's SPC700 core (`Core/SNES/Spc.Instructions.cpp`) for the handful
 * of instructions with genuinely ambiguous prose (BRK's vector address,
 * TCALL's vector table
 * direction, RET1 vs RETI naming) — both sources agree on every checked
 * point.
 *
 * **Timers**: real hardware ticks Timer 0/1's internal divider at 8kHz and
 * Timer 2's at 64kHz (both derived from the 1.024MHz CPU clock — standard,
 * well-documented SPC700 timer hardware, see `fullsnes.txt`), each counting
 * up to its own 8-bit target register (`0` meaning `256`) before resetting
 * and incrementing a visible 4-bit output counter; reading the output
 * register ($FD/$FE/$FF) returns and clears that counter — transcribed from
 * `SPC_CPU.h`'s `CPU_READ_TIMER` macro's own behaviour (`out = t->counter;
 * t->counter = 0`).
 *
 * **Main-CPU I/O ports ($F4-$F7)** are implemented as a passive, always-
 * inert input latch (default 0, only a harness can poke it via
 * {@link Spc700Cpu.pokePortIn}) plus a write-visible output latch — enough
 * for a driver's own tick loop to run standalone without a real 65816 on
 * the other end. A harness that bypasses the interrupt-driven "load song"
 * main-CPU handshake by placing ARAM state directly (see {@link
 * Spc700Cpu.forceCall}) never expects real port traffic at all.
 */

const CYCLE_TABLE_PACKED: readonly number[] = [
  0x28, 0x47, 0x34, 0x36, 0x26, 0x54, 0x54, 0x68, 0x48, 0x47, 0x45, 0x56, 0x55, 0x65, 0x22, 0x46, 0x28, 0x47, 0x34,
  0x36, 0x26, 0x54, 0x54, 0x74, 0x48, 0x47, 0x45, 0x56, 0x55, 0x65, 0x22, 0x38, 0x28, 0x47, 0x34, 0x36, 0x26, 0x44,
  0x54, 0x66, 0x48, 0x47, 0x45, 0x56, 0x55, 0x45, 0x22, 0x43, 0x28, 0x47, 0x34, 0x36, 0x26, 0x44, 0x54, 0x75, 0x48,
  0x47, 0x45, 0x56, 0x55, 0x55, 0x22, 0x36, 0x28, 0x47, 0x34, 0x36, 0x26, 0x54, 0x52, 0x45, 0x48, 0x47, 0x45, 0x56,
  0x55, 0x55, 0x22, 0xc5, 0x38, 0x47, 0x34, 0x36, 0x26, 0x44, 0x52, 0x44, 0x48, 0x47, 0x45, 0x56, 0x55, 0x55, 0x22,
  0x34, 0x38, 0x47, 0x45, 0x47, 0x25, 0x64, 0x52, 0x49, 0x48, 0x47, 0x56, 0x67, 0x45, 0x55, 0x22, 0x83, 0x28, 0x47,
  0x34, 0x36, 0x24, 0x53, 0x43, 0x40, 0x48, 0x47, 0x45, 0x56, 0x34, 0x54, 0x22, 0x60,
];

/** Real per-opcode cycle counts (`SNES_SPC_misc.cpp`'s unpack loop, transcribed exactly). */
export const CYCLE_TABLE: readonly number[] = (() => {
  const out = new Array<number>(256);
  for (let i = 0; i < 128; i++) {
    const n = CYCLE_TABLE_PACKED[i]!;
    out[i * 2] = n >> 4;
    out[i * 2 + 1] = n & 0x0f;
  }
  return out;
})();

const TIMER01_BASE_CYCLES = 128; // 1.024MHz / 128 = 8kHz
const TIMER2_BASE_CYCLES = 16; // 1.024MHz / 16 = 64kHz

interface TimerState {
  enabled: boolean;
  target: number; // raw 8-bit target register value (0 means 256)
  baseCycles: number;
  sub: number; // cycle accumulator toward the next divider tick
  divider: number;
  counter: number; // visible 4-bit output counter
}

function newTimer(baseCycles: number): TimerState {
  return { enabled: false, target: 0, baseCycles, sub: 0, divider: 0, counter: 0 };
}

function int8(v: number): number {
  return v & 0x80 ? v - 0x100 : v;
}

/** Complete non-ARAM CPU state, as produced by {@link Spc700Cpu.saveState}. */
export interface Spc700CpuState {
  a: number;
  x: number;
  y: number;
  sp: number;
  pc: number;
  /** Packed PSW byte (`NVPBHIZC`), the same encoding real `PUSH PSW`/`POP PSW` use. */
  psw: number;
  stopped: boolean;
  /** `$F2` — the currently selected DSP register. */
  dspAddr: number;
  /** `$F1` bit 7 — IPL ROM overlay enabled. */
  romReadable: boolean;
  portIn: Uint8Array;
  portOut: Uint8Array;
  timers: [
    { enabled: boolean; target: number; sub: number; divider: number; counter: number },
    { enabled: boolean; target: number; sub: number; divider: number; counter: number },
    { enabled: boolean; target: number; sub: number; divider: number; counter: number },
  ];
}

/** A real SPC700 CPU, executing directly against a shared 64KB ARAM buffer. */
export class Spc700Cpu {
  readonly ram: Uint8Array;

  a = 0;
  x = 0;
  y = 0;
  sp = 0;
  pc = 0;

  // PSW flags, individually -- see module doc comment on why this project
  // uses plain booleans instead of blargg's packed nz/c performance trick.
  n = false;
  v = false;
  p = false; // direct page selector: false=$00xx, true=$01xx
  b = false; // "break" flag, set by BRK, otherwise inert for this project's purposes
  h = false;
  i = false; // interrupt-enable flag -- inert here (no maskable IRQ source is modelled)
  z = true;
  c = false;

  private readonly timers: [TimerState, TimerState, TimerState] = [
    newTimer(TIMER01_BASE_CYCLES),
    newTimer(TIMER01_BASE_CYCLES),
    newTimer(TIMER2_BASE_CYCLES),
  ];
  private readonly portIn = new Uint8Array(4); // $F4-$F7 as read BY the SPC (written by a harness, simulating the main CPU)
  private readonly portOut = new Uint8Array(4); // $F4-$F7 as written BY the SPC (visible to a harness, simulating the main CPU's read side)
  private dspAddr = 0; // $F2 -- currently selected DSP register
  private romReadable = false; // $F1 bit7 -- IPL ROM overlay at $FFC0-$FFFF, never populated by this project (see module doc comment)

  readonly dspRead: (addr: number) => number;
  readonly dspWrite: (addr: number, value: number) => void;

  /** `stopped` goes true after a real `SLEEP`/`STOP` opcode -- real hardware halts the CPU clock entirely; a caller should stop stepping once this is set. */
  stopped = false;

  constructor(ram: Uint8Array, dspRead: (addr: number) => number, dspWrite: (addr: number, value: number) => void) {
    if (ram.length !== 0x10000) throw new RangeError(`Spc700Cpu: ram must be exactly 64KB, got ${ram.length}`);
    this.ram = ram;
    this.dspRead = dspRead;
    this.dspWrite = dspWrite;
  }

  /** Set the CPU's initial state to a chosen real entry point (this project always uses the driver's own confirmed cold-boot code start, not the IPL ROM reset vector -- see the boot harness for why). Does NOT touch ARAM contents. */
  reset(pcStart: number): void {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xef; // real post-boot-idiom value after `MOV X,#$FF; MOV SP,X` -- harmless placeholder before that code itself runs, since the driver's own cold-boot always sets this explicitly
    this.pc = pcStart & 0xffff;
    this.n = this.v = this.p = this.b = this.h = this.i = this.c = false;
    this.z = true;
    this.stopped = false;
  }

  /** Simulate a byte arriving from the main CPU on port `port` (0-3, i.e. $F4-$F7). Never called by this project's own boot harness (see module doc comment) -- exposed for completeness/tests. */
  pokePortIn(port: number, value: number): void {
    this.portIn[port & 3] = value & 0xff;
  }

  /** What the main CPU has most recently placed on SPC input port `$F4-$F7`. */
  getPortIn(port: number): number {
    return this.portIn[port & 3]!;
  }

  /** What the SPC has most recently written to $F4-$F7 (port 0-3) -- what a real main CPU would read. */
  getPortOut(port: number): number {
    return this.portOut[port & 3]!;
  }

  /** `$F1` bit 7 -- whether the IPL ROM overlay is currently mapped at `$FFC0`-`$FFFF`. This project's boot harnesses never populate real IPL ROM bytes (see module doc comment), so this is exposed only for completeness/tests. */
  get romEnabled(): boolean {
    return this.romReadable;
  }

  /** Read-only snapshot of timer `index`'s (0-2) internal state -- for tests/diagnostics. */
  getTimerState(index: number): { enabled: boolean; target: number; divider: number; counter: number } {
    const t = this.timers[index]!;
    return { enabled: t.enabled, target: t.target, divider: t.divider, counter: t.counter };
  }

  /**
   * Capture every piece of CPU state that is **not** already in the shared
   * ARAM buffer: registers, PSW flags, all three timers' internal
   * divider/counter/target/enable state, the `$F2` DSP address latch, the
   * `$F1` ROM-overlay bit, and both `$F4`-`$F7` port latches.
   *
   * Exists so a harness can run an expensive, ARAM-content-independent
   * cold-boot once and then replay it cheaply — `Spc700Cpu.reset()` alone is
   * *not* enough for that, because a real driver's boot code configures the
   * timers through `$F1`/`$FA`-`$FC` and that configuration lives here, not
   * in ARAM. Pair it with the DSP's own `regs` array and a copy of ARAM for
   * a complete machine snapshot.
   */
  saveState(): Spc700CpuState {
    return {
      a: this.a,
      x: this.x,
      y: this.y,
      sp: this.sp,
      pc: this.pc,
      psw: this.getPsw(),
      stopped: this.stopped,
      dspAddr: this.dspAddr,
      romReadable: this.romReadable,
      portIn: Uint8Array.from(this.portIn),
      portOut: Uint8Array.from(this.portOut),
      timers: this.timers.map((t) => ({ enabled: t.enabled, target: t.target, sub: t.sub, divider: t.divider, counter: t.counter })) as Spc700CpuState['timers'],
    };
  }

  /** Restore a {@link saveState} snapshot. Does NOT touch ARAM — the caller owns that buffer. */
  loadState(state: Spc700CpuState): void {
    this.a = state.a;
    this.x = state.x;
    this.y = state.y;
    this.sp = state.sp;
    this.pc = state.pc;
    this.setPsw(state.psw);
    this.stopped = state.stopped;
    this.dspAddr = state.dspAddr;
    this.romReadable = state.romReadable;
    this.portIn.set(state.portIn);
    this.portOut.set(state.portOut);
    for (let i = 0; i < 3; i++) {
      const t = this.timers[i]!;
      const s = state.timers[i]!;
      t.enabled = s.enabled;
      t.target = s.target;
      t.sub = s.sub;
      t.divider = s.divider;
      t.counter = s.counter;
    }
  }

  /**
   * Force a subroutine call as if triggered by a real hardware event this
   * harness doesn't otherwise model (e.g. the interrupt-driven "load song"
   * dispatch a real main CPU would trigger over the port protocol) --
   * pushes `returnAddr` as a real `CALL` would, then jumps to `targetAddr`.
   * The callee's own `RET` naturally resumes execution at `returnAddr`.
   * Only safe to call when the CPU is at a point where clobbering A/X/Y/PSW
   * is harmless (a caller should only inject at a detected stable idle-loop
   * head, never at an arbitrary mid-computation PC).
   */
  forceCall(targetAddr: number, returnAddr: number): void {
    this.push16(returnAddr & 0xffff);
    this.pc = targetAddr & 0xffff;
  }

  private get dp(): number {
    return this.p ? 0x100 : 0;
  }

  private getPsw(): number {
    return (
      (this.n ? 0x80 : 0) |
      (this.v ? 0x40 : 0) |
      (this.p ? 0x20 : 0) |
      (this.b ? 0x10 : 0) |
      (this.h ? 0x08 : 0) |
      (this.i ? 0x04 : 0) |
      (this.z ? 0x02 : 0) |
      (this.c ? 0x01 : 0)
    );
  }

  private setPsw(v: number): void {
    this.n = (v & 0x80) !== 0;
    this.v = (v & 0x40) !== 0;
    this.p = (v & 0x20) !== 0;
    this.b = (v & 0x10) !== 0;
    this.h = (v & 0x08) !== 0;
    this.i = (v & 0x04) !== 0;
    this.z = (v & 0x02) !== 0;
    this.c = (v & 0x01) !== 0;
  }

  private setNZ8(v: number): void {
    const b = v & 0xff;
    this.z = b === 0;
    this.n = (b & 0x80) !== 0;
  }

  private setNZ16(v: number): void {
    const w = v & 0xffff;
    this.z = w === 0;
    this.n = (w & 0x8000) !== 0;
  }

  // ── Memory-mapped I/O ($F0-$FF) ──────────────────────────────────────

  private readIo(addr: number): number {
    switch (addr) {
      case 0xf2:
        return this.dspAddr;
      case 0xf3:
        return this.dspRead(this.dspAddr & 0x7f);
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7:
        return this.portIn[addr - 0xf4]!;
      case 0xfd:
      case 0xfe:
      case 0xff: {
        const t = this.timers[addr - 0xfd]!;
        const out = t.counter & 0xf;
        t.counter = 0;
        return out;
      }
      default:
        return this.ram[addr]!;
    }
  }

  private writeIo(addr: number, value: number): void {
    const v = value & 0xff;
    this.ram[addr] = v;
    switch (addr) {
      case 0xf1: // CONTROL
        this.timers[0]!.enabled = (v & 0x01) !== 0;
        this.timers[1]!.enabled = (v & 0x02) !== 0;
        this.timers[2]!.enabled = (v & 0x04) !== 0;
        if (v & 0x10) {
          this.portIn[0] = 0;
          this.portIn[1] = 0;
        }
        if (v & 0x20) {
          this.portIn[2] = 0;
          this.portIn[3] = 0;
        }
        this.romReadable = (v & 0x80) !== 0;
        break;
      case 0xf2:
        this.dspAddr = v;
        break;
      case 0xf3:
        this.dspWrite(this.dspAddr & 0x7f, v);
        break;
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7:
        this.portOut[addr - 0xf4] = v;
        break;
      case 0xfa:
      case 0xfb:
      case 0xfc:
        this.timers[addr - 0xfa]!.target = v;
        break;
      default:
        break;
    }
  }

  /** Read one byte, applying $F0-$FF I/O side effects. */
  read8(addr: number): number {
    const a = addr & 0xffff;
    if (a >= 0xf0 && a <= 0xff) return this.readIo(a);
    return this.ram[a]!;
  }

  /** Write one byte, applying $F0-$FF I/O side effects. */
  write8(addr: number, value: number): void {
    const a = addr & 0xffff;
    if (a >= 0xf0 && a <= 0xff) {
      this.writeIo(a, value);
      return;
    }
    this.ram[a] = value & 0xff;
  }

  private read16(addr: number): number {
    return this.read8(addr) | (this.read8((addr + 1) & 0xffff) << 8);
  }

  private fetch8(): number {
    const v = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return lo | (hi << 8);
  }

  private push8(v: number): void {
    this.ram[0x100 + (this.sp & 0xff)] = v & 0xff;
    this.sp = (this.sp - 1) & 0xff;
  }

  private pop8(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.ram[0x100 + (this.sp & 0xff)]!;
  }

  private push16(v: number): void {
    this.push8((v >> 8) & 0xff);
    this.push8(v & 0xff);
  }

  private pop16(): number {
    const lo = this.pop8();
    const hi = this.pop8();
    return lo | (hi << 8);
  }

  // ── Addressing-mode operand resolution ───────────────────────────────
  // Mirrors SPC_CPU.h's `ADDR_MODES`/`ADDR_MODES_NO_DP` macro family: given
  // the opcode's fixed offset from a family's base ("op"), resolve to a
  // memory address. `withDp` selects whether a plain `dp` (no index) mode
  // exists for this family (true for AND/OR/EOR/CMP/ADC/SBC/shift/inc-dec;
  // false for MOV A,addr, whose plain-dp form is a separate explicit
  // opcode).

  /** Resolve one of the 7 shared indexed/absolute addressing modes from an opcode's low nibble family. `opLow` is `opcode & 0x1F` relative to the family's base -- see call sites for the exact offset table (transcribed 1:1 from `ADDR_MODES_`). */
  private resolveIndexedAddr(kind: 'x-ind' | 'dp-y-ind' | 'dp-x-ind' | 'abs-y' | 'abs-x' | 'abs' | 'dp-x' | 'dp'): number {
    switch (kind) {
      case 'x-ind':
        return this.x + this.dp;
      case 'dp-y-ind': {
        const dpAddr = this.fetch8();
        const ptr = this.read16(this.dp + dpAddr);
        return (ptr + this.y) & 0xffff;
      }
      case 'dp-x-ind': {
        const dpAddr = this.fetch8();
        const ptr = this.read16(this.dp + ((dpAddr + this.x) & 0xff));
        return ptr;
      }
      case 'abs-y': {
        const addr = this.fetch16();
        return (addr + this.y) & 0xffff;
      }
      case 'abs-x': {
        const addr = this.fetch16();
        return (addr + this.x) & 0xffff;
      }
      case 'abs':
        return this.fetch16();
      case 'dp-x': {
        const dpAddr = this.fetch8();
        return this.dp + ((dpAddr + this.x) & 0xff);
      }
      case 'dp': {
        const dpAddr = this.fetch8();
        return this.dp + dpAddr;
      }
    }
  }

  // ── Instruction execution ────────────────────────────────────────────

  /** Execute exactly one instruction. Returns the number of CPU cycles it consumed (from the real `CYCLE_TABLE`). */
  step(): number {
    const opcode = this.fetch8();
    this.cycleAdjust = 0;
    this.execute(opcode);
    const cycles = CYCLE_TABLE[opcode]! + this.cycleAdjust;
    this.advanceTimers(cycles);
    return cycles;
  }

  private advanceTimers(cycles: number): void {
    for (const t of this.timers) {
      if (!t.enabled) {
        t.sub = 0;
        t.divider = 0;
        continue;
      }
      t.sub += cycles;
      while (t.sub >= t.baseCycles) {
        t.sub -= t.baseCycles;
        t.divider++;
        const cmp = t.target === 0 ? 256 : t.target;
        if (t.divider >= cmp) {
          t.divider = 0;
          t.counter = (t.counter + 1) & 0xf;
        }
      }
    }
  }

  // Shared ALU helpers -- flag formulas transcribed from SPC_CPU.h's `adc_data`/CMP case bodies.

  private doAdc(operand: number, carryIn: number): number {
    const a = this.a;
    const sum = a + operand + carryIn;
    const result = sum & 0xff;
    this.c = sum > 0xff;
    this.h = (a & 0xf) + (operand & 0xf) + carryIn > 0xf;
    this.v = ((~(a ^ operand) & (a ^ result)) & 0x80) !== 0;
    this.setNZ8(result);
    return result;
  }

  private doCmp(a: number, b: number): void {
    const diff = a - b;
    this.c = diff >= 0;
    this.setNZ8(diff & 0xff);
  }

  private doAsl(v: number): number {
    this.c = (v & 0x80) !== 0;
    const r = (v << 1) & 0xff;
    this.setNZ8(r);
    return r;
  }
  private doRol(v: number): number {
    const carryIn = this.c ? 1 : 0;
    this.c = (v & 0x80) !== 0;
    const r = ((v << 1) | carryIn) & 0xff;
    this.setNZ8(r);
    return r;
  }
  private doLsr(v: number): number {
    this.c = (v & 0x01) !== 0;
    const r = v >> 1;
    this.setNZ8(r);
    return r;
  }
  private doRor(v: number): number {
    const carryIn = this.c ? 0x80 : 0;
    this.c = (v & 0x01) !== 0;
    const r = (v >> 1) | carryIn;
    this.setNZ8(r);
    return r;
  }

  /**
   * Real hardware: every conditional-branch-family opcode (`BEQ`/`BNE`/.../
   * `BBS`/`BBC`/`CBNE`/`DBNZ`)'s static `CYCLE_TABLE` entry is its *taken*
   * cost; the not-taken path is always exactly 2 cycles cheaper (`SPC_CPU.h`'s
   * `BRANCH`/`CBRANCH` macros, both `rel_time -= 2` on the not-taken side).
   * `step()` applies `cycleAdjust` after `execute()` returns.
   */
  private cycleAdjust = 0;

  private branch(cond: boolean, rel: number): void {
    this.cycleAdjust = cond ? 0 : -2;
    if (cond) this.pc = (this.pc + int8(rel)) & 0xffff;
  }

  private execute(opcode: number): void {
    const R = this.read8.bind(this);
    const W = this.write8.bind(this);

    switch (opcode) {
      // ── 1/2/3. 8-bit data transmission ──────────────────────────────
      case 0xe8: // MOV A,#imm
        this.a = this.fetch8();
        this.setNZ8(this.a);
        return;
      case 0xe4: // MOV A,dp
        this.a = R(this.resolveIndexedAddr('dp'));
        this.setNZ8(this.a);
        return;
      case 0xf4: // MOV A,dp+X
        this.a = R(this.resolveIndexedAddr('dp-x'));
        this.setNZ8(this.a);
        return;
      case 0xe5: // MOV A,abs
        this.a = R(this.resolveIndexedAddr('abs'));
        this.setNZ8(this.a);
        return;
      case 0xf5: // MOV A,abs+X
        this.a = R(this.resolveIndexedAddr('abs-x'));
        this.setNZ8(this.a);
        return;
      case 0xf6: // MOV A,abs+Y
        this.a = R(this.resolveIndexedAddr('abs-y'));
        this.setNZ8(this.a);
        return;
      case 0xe6: // MOV A,(X)
        this.a = R(this.x + this.dp);
        this.setNZ8(this.a);
        return;
      case 0xbf: { // MOV A,(X)+
        const addr = this.x + this.dp;
        this.a = R(addr);
        this.setNZ8(this.a);
        this.x = (this.x + 1) & 0xff;
        return;
      }
      case 0xf7: // MOV A,[dp]+Y
        this.a = R(this.resolveIndexedAddr('dp-y-ind'));
        this.setNZ8(this.a);
        return;
      case 0xe7: // MOV A,[dp+X]
        this.a = R(this.resolveIndexedAddr('dp-x-ind'));
        this.setNZ8(this.a);
        return;
      case 0xf8: // MOV X,dp
        this.x = R(this.resolveIndexedAddr('dp'));
        this.setNZ8(this.x);
        return;
      case 0xf9: // MOV X,dp+Y
        this.x = R(this.dp + ((this.fetch8() + this.y) & 0xff));
        this.setNZ8(this.x);
        return;
      case 0xe9: // MOV X,abs
        this.x = R(this.resolveIndexedAddr('abs'));
        this.setNZ8(this.x);
        return;
      case 0xcd: // MOV X,#imm
        this.x = this.fetch8();
        this.setNZ8(this.x);
        return;
      case 0xeb: // MOV Y,dp
        this.y = R(this.resolveIndexedAddr('dp'));
        this.setNZ8(this.y);
        return;
      case 0xfb: // MOV Y,dp+X
        this.y = R(this.resolveIndexedAddr('dp-x'));
        this.setNZ8(this.y);
        return;
      case 0xec: // MOV Y,abs
        this.y = R(this.resolveIndexedAddr('abs'));
        this.setNZ8(this.y);
        return;
      case 0x8d: // MOV Y,#imm
        this.y = this.fetch8();
        this.setNZ8(this.y);
        return;

      case 0xc4: // MOV dp,A
        W(this.resolveIndexedAddr('dp'), this.a);
        return;
      case 0xd4: // MOV dp+X,A
        W(this.resolveIndexedAddr('dp-x'), this.a);
        return;
      case 0xc5: // MOV abs,A
        W(this.resolveIndexedAddr('abs'), this.a);
        return;
      case 0xd5: // MOV abs+X,A
        W(this.resolveIndexedAddr('abs-x'), this.a);
        return;
      case 0xd6: // MOV abs+Y,A
        W(this.resolveIndexedAddr('abs-y'), this.a);
        return;
      case 0xc6: // MOV (X),A
        W(this.x + this.dp, this.a);
        return;
      case 0xaf: // MOV (X)+,A
        W(this.x + this.dp, this.a);
        this.x = (this.x + 1) & 0xff;
        return;
      case 0xd7: // MOV [dp]+Y,A
        W(this.resolveIndexedAddr('dp-y-ind'), this.a);
        return;
      case 0xc7: // MOV [dp+X],A
        W(this.resolveIndexedAddr('dp-x-ind'), this.a);
        return;
      case 0xcc: // MOV abs,Y
        W(this.resolveIndexedAddr('abs'), this.y);
        return;
      case 0xc9: // MOV abs,X
        W(this.resolveIndexedAddr('abs'), this.x);
        return;
      case 0xd9: // MOV dp+Y,X
        W(this.dp + ((this.fetch8() + this.y) & 0xff), this.x);
        return;
      case 0xd8: // MOV dp,X
        W(this.resolveIndexedAddr('dp'), this.x);
        return;
      case 0xdb: // MOV dp+X,Y
        W(this.resolveIndexedAddr('dp-x'), this.y);
        return;
      case 0xcb: // MOV dp,Y
        W(this.resolveIndexedAddr('dp'), this.y);
        return;

      case 0x7d: // MOV A,X
        this.a = this.x;
        this.setNZ8(this.a);
        return;
      case 0xdd: // MOV A,Y
        this.a = this.y;
        this.setNZ8(this.a);
        return;
      case 0x5d: // MOV X,A
        this.x = this.a;
        this.setNZ8(this.x);
        return;
      case 0xfd: // MOV Y,A
        this.y = this.a;
        this.setNZ8(this.y);
        return;
      case 0x9d: // MOV X,SP
        this.x = this.sp;
        this.setNZ8(this.x);
        return;
      case 0xbd: // MOV SP,X
        this.sp = this.x;
        return;

      case 0x8f: { // MOV dp,#imm  (nn aa: imm byte first, then dp addr)
        const imm = this.fetch8();
        const addr = this.dp + this.fetch8();
        W(addr, imm);
        return;
      }
      case 0xfa: { // MOV dp,dp  (bb aa: src dp addr, then dst dp addr)
        const src = this.dp + this.fetch8();
        const v = R(src);
        const dst = this.dp + this.fetch8();
        W(dst, v);
        return;
      }

      // ── 5. Logic ops (AND/OR/EOR) ────────────────────────────────────
      case 0x28: // AND A,#imm
        this.a &= this.fetch8();
        this.setNZ8(this.a);
        return;
      case 0x24: // AND A,dp
        this.a &= R(this.resolveIndexedAddr('dp'));
        this.setNZ8(this.a);
        return;
      case 0x34: // AND A,dp+X
        this.a &= R(this.resolveIndexedAddr('dp-x'));
        this.setNZ8(this.a);
        return;
      case 0x25: // AND A,abs
        this.a &= R(this.resolveIndexedAddr('abs'));
        this.setNZ8(this.a);
        return;
      case 0x35: // AND A,abs+X
        this.a &= R(this.resolveIndexedAddr('abs-x'));
        this.setNZ8(this.a);
        return;
      case 0x36: // AND A,abs+Y
        this.a &= R(this.resolveIndexedAddr('abs-y'));
        this.setNZ8(this.a);
        return;
      case 0x26: // AND A,(X)
        this.a &= R(this.x + this.dp);
        this.setNZ8(this.a);
        return;
      case 0x37: // AND A,[dp]+Y
        this.a &= R(this.resolveIndexedAddr('dp-y-ind'));
        this.setNZ8(this.a);
        return;
      case 0x27: // AND A,[dp+X]
        this.a &= R(this.resolveIndexedAddr('dp-x-ind'));
        this.setNZ8(this.a);
        return;
      case 0x29: { // AND dp,dp -- byte1 = source dp offset (value read), byte2 = dest dp offset (combined + written back)
        const src = this.dp + this.fetch8();
        const sv = R(src);
        const dst = this.dp + this.fetch8();
        const r = sv & R(dst);
        W(dst, r);
        this.setNZ8(r);
        return;
      }
      case 0x38: { // AND dp,#imm
        const imm = this.fetch8();
        const addr = this.dp + this.fetch8();
        const r = imm & R(addr);
        W(addr, r);
        this.setNZ8(r);
        return;
      }
      case 0x39: { // AND (X),(Y) -- dest = (dp+X), source = (dp+Y)
        const r = R(this.dp + this.y) & R(this.x + this.dp);
        W(this.x + this.dp, r);
        this.setNZ8(r);
        return;
      }

      case 0x08: // OR A,#imm
        this.a |= this.fetch8();
        this.setNZ8(this.a);
        return;
      case 0x04: // OR A,dp
        this.a |= R(this.resolveIndexedAddr('dp'));
        this.setNZ8(this.a);
        return;
      case 0x14: // OR A,dp+X
        this.a |= R(this.resolveIndexedAddr('dp-x'));
        this.setNZ8(this.a);
        return;
      case 0x05: // OR A,abs
        this.a |= R(this.resolveIndexedAddr('abs'));
        this.setNZ8(this.a);
        return;
      case 0x15: // OR A,abs+X
        this.a |= R(this.resolveIndexedAddr('abs-x'));
        this.setNZ8(this.a);
        return;
      case 0x16: // OR A,abs+Y
        this.a |= R(this.resolveIndexedAddr('abs-y'));
        this.setNZ8(this.a);
        return;
      case 0x06: // OR A,(X)
        this.a |= R(this.x + this.dp);
        this.setNZ8(this.a);
        return;
      case 0x17: // OR A,[dp]+Y
        this.a |= R(this.resolveIndexedAddr('dp-y-ind'));
        this.setNZ8(this.a);
        return;
      case 0x07: // OR A,[dp+X]
        this.a |= R(this.resolveIndexedAddr('dp-x-ind'));
        this.setNZ8(this.a);
        return;
      case 0x19: { // OR (X),(Y)
        const r = R(this.x + this.dp) | R(this.dp + this.y);
        W(this.x + this.dp, r);
        this.setNZ8(r);
        return;
      }
      case 0x09: { // OR dp,dp
        const src = this.dp + this.fetch8();
        const sv = R(src);
        const dst = this.dp + this.fetch8();
        const r = sv | R(dst);
        W(dst, r);
        this.setNZ8(r);
        return;
      }
      case 0x18: { // OR dp,#imm
        const imm = this.fetch8();
        const addr = this.dp + this.fetch8();
        const r = imm | R(addr);
        W(addr, r);
        this.setNZ8(r);
        return;
      }

      case 0x48: // EOR A,#imm
        this.a ^= this.fetch8();
        this.setNZ8(this.a);
        return;
      case 0x44: // EOR A,dp
        this.a ^= R(this.resolveIndexedAddr('dp'));
        this.setNZ8(this.a);
        return;
      case 0x54: // EOR A,dp+X
        this.a ^= R(this.resolveIndexedAddr('dp-x'));
        this.setNZ8(this.a);
        return;
      case 0x45: // EOR A,abs
        this.a ^= R(this.resolveIndexedAddr('abs'));
        this.setNZ8(this.a);
        return;
      case 0x55: // EOR A,abs+X
        this.a ^= R(this.resolveIndexedAddr('abs-x'));
        this.setNZ8(this.a);
        return;
      case 0x56: // EOR A,abs+Y
        this.a ^= R(this.resolveIndexedAddr('abs-y'));
        this.setNZ8(this.a);
        return;
      case 0x46: // EOR A,(X)
        this.a ^= R(this.x + this.dp);
        this.setNZ8(this.a);
        return;
      case 0x57: // EOR A,[dp]+Y
        this.a ^= R(this.resolveIndexedAddr('dp-y-ind'));
        this.setNZ8(this.a);
        return;
      case 0x47: // EOR A,[dp+X]
        this.a ^= R(this.resolveIndexedAddr('dp-x-ind'));
        this.setNZ8(this.a);
        return;
      case 0x59: { // EOR (X),(Y)
        const r = R(this.x + this.dp) ^ R(this.dp + this.y);
        W(this.x + this.dp, r);
        this.setNZ8(r);
        return;
      }
      case 0x49: { // EOR dp,dp
        const src = this.dp + this.fetch8();
        const sv = R(src);
        const dst = this.dp + this.fetch8();
        const r = sv ^ R(dst);
        W(dst, r);
        this.setNZ8(r);
        return;
      }
      case 0x58: { // EOR dp,#imm
        const imm = this.fetch8();
        const addr = this.dp + this.fetch8();
        const r = imm ^ R(addr);
        W(addr, r);
        this.setNZ8(r);
        return;
      }

      // ── 4. CMP ────────────────────────────────────────────────────────
      case 0x68: // CMP A,#imm
        this.doCmp(this.a, this.fetch8());
        return;
      case 0x64: // CMP A,dp
        this.doCmp(this.a, R(this.resolveIndexedAddr('dp')));
        return;
      case 0x74: // CMP A,dp+X
        this.doCmp(this.a, R(this.resolveIndexedAddr('dp-x')));
        return;
      case 0x65: // CMP A,abs
        this.doCmp(this.a, R(this.resolveIndexedAddr('abs')));
        return;
      case 0x75: // CMP A,abs+X
        this.doCmp(this.a, R(this.resolveIndexedAddr('abs-x')));
        return;
      case 0x76: // CMP A,abs+Y
        this.doCmp(this.a, R(this.resolveIndexedAddr('abs-y')));
        return;
      case 0x66: // CMP A,(X)
        this.doCmp(this.a, R(this.x + this.dp));
        return;
      case 0x77: // CMP A,[dp]+Y
        this.doCmp(this.a, R(this.resolveIndexedAddr('dp-y-ind')));
        return;
      case 0x67: // CMP A,[dp+X]
        this.doCmp(this.a, R(this.resolveIndexedAddr('dp-x-ind')));
        return;
      case 0x79: // CMP (X),(Y)
        this.doCmp(R(this.x + this.dp), R(this.dp + this.y));
        return;
      case 0x69: { // CMP dp,dp
        const src = this.dp + this.fetch8();
        const sv = R(src);
        const dst = this.dp + this.fetch8();
        this.doCmp(sv, R(dst));
        return;
      }
      case 0x78: { // CMP dp,#imm
        const imm = this.fetch8();
        const addr = this.dp + this.fetch8();
        this.doCmp(R(addr), imm);
        return;
      }
      case 0x3e: // CMP X,dp
        this.doCmp(this.x, R(this.resolveIndexedAddr('dp')));
        return;
      case 0x1e: // CMP X,abs
        this.doCmp(this.x, R(this.resolveIndexedAddr('abs')));
        return;
      case 0xc8: // CMP X,#imm
        this.doCmp(this.x, this.fetch8());
        return;
      case 0x7e: // CMP Y,dp
        this.doCmp(this.y, R(this.resolveIndexedAddr('dp')));
        return;
      case 0x5e: // CMP Y,abs
        this.doCmp(this.y, R(this.resolveIndexedAddr('abs')));
        return;
      case 0xad: // CMP Y,#imm
        this.doCmp(this.y, this.fetch8());
        return;

      // ── ADC/SBC ──────────────────────────────────────────────────────
      case 0x88: // ADC A,#imm
        this.a = this.doAdc(this.fetch8(), this.c ? 1 : 0);
        return;
      case 0x84: // ADC A,dp
        this.a = this.doAdc(R(this.resolveIndexedAddr('dp')), this.c ? 1 : 0);
        return;
      case 0x94: // ADC A,dp+X
        this.a = this.doAdc(R(this.resolveIndexedAddr('dp-x')), this.c ? 1 : 0);
        return;
      case 0x85: // ADC A,abs
        this.a = this.doAdc(R(this.resolveIndexedAddr('abs')), this.c ? 1 : 0);
        return;
      case 0x95: // ADC A,abs+X
        this.a = this.doAdc(R(this.resolveIndexedAddr('abs-x')), this.c ? 1 : 0);
        return;
      case 0x96: // ADC A,abs+Y
        this.a = this.doAdc(R(this.resolveIndexedAddr('abs-y')), this.c ? 1 : 0);
        return;
      case 0x86: // ADC A,(X)
        this.a = this.doAdc(R(this.x + this.dp), this.c ? 1 : 0);
        return;
      case 0x97: // ADC A,[dp]+Y
        this.a = this.doAdc(R(this.resolveIndexedAddr('dp-y-ind')), this.c ? 1 : 0);
        return;
      case 0x87: // ADC A,[dp+X]
        this.a = this.doAdc(R(this.resolveIndexedAddr('dp-x-ind')), this.c ? 1 : 0);
        return;
      case 0x99: { // ADC (X),(Y)
        const carry = this.c ? 1 : 0;
        const dst = this.x + this.dp;
        const av = R(dst);
        const bv = R(this.dp + this.y);
        const sum = av + bv + carry;
        const result = sum & 0xff;
        this.c = sum > 0xff;
        this.h = (av & 0xf) + (bv & 0xf) + carry > 0xf;
        this.v = ((~(av ^ bv) & (av ^ result)) & 0x80) !== 0;
        this.setNZ8(result);
        W(dst, result);
        return;
      }
      case 0x89: { // ADC dp,dp
        const carry = this.c ? 1 : 0;
        const src = this.dp + this.fetch8();
        const bv = R(src);
        const dst = this.dp + this.fetch8();
        const av = R(dst);
        const sum = av + bv + carry;
        const result = sum & 0xff;
        this.c = sum > 0xff;
        this.h = (av & 0xf) + (bv & 0xf) + carry > 0xf;
        this.v = ((~(av ^ bv) & (av ^ result)) & 0x80) !== 0;
        this.setNZ8(result);
        W(dst, result);
        return;
      }
      case 0x98: { // ADC dp,#imm
        const carry = this.c ? 1 : 0;
        const bv = this.fetch8();
        const addr = this.dp + this.fetch8();
        const av = R(addr);
        const sum = av + bv + carry;
        const result = sum & 0xff;
        this.c = sum > 0xff;
        this.h = (av & 0xf) + (bv & 0xf) + carry > 0xf;
        this.v = ((~(av ^ bv) & (av ^ result)) & 0x80) !== 0;
        this.setNZ8(result);
        W(addr, result);
        return;
      }

      case 0xa8: // SBC A,#imm
        this.a = this.doAdc(this.fetch8() ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xa4: // SBC A,dp
        this.a = this.doAdc(R(this.resolveIndexedAddr('dp')) ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xb4: // SBC A,dp+X
        this.a = this.doAdc(R(this.resolveIndexedAddr('dp-x')) ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xa5: // SBC A,abs
        this.a = this.doAdc(R(this.resolveIndexedAddr('abs')) ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xb5: // SBC A,abs+X
        this.a = this.doAdc(R(this.resolveIndexedAddr('abs-x')) ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xb6: // SBC A,abs+Y
        this.a = this.doAdc(R(this.resolveIndexedAddr('abs-y')) ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xa6: // SBC A,(X)
        this.a = this.doAdc(R(this.x + this.dp) ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xb7: // SBC A,[dp]+Y
        this.a = this.doAdc(R(this.resolveIndexedAddr('dp-y-ind')) ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xa7: // SBC A,[dp+X]
        this.a = this.doAdc(R(this.resolveIndexedAddr('dp-x-ind')) ^ 0xff, this.c ? 1 : 0);
        return;
      case 0xb9: { // SBC (X),(Y)
        const carry = this.c ? 1 : 0;
        const dst = this.x + this.dp;
        const av = R(dst);
        const bv = R(this.dp + this.y) ^ 0xff;
        const sum = av + bv + carry;
        const result = sum & 0xff;
        this.c = sum > 0xff;
        this.h = (av & 0xf) + (bv & 0xf) + carry > 0xf;
        this.v = ((~(av ^ bv) & (av ^ result)) & 0x80) !== 0;
        this.setNZ8(result);
        W(dst, result);
        return;
      }
      case 0xa9: { // SBC dp,dp
        const carry = this.c ? 1 : 0;
        const src = this.dp + this.fetch8();
        const bv = R(src) ^ 0xff;
        const dst = this.dp + this.fetch8();
        const av = R(dst);
        const sum = av + bv + carry;
        const result = sum & 0xff;
        this.c = sum > 0xff;
        this.h = (av & 0xf) + (bv & 0xf) + carry > 0xf;
        this.v = ((~(av ^ bv) & (av ^ result)) & 0x80) !== 0;
        this.setNZ8(result);
        W(dst, result);
        return;
      }
      case 0xb8: { // SBC dp,#imm
        const carry = this.c ? 1 : 0;
        const bv = this.fetch8() ^ 0xff;
        const addr = this.dp + this.fetch8();
        const av = R(addr);
        const sum = av + bv + carry;
        const result = sum & 0xff;
        this.c = sum > 0xff;
        this.h = (av & 0xf) + (bv & 0xf) + carry > 0xf;
        this.v = ((~(av ^ bv) & (av ^ result)) & 0x80) !== 0;
        this.setNZ8(result);
        W(addr, result);
        return;
      }

      // ── 6. INC/DEC ──────────────────────────────────────────────────
      case 0xbc: // INC A
        this.a = (this.a + 1) & 0xff;
        this.setNZ8(this.a);
        return;
      case 0x3d: // INC X
        this.x = (this.x + 1) & 0xff;
        this.setNZ8(this.x);
        return;
      case 0xfc: // INC Y
        this.y = (this.y + 1) & 0xff;
        this.setNZ8(this.y);
        return;
      case 0x9c: // DEC A
        this.a = (this.a - 1) & 0xff;
        this.setNZ8(this.a);
        return;
      case 0x1d: // DEC X
        this.x = (this.x - 1) & 0xff;
        this.setNZ8(this.x);
        return;
      case 0xdc: // DEC Y
        this.y = (this.y - 1) & 0xff;
        this.setNZ8(this.y);
        return;
      case 0xab: { // INC dp
        const addr = this.resolveIndexedAddr('dp');
        const r = (R(addr) + 1) & 0xff;
        W(addr, r);
        this.setNZ8(r);
        return;
      }
      case 0xbb: { // INC dp+X
        const addr = this.resolveIndexedAddr('dp-x');
        const r = (R(addr) + 1) & 0xff;
        W(addr, r);
        this.setNZ8(r);
        return;
      }
      case 0xac: { // INC abs
        const addr = this.resolveIndexedAddr('abs');
        const r = (R(addr) + 1) & 0xff;
        W(addr, r);
        this.setNZ8(r);
        return;
      }
      case 0x8b: { // DEC dp
        const addr = this.resolveIndexedAddr('dp');
        const r = (R(addr) - 1) & 0xff;
        W(addr, r);
        this.setNZ8(r);
        return;
      }
      case 0x9b: { // DEC dp+X
        const addr = this.resolveIndexedAddr('dp-x');
        const r = (R(addr) - 1) & 0xff;
        W(addr, r);
        this.setNZ8(r);
        return;
      }
      case 0x8c: { // DEC abs
        const addr = this.resolveIndexedAddr('abs');
        const r = (R(addr) - 1) & 0xff;
        W(addr, r);
        this.setNZ8(r);
        return;
      }

      // ── 7. Shift/rotate ─────────────────────────────────────────────
      case 0x1c: // ASL A
        this.a = this.doAsl(this.a);
        return;
      case 0x3c: // ROL A
        this.a = this.doRol(this.a);
        return;
      case 0x5c: // LSR A
        this.a = this.doLsr(this.a);
        return;
      case 0x7c: // ROR A
        this.a = this.doRor(this.a);
        return;
      case 0x0b: { // ASL dp
        const addr = this.resolveIndexedAddr('dp');
        W(addr, this.doAsl(R(addr)));
        return;
      }
      case 0x1b: { // ASL dp+X
        const addr = this.resolveIndexedAddr('dp-x');
        W(addr, this.doAsl(R(addr)));
        return;
      }
      case 0x0c: { // ASL abs
        const addr = this.resolveIndexedAddr('abs');
        W(addr, this.doAsl(R(addr)));
        return;
      }
      case 0x2b: { // ROL dp
        const addr = this.resolveIndexedAddr('dp');
        W(addr, this.doRol(R(addr)));
        return;
      }
      case 0x3b: { // ROL dp+X
        const addr = this.resolveIndexedAddr('dp-x');
        W(addr, this.doRol(R(addr)));
        return;
      }
      case 0x2c: { // ROL abs
        const addr = this.resolveIndexedAddr('abs');
        W(addr, this.doRol(R(addr)));
        return;
      }
      case 0x4b: { // LSR dp
        const addr = this.resolveIndexedAddr('dp');
        W(addr, this.doLsr(R(addr)));
        return;
      }
      case 0x5b: { // LSR dp+X
        const addr = this.resolveIndexedAddr('dp-x');
        W(addr, this.doLsr(R(addr)));
        return;
      }
      case 0x4c: { // LSR abs
        const addr = this.resolveIndexedAddr('abs');
        W(addr, this.doLsr(R(addr)));
        return;
      }
      case 0x6b: { // ROR dp
        const addr = this.resolveIndexedAddr('dp');
        W(addr, this.doRor(R(addr)));
        return;
      }
      case 0x7b: { // ROR dp+X
        const addr = this.resolveIndexedAddr('dp-x');
        W(addr, this.doRor(R(addr)));
        return;
      }
      case 0x6c: { // ROR abs
        const addr = this.resolveIndexedAddr('abs');
        W(addr, this.doRor(R(addr)));
        return;
      }
      case 0x9f: // XCN
        this.a = ((this.a >> 4) | (this.a << 4)) & 0xff;
        this.setNZ8(this.a);
        return;

      // ── 8/9. 16-bit ops ──────────────────────────────────────────────
      case 0xba: { // MOVW YA,dp
        const addr = this.dp + this.fetch8();
        const lo = R(addr);
        const hi = R((addr & 0xff00) | ((addr + 1) & 0xff)); // dp wraps within the page, matching real hardware's `(uint8_t)(data+1)+dp`
        this.a = lo;
        this.y = hi;
        this.setNZ16((hi << 8) | lo);
        return;
      }
      case 0xda: { // MOVW dp,YA
        const dpAddr = this.fetch8();
        const addr = this.dp + dpAddr;
        W(addr, this.a);
        W(this.dp + ((dpAddr + 1) & 0xff), this.y);
        return;
      }
      case 0x3a: { // INCW dp
        const dpAddr = this.fetch8();
        const addr = this.dp + dpAddr;
        const hiAddr = this.dp + ((dpAddr + 1) & 0xff);
        const w = ((R(addr) | (R(hiAddr) << 8)) + 1) & 0xffff;
        W(addr, w & 0xff);
        W(hiAddr, w >> 8);
        this.setNZ16(w);
        return;
      }
      case 0x1a: { // DECW dp
        const dpAddr = this.fetch8();
        const addr = this.dp + dpAddr;
        const hiAddr = this.dp + ((dpAddr + 1) & 0xff);
        const w = ((R(addr) | (R(hiAddr) << 8)) - 1) & 0xffff;
        W(addr, w & 0xff);
        W(hiAddr, w >> 8);
        this.setNZ16(w);
        return;
      }
      case 0x7a: { // ADDW YA,dp -- transcribed literally from SPC_CPU.h's shared ADDW/SUBW case body (the H/V flag derivation is the SAME bit-trick formula as the 8-bit ADC case, `flags = operandHi ^ resultBeforeAdd ^ resultAfterAdd`, just evaluated on the high byte/full carry chain instead of a plain 8-bit add).
        const dpAddr = this.fetch8();
        const hi = R(this.dp + ((dpAddr + 1) & 0xff));
        let lo = R(this.dp + dpAddr);
        lo += this.a;
        let result = this.y + hi + (lo >> 8);
        const flags = hi ^ this.y ^ result;
        this.h = ((flags >> 1) & 0x08) !== 0;
        this.v = (((flags + 0x80) >> 2) & 0x40) !== 0;
        this.c = result > 0xff;
        this.a = lo & 0xff;
        result &= 0xff;
        this.y = result;
        this.setNZ16((this.y << 8) | this.a);
        return;
      }
      case 0x9a: { // SUBW YA,dp -- same shared body, `lo`/`hi` two's/one's-complement-negated first (SPC_CPU.h's `opcode == 0x9A` branch)
        const dpAddr = this.fetch8();
        let hi = R(this.dp + ((dpAddr + 1) & 0xff));
        let lo = R(this.dp + dpAddr);
        lo = ((lo ^ 0xff) + 1) & 0x1ff;
        hi ^= 0xff;
        lo += this.a;
        let result = this.y + hi + (lo >> 8);
        const flags = hi ^ this.y ^ result;
        this.h = ((flags >> 1) & 0x08) !== 0;
        this.v = (((flags + 0x80) >> 2) & 0x40) !== 0;
        this.c = result > 0xff;
        this.a = lo & 0xff;
        result &= 0xff;
        this.y = result;
        this.setNZ16((this.y << 8) | this.a);
        return;
      }
      case 0x5a: { // CMPW YA,dp
        const dpAddr = this.fetch8();
        const addr = this.dp + dpAddr;
        const operand = R(addr) | (R(this.dp + ((dpAddr + 1) & 0xff)) << 8);
        const ya = (this.y << 8) | this.a;
        const diff = ya - operand;
        this.c = diff >= 0;
        this.setNZ16(diff & 0xffff);
        return;
      }

      // ── 10. MUL/DIV ──────────────────────────────────────────────────
      case 0xcf: { // MUL YA
        const product = this.y * this.a;
        this.a = product & 0xff;
        this.y = (product >> 8) & 0xff;
        // Z reflects the full 16-bit product (both bytes), N reflects only Y's bit 7 -- transcribed
        // from SPC_CPU.h's `nz = ((temp>>1)|temp)&0x7F; y=temp>>8; nz|=y;`, equivalent to testing the
        // full word for zero while taking the sign bit from the high byte alone.
        this.setNZ16((this.y << 8) | this.a);
        return;
      }
      case 0x9e: { // DIV YA,X
        const ya = (this.y << 8) | this.a;
        this.v = this.y >= this.x;
        this.h = (this.y & 0xf) >= (this.x & 0xf);
        let quotient: number;
        let remainder: number;
        if (this.x === 0) {
          // Real hardware: division by zero produces a defined (if unusual) result via the same
          // formula below rather than trapping -- `this.y < this.x*2` is always false when x=0, so
          // this naturally falls into the same "overflow" branch real hardware takes.
          quotient = 0;
          remainder = 0;
        } else if (this.y < this.x * 2) {
          quotient = Math.floor(ya / this.x) & 0xff;
          remainder = (ya - quotient * this.x) & 0xff;
        } else {
          quotient = (255 - Math.floor((ya - this.x * 0x200) / (256 - this.x))) & 0xff;
          remainder = (this.x + ((ya - this.x * 0x200) % (256 - this.x))) & 0xff;
        }
        this.a = quotient;
        this.y = remainder;
        this.setNZ8(this.a);
        return;
      }

      // ── 11. Decimal adjust ───────────────────────────────────────────
      case 0xdf: { // DAA
        let a = this.a;
        if (a > 0x99 || this.c) {
          a = (a + 0x60) & 0x1ff;
          this.c = true;
        }
        if ((a & 0x0f) > 9 || this.h) a += 0x06;
        this.a = a & 0xff;
        this.setNZ8(this.a);
        return;
      }
      case 0xbe: { // DAS
        let a = this.a;
        if (a > 0x99 || !this.c) {
          a -= 0x60;
          this.c = false;
        }
        if ((a & 0x0f) > 9 || !this.h) a -= 0x06;
        this.a = a & 0xff;
        this.setNZ8(this.a);
        return;
      }

      // ── 12. Branches ─────────────────────────────────────────────────
      case 0x2f: { // BRA rel
        // The operand fetch MUST be sequenced before `this.pc` is read: a real
        // relative branch is taken from the address *after* the operand byte.
        // Writing this as a single `this.pc + int8(this.fetch8())` expression
        // silently reads the pre-fetch `pc` (JS evaluates the left operand
        // first), landing every BRA one byte short -- a real bug that shipped
        // here and desynchronised the driver's main loop (see §18.20).
        const rel = this.fetch8();
        this.pc = (this.pc + int8(rel)) & 0xffff;
        return;
      }
      case 0xf0: // BEQ
        this.branch(this.z, this.fetch8());
        return;
      case 0xd0: // BNE
        this.branch(!this.z, this.fetch8());
        return;
      case 0x30: // BMI
        this.branch(this.n, this.fetch8());
        return;
      case 0x10: // BPL
        this.branch(!this.n, this.fetch8());
        return;
      case 0xb0: // BCS
        this.branch(this.c, this.fetch8());
        return;
      case 0x90: // BCC
        this.branch(!this.c, this.fetch8());
        return;
      case 0x70: // BVS
        this.branch(this.v, this.fetch8());
        return;
      case 0x50: // BVC
        this.branch(!this.v, this.fetch8());
        return;

      case 0x03: case 0x23: case 0x43: case 0x63: // BBS dp.bit,rel
      case 0x83: case 0xa3: case 0xc3: case 0xe3: {
        const bit = opcode >> 5;
        const dpAddr = this.fetch8();
        const rel = this.fetch8();
        const v = R(this.dp + dpAddr);
        this.branch(((v >> bit) & 1) === 1, rel);
        return;
      }
      case 0x13: case 0x33: case 0x53: case 0x73: // BBC dp.bit,rel
      case 0x93: case 0xb3: case 0xd3: case 0xf3: {
        const bit = opcode >> 5;
        const dpAddr = this.fetch8();
        const rel = this.fetch8();
        const v = R(this.dp + dpAddr);
        this.branch(((v >> bit) & 1) === 0, rel);
        return;
      }
      case 0x2e: { // CBNE dp,rel
        const dpAddr = this.fetch8();
        const rel = this.fetch8();
        const v = R(this.dp + dpAddr);
        this.branch(v !== this.a, rel);
        return;
      }
      case 0xde: { // CBNE dp+X,rel
        const dpAddr = this.fetch8();
        const rel = this.fetch8();
        const v = R(this.dp + ((dpAddr + this.x) & 0xff));
        this.branch(v !== this.a, rel);
        return;
      }
      case 0x6e: { // DBNZ dp,rel
        const dpAddr = this.fetch8();
        const addr = this.dp + dpAddr;
        const v = (R(addr) - 1) & 0xff;
        W(addr, v);
        const rel = this.fetch8();
        this.branch(v !== 0, rel);
        return;
      }
      case 0xfe: // DBNZ Y,rel
        this.y = (this.y - 1) & 0xff;
        this.branch(this.y !== 0, this.fetch8());
        return;

      case 0x1f: { // JMP [abs+X]
        const tableAddr = (this.fetch16() + this.x) & 0xffff;
        this.pc = this.read16(tableAddr);
        return;
      }
      case 0x5f: // JMP abs
        this.pc = this.fetch16();
        return;

      // ── 13. Subroutine call/return ───────────────────────────────────
      case 0x3f: { // CALL abs
        const target = this.fetch16();
        this.push16(this.pc);
        this.pc = target;
        return;
      }
      case 0x6f: // RET
        this.pc = this.pop16();
        return;
      case 0x7f: { // RET1
        const psw = this.pop8();
        this.pc = this.pop16();
        this.setPsw(psw);
        return;
      }
      case 0x0f: { // BRK
        const retAddr = this.pc;
        this.push16(retAddr);
        this.push8(this.getPsw());
        this.b = true;
        this.i = false;
        this.pc = this.read16(0xffde);
        return;
      }
      case 0x4f: { // PCALL offset
        const off = this.fetch8();
        this.push16(this.pc);
        this.pc = 0xff00 | off;
        return;
      }
      case 0x01: case 0x11: case 0x21: case 0x31: // TCALL n
      case 0x41: case 0x51: case 0x61: case 0x71:
      case 0x81: case 0x91: case 0xa1: case 0xb1:
      case 0xc1: case 0xd1: case 0xe1: case 0xf1: {
        const n = opcode >> 4;
        this.push16(this.pc);
        this.pc = this.read16(0xffde - n * 2);
        return;
      }

      // ── 14. Stack ────────────────────────────────────────────────────
      case 0x0d: // PUSH PSW
        this.push8(this.getPsw());
        return;
      case 0x2d: // PUSH A
        this.push8(this.a);
        return;
      case 0x4d: // PUSH X
        this.push8(this.x);
        return;
      case 0x6d: // PUSH Y
        this.push8(this.y);
        return;
      case 0x8e: // POP PSW
        this.setPsw(this.pop8());
        return;
      case 0xae: // POP A
        this.a = this.pop8();
        return;
      case 0xce: // POP X
        this.x = this.pop8();
        return;
      case 0xee: // POP Y
        this.y = this.pop8();
        return;

      // ── 15. Bit ops ──────────────────────────────────────────────────
      case 0x02: case 0x22: case 0x42: case 0x62: // SET1 dp.bit
      case 0x82: case 0xa2: case 0xc2: case 0xe2: {
        const bit = opcode >> 5;
        const addr = this.dp + this.fetch8();
        W(addr, R(addr) | (1 << bit));
        return;
      }
      case 0x12: case 0x32: case 0x52: case 0x72: // CLR1 dp.bit
      case 0x92: case 0xb2: case 0xd2: case 0xf2: {
        const bit = opcode >> 5;
        const addr = this.dp + this.fetch8();
        W(addr, R(addr) & ~(1 << bit));
        return;
      }
      case 0x0e: { // TSET1 abs
        const addr = this.fetch16();
        const mem = R(addr);
        this.setNZ8((this.a - mem) & 0xff);
        W(addr, mem | this.a);
        return;
      }
      case 0x4e: { // TCLR1 abs
        const addr = this.fetch16();
        const mem = R(addr);
        this.setNZ8((this.a - mem) & 0xff);
        W(addr, mem & ~this.a);
        return;
      }
      case 0x4a: { // AND1 C,mem.bit
        const raw = this.fetch16();
        const addr = raw & 0x1fff;
        const bit = raw >> 13;
        this.c = this.c && ((R(addr) >> bit) & 1) === 1;
        return;
      }
      case 0x6a: { // AND1 C,/mem.bit
        const raw = this.fetch16();
        const addr = raw & 0x1fff;
        const bit = raw >> 13;
        this.c = this.c && ((R(addr) >> bit) & 1) === 0;
        return;
      }
      case 0x0a: { // OR1 C,mem.bit
        const raw = this.fetch16();
        const addr = raw & 0x1fff;
        const bit = raw >> 13;
        this.c = this.c || ((R(addr) >> bit) & 1) === 1;
        return;
      }
      case 0x2a: { // OR1 C,/mem.bit
        const raw = this.fetch16();
        const addr = raw & 0x1fff;
        const bit = raw >> 13;
        this.c = this.c || ((R(addr) >> bit) & 1) === 0;
        return;
      }
      case 0x8a: { // EOR1 C,mem.bit
        const raw = this.fetch16();
        const addr = raw & 0x1fff;
        const bit = raw >> 13;
        this.c = this.c !== (((R(addr) >> bit) & 1) === 1);
        return;
      }
      case 0xea: { // NOT1 mem.bit
        const raw = this.fetch16();
        const addr = raw & 0x1fff;
        const bit = raw >> 13;
        W(addr, R(addr) ^ (1 << bit));
        return;
      }
      case 0xca: { // MOV1 mem.bit,C
        const raw = this.fetch16();
        const addr = raw & 0x1fff;
        const bit = raw >> 13;
        const mem = R(addr);
        W(addr, this.c ? mem | (1 << bit) : mem & ~(1 << bit));
        return;
      }
      case 0xaa: { // MOV1 C,mem.bit
        const raw = this.fetch16();
        const addr = raw & 0x1fff;
        const bit = raw >> 13;
        this.c = ((R(addr) >> bit) & 1) === 1;
        return;
      }

      // ── 16. PSW flag ops ─────────────────────────────────────────────
      case 0x60: // CLRC
        this.c = false;
        return;
      case 0x80: // SETC
        this.c = true;
        return;
      case 0xed: // NOTC
        this.c = !this.c;
        return;
      case 0xe0: // CLRV
        this.v = false;
        this.h = false;
        return;
      case 0x20: // CLRP
        this.p = false;
        return;
      case 0x40: // SETP
        this.p = true;
        return;
      case 0xa0: // EI
        this.i = true;
        return;
      case 0xc0: // DI
        this.i = false;
        return;

      // ── 17. Other ────────────────────────────────────────────────────
      case 0x00: // NOP
        return;
      case 0xef: // SLEEP
      case 0xff: // STOP
        this.stopped = true;
        this.pc = (this.pc - 1) & 0xffff; // real hardware: PC never advances past a STOP/SLEEP
        return;

      default:
        throw new Error(`Spc700Cpu: unimplemented opcode 0x${opcode.toString(16).padStart(2, '0')} at PC 0x${((this.pc - 1) & 0xffff).toString(16)}`);
    }
  }
}
