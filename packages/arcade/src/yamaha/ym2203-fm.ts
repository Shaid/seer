/**
 * Software YM2203 (OPN) FM section, driven by a register-write stream.
 *
 * ACCURACY TIER: "MAME-ymfm matched, not hardware ground truth". The model follows the published OPN
 * architecture and the ymfm structure: 10-bit phase generator with the detune table and MUL, 10-bit attenuation
 * envelope generator clocked every 3 FM samples with the standard rate/increment tables and key scaling (state
 * transition evaluated before rate selection, as in ymfm), quarter-wave log-sin and exp tables (computed from
 * their defining formulas rather than copied), the 8 algorithms, 2-sample-averaged operator-1 feedback, TL/SL/RR.
 * Checked against MAME 0.289 (ymfm) on Black Tiger's music: identical register streams render within
 * 0.03-0.18 dB and ~0.01 cent (kolbold repo, docs/blktiger/arcade/data-structure.md sec 2.1.4). Maximum-feedback
 * channels match in level but not waveform (feedback 7 is chaotic). Not modelled: timers/IRQ, 3-slot mode / CSM,
 * SSG-EG, the DAC/ladder non-linearity of real silicon.
 *
 * Sample rate `fs = clock / 72` (prescaler /6 as selected by the sound driver's write to reg 0x2D).
 */

export const OPN_PRESCALE = 72;

/** 10-bit quarter-wave log-sin table: `round(-log2(sin((2i+1)*pi/1024)) * 256)` (4.8 fixed point attenuation). */
const LOGSIN: number[] = Array.from({ length: 256 }, (_, i) => Math.round(-Math.log2(Math.sin(((2 * i + 1) * Math.PI) / 1024)) * 256));
/** exp table: `round(2048 * 2^(-(i+1)/256))` (0x7FA..0x400 range as on the chip). */
const POW: number[] = Array.from({ length: 256 }, (_, i) => Math.round(2048 * 2 ** (-(i + 1) / 256)));

function attenuationToVolume(att: number): number {
  const sh = att >> 8;
  if (sh > 13) return 0;
  return ((POW[att & 0xff] | 0x400) << 2) >> sh;
}

// detune table [keycode 0..31][dt&3]
const DETUNE: number[][] = [
  [0, 0, 1, 2], [0, 0, 1, 2], [0, 0, 1, 2], [0, 0, 1, 2],
  [0, 1, 2, 2], [0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3],
  [0, 1, 2, 4], [0, 1, 3, 4], [0, 1, 3, 4], [0, 1, 3, 5],
  [0, 2, 4, 5], [0, 2, 4, 6], [0, 2, 4, 6], [0, 2, 5, 7],
  [0, 2, 5, 8], [0, 3, 6, 8], [0, 3, 6, 9], [0, 3, 7, 10],
  [0, 4, 8, 11], [0, 4, 8, 12], [0, 4, 9, 13], [0, 5, 10, 14],
  [0, 5, 11, 16], [0, 6, 12, 17], [0, 6, 13, 19], [0, 7, 14, 20],
  [0, 8, 16, 22], [0, 8, 16, 22], [0, 8, 16, 22], [0, 8, 16, 22],
];

// EG increment patterns (8 phases) by row
const ROW = [
  [0, 1, 0, 1, 0, 1, 0, 1], [0, 1, 0, 1, 1, 1, 0, 1], [0, 1, 1, 1, 0, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 2, 1, 1, 1, 2], [1, 2, 1, 2, 1, 2, 1, 2], [1, 2, 2, 2, 1, 2, 2, 2],
  [2, 2, 2, 2, 2, 2, 2, 2], [2, 2, 2, 4, 2, 2, 2, 4], [2, 4, 2, 4, 2, 4, 2, 4], [2, 4, 4, 4, 2, 4, 4, 4],
  [4, 4, 4, 4, 4, 4, 4, 4], [4, 4, 4, 8, 4, 4, 4, 8], [4, 8, 4, 8, 4, 8, 4, 8], [4, 8, 8, 8, 4, 8, 8, 8],
  [8, 8, 8, 8, 8, 8, 8, 8],
];
const ZERO8 = [0, 0, 0, 0, 0, 0, 0, 0];
/** rate (0..63) -> 8-phase increment pattern */
const RATE_PATTERN: number[][] = Array.from({ length: 64 }, (_, r) => {
  if (r < 2) return ZERO8;
  if (r < 4) return ROW[0];
  if (r < 8) return r < 6 ? ROW[0] : ROW[2];
  if (r < 48) return ROW[r & 3];
  if (r < 60) return ROW[4 + (r - 48)];
  return ROW[16];
});

const ATTACK = 0;
const DECAY = 1;
const SUSTAIN = 2;
const RELEASE = 3;

interface Op {
  dt: number;
  mul: number;
  tl: number;
  ks: number;
  ar: number;
  d1r: number;
  d2r: number;
  rr: number;
  sl: number;
  phase: number;
  step: number;
  att: number;
  state: number;
  keyOn: boolean;
  rates: number[]; // effective rate per state
  slLevel: number;
}

interface Chan {
  ops: Op[]; // index 0..3 = register slot order (offsets 0,4,8,C) = YM operators S1,S3,S2,S4
  fnum: number;
  block: number;
  latch: number;
  alg: number;
  fb: number;
  fb0: number;
  fb1: number;
}

const newOp = (): Op => ({
  dt: 0, mul: 0, tl: 127, ks: 0, ar: 0, d1r: 0, d2r: 0, rr: 0, sl: 0,
  phase: 0, step: 0, att: 0x3ff, state: RELEASE, keyOn: false, rates: [0, 0, 0, 0], slLevel: 0,
});

export class Ym2203Fm {
  readonly sampleRate: number;
  private ch: Chan[];
  private reg = new Uint8Array(256);
  private envDiv = 0;
  private envCounter = 0;

  readonly clock: number;

  constructor(clock = 3_579_545) {
    this.clock = clock;
    this.sampleRate = clock / OPN_PRESCALE;
    this.ch = Array.from({ length: 3 }, () => ({ ops: [newOp(), newOp(), newOp(), newOp()], fnum: 0, block: 0, latch: 0, alg: 0, fb: 0, fb0: 0, fb1: 0 }));
  }

  /** Register write (address and data already combined). */
  write(reg: number, val: number): void {
    this.reg[reg] = val;
    const c = reg & 3;
    if (reg >= 0x30 && reg < 0xa0) {
      if (c === 3) return;
      const slot = (reg >> 2) & 3; // 0,1,2,3 = offsets 0,4,8,C
      const op = this.ch[c].ops[slot];
      switch (reg & 0xf0) {
        case 0x30: op.dt = (val >> 4) & 7; op.mul = val & 15; break;
        case 0x40: op.tl = val & 0x7f; break;
        case 0x50: op.ks = val >> 6; op.ar = val & 31; break;
        case 0x60: op.d1r = val & 31; break;
        case 0x70: op.d2r = val & 31; break;
        case 0x80: op.sl = val >> 4; op.rr = val & 15; break;
        default: break;
      }
      this.refresh(c);
      return;
    }
    if (reg === 0x28) {
      const cc = val & 3;
      if (cc === 3) return;
      for (let s = 0; s < 4; s++) {
        // key-on bit order: bit4=S1 (offset 0), bit5=S2 (offset 8), bit6=S3 (offset 4), bit7=S4 (offset C)
        const bit = [4, 6, 5, 7][s];
        this.keyOnOff(this.ch[cc].ops[s], (val >> bit) & 1 ? true : false);
      }
      return;
    }
    if (reg >= 0xa0 && reg < 0xb0) {
      if (c === 3) return;
      if ((reg & 0xfc) === 0xa4) {
        this.ch[c].latch = val & 0x3f;
      } else if ((reg & 0xfc) === 0xa0) {
        this.ch[c].fnum = ((this.ch[c].latch & 7) << 8) | val;
        this.ch[c].block = (this.ch[c].latch >> 3) & 7;
        this.refresh(c);
      }
      return;
    }
    if (reg >= 0xb0 && reg < 0xb4) {
      this.ch[c].alg = val & 7;
      this.ch[c].fb = (val >> 3) & 7;
    }
  }

  private keyOnOff(op: Op, on: boolean): void {
    if (on && !op.keyOn) {
      op.keyOn = true;
      op.phase = 0;
      op.state = ATTACK;
      if (op.rates[ATTACK] >= 62) op.att = 0;
    } else if (!on && op.keyOn) {
      op.keyOn = false;
      op.state = RELEASE;
    }
  }

  /** Recompute phase steps, rates for channel c. */
  private refresh(c: number): void {
    const ch = this.ch[c];
    const { fnum, block } = ch;
    const f11 = (fnum >> 10) & 1;
    const f10 = (fnum >> 9) & 1;
    const f9 = (fnum >> 8) & 1;
    const f8 = (fnum >> 7) & 1;
    const n3 = f11 ? (f10 | f9 | f8) : (f10 & f9 & f8);
    const kc = (block << 2) | (f11 << 1) | n3;
    for (const op of ch.ops) {
      const base = (fnum << block) >> 1;
      const det = DETUNE[kc][op.dt & 3] * (op.dt & 4 ? -1 : 1);
      const fc = (base + det) & 0x1ffff;
      const mul2 = op.mul === 0 ? 1 : op.mul * 2;
      op.step = (fc * mul2) >> 1;
      const ksr = kc >> (3 - op.ks);
      const eff = (raw: number): number => (raw === 0 ? 0 : Math.min(63, raw + ksr));
      op.rates = [eff(op.ar * 2), eff(op.d1r * 2), eff(op.d2r * 2), Math.min(63, op.rr * 4 + 2 + ksr)];
      op.slLevel = (op.sl === 15 ? 31 : op.sl) << 5;
    }
  }

  private clockEnvelopes(): void {
    this.envCounter = (this.envCounter + 1) >>> 0;
    const cnt = this.envCounter;
    for (const ch of this.ch) {
      for (const op of ch.ops) {
        // ymfm order: state transitions are evaluated BEFORE the rate is picked, so a decay with D1R = 0 (or SL = 0)
        // hands over to the sustain (D2R) rate at once instead of staying in a zero-rate decay forever.
        if (op.state === ATTACK && op.att === 0) op.state = DECAY;
        if (op.state === DECAY && op.att >= op.slLevel) op.state = SUSTAIN;
        const rate = op.rates[op.state];
        if (rate === 0) continue;
        const shift = rate >> 2;
        const shifted = cnt << shift;
        if ((shifted & 0x7ff) !== 0) continue;
        const rel = (shifted >>> (shift <= 11 ? 11 : shift)) & 7;
        const inc = RATE_PATTERN[rate][rel];
        if (op.state === ATTACK) {
          if (rate < 62) op.att += ((~op.att) * inc) >> 4;
        } else {
          op.att += inc;
        }
        if (op.att >= 0x3ff) op.att = 0x3ff;
        if (op.att < 0) op.att = 0;
      }
    }
  }

  private opOut(op: Op, mod: number): number {
    if (op.att > 0x380) return 0; // ymfm EG_QUIET early-out (tests the raw envelope, before TL)
    const p = ((op.phase >>> 10) + mod) & 0x3ff;
    const idx = p & 0x100 ? ~p & 0xff : p & 0xff;
    const env = Math.min(op.att + (op.tl << 3), 0x3ff);
    const v = attenuationToVolume(LOGSIN[idx] + (env << 2));
    return p & 0x200 ? -v : v;
  }

  /** Generate one FM output sample (sum of three channels, ~ +-8168 per fully-open carrier). */
  sample(): number {
    if (++this.envDiv === 3) {
      this.envDiv = 0;
      this.clockEnvelopes();
    }
    let sum = 0;
    for (const ch of this.ch) {
      const [o1, o3, o2, o4] = ch.ops; // slot order -> operators 1,3,2,4
      const fbMod = ch.fb ? (ch.fb0 + ch.fb1) >> (10 - ch.fb) : 0;
      const out1 = this.opOut(o1, fbMod);
      ch.fb0 = ch.fb1;
      ch.fb1 = out1;
      let out = 0;
      switch (ch.alg) {
        case 0: out = this.opOut(o4, this.opOut(o3, this.opOut(o2, out1 >> 1) >> 1) >> 1); break;
        case 1: out = this.opOut(o4, this.opOut(o3, (out1 + this.opOut(o2, 0)) >> 1) >> 1); break;
        case 2: out = this.opOut(o4, (out1 + this.opOut(o3, this.opOut(o2, 0) >> 1)) >> 1); break;
        case 3: out = this.opOut(o4, (this.opOut(o2, out1 >> 1) + this.opOut(o3, 0)) >> 1); break;
        case 4: out = this.opOut(o2, out1 >> 1) + this.opOut(o4, this.opOut(o3, 0) >> 1); break;
        case 5: { const m = out1 >> 1; out = this.opOut(o2, m) + this.opOut(o3, m) + this.opOut(o4, m); break; }
        case 6: out = this.opOut(o2, out1 >> 1) + this.opOut(o3, 0) + this.opOut(o4, 0); break;
        default: out = out1 + this.opOut(o2, 0) + this.opOut(o3, 0) + this.opOut(o4, 0); break;
      }
      sum += Math.max(-32768, Math.min(32767, out));
      for (const op of ch.ops) op.phase = (op.phase + op.step) & 0xfffff;
    }
    return sum;
  }
}
