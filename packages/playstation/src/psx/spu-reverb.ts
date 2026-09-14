/**
 * The PlayStation SPU's reverb DSP.
 *
 * This is console hardware, not any one game's format. The tables below were
 * confirmed against a real title's own copy of libspu, so the numbers are
 * sourced rather than looked up, and are the standard SDK preset set (not
 * per-game tuning):
 *
 *   * `SPU_REVERB_BASE`    -- 10 x u32, the reverb work-area start address
 *     (`mBASE`, in 8-byte units) libspu reserves for each reverb mode.
 *     Consumed by `SpuReserveReverbWorkArea` and `SpuSetReverbModeParam`.
 *   * `SPU_REVERB_PRESETS` -- 10 entries of 68 bytes (two u16 of padding,
 *     then the 32 reverb registers). `SpuSetReverbModeParam` selects
 *     `base + 68*mode` and copies the 68 bytes.
 *
 * Mode numbering is libspu's: 0 = OFF, 1 = ROOM, 2 = STUDIO_A, 3 = STUDIO_B,
 * 4 = STUDIO_C, 5 = HALL, 6 = SPACE, 7 = ECHO, 8 = DELAY, 9 = PIPE. Confirmed
 * by the work-area sizes the base table implies -- `0x80000 - mBASE*8` gives
 * exactly libspu's documented 0x26C0 / 0x1F40 / 0x4840 / 0x6FE0 / 0xADE0 /
 * 0xF6C0 / 0x18040 / 0x18040 / 0x3C00 for modes 1-9.
 *
 * The register values are addresses/displacements in **8-byte units** (= 4
 * SPU halfwords), not halfwords. Confirmed by a zero-deviation fit: for each
 * of the six room/hall presets, `max(address field) * 8` lands within 8-48
 * bytes of that mode's declared work-area size and never over it.
 *
 * The DSP itself follows the documented hardware formula, run at 22,050 Hz
 * with the SPU's 39-tap half-band FIR resampling the bus down and the result
 * back up. Verified structurally against the presets' own arithmetic: mode 8
 * (DELAY) has `vWALL = 0`, `vIIR = 0x7FFF`, a single unit comb tap and
 * `vAPF1 = vAPF2 = 0`, so it must emit exactly one echo, `(mLSAME - dLSAME) *
 * 4 / 22050` seconds after an impulse -- confirmed by this implementation
 * producing one isolated burst peaking within the FIR's own group-delay
 * budget of that predicted time. Mode 7 (ECHO), identical but with `vWALL =
 * 0x8100`, produces the expected repeating echo train instead.
 */

/** `mBASE` per libspu reverb mode, in 8-byte units. */
export const SPU_REVERB_BASE: readonly number[] = [
  0xfffe, 0xfb28, 0xfc18, 0xf6f8, 0xf204, 0xea44, 0xe128, 0xcff8, 0xcff8, 0xf880,
];

/**
 * The 32 reverb registers per libspu mode, in the hardware's register order:
 * `dAPF1, dAPF2, vIIR, vCOMB1..4, vWALL, vAPF1, vAPF2, mLSAME, mRSAME,
 * mLCOMB1, mRCOMB1, mLCOMB2, mRCOMB2, dLSAME, dRSAME, mLDIFF, mRDIFF,
 * mLCOMB3, mRCOMB3, mLCOMB4, mRCOMB4, dLDIFF, dRDIFF, mLAPF1, mRAPF1,
 * mLAPF2, mRAPF2, vLIN, vRIN`.
 */
export const SPU_REVERB_PRESETS: readonly (readonly number[])[] = [
  [0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000],
  [0x007d, 0x005b, 0x6d80, 0x54b8, 0xbed0, 0x0000, 0x0000, 0xba80, 0x5800, 0x5300, 0x04d6, 0x0333, 0x03f0, 0x0227, 0x0374, 0x01ef, 0x0334, 0x01b5, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x01b4, 0x0136, 0x00b8, 0x005c, 0x8000, 0x8000],
  [0x0033, 0x0025, 0x70f0, 0x4fa8, 0xbce0, 0x4410, 0xc0f0, 0x9c00, 0x5280, 0x4ec0, 0x03e4, 0x031b, 0x03a4, 0x02af, 0x0372, 0x0266, 0x031c, 0x025d, 0x025c, 0x018e, 0x022f, 0x0135, 0x01d2, 0x00b7, 0x018f, 0x00b5, 0x00b4, 0x0080, 0x004c, 0x0026, 0x8000, 0x8000],
  [0x00b1, 0x007f, 0x70f0, 0x4fa8, 0xbce0, 0x4510, 0xbef0, 0xb4c0, 0x5280, 0x4ec0, 0x0904, 0x076b, 0x0824, 0x065f, 0x07a2, 0x0616, 0x076c, 0x05ed, 0x05ec, 0x042e, 0x050f, 0x0305, 0x0462, 0x02b7, 0x042f, 0x0265, 0x0264, 0x01b2, 0x0100, 0x0080, 0x8000, 0x8000],
  [0x00e3, 0x00a9, 0x6f60, 0x4fa8, 0xbce0, 0x4510, 0xbef0, 0xa680, 0x5680, 0x52c0, 0x0dfb, 0x0b58, 0x0d09, 0x0a3c, 0x0bd9, 0x0973, 0x0b59, 0x08da, 0x08d9, 0x05e9, 0x07ec, 0x04b0, 0x06ef, 0x03d2, 0x05ea, 0x031d, 0x031c, 0x0238, 0x0154, 0x00aa, 0x8000, 0x8000],
  [0x01a5, 0x0139, 0x6000, 0x5000, 0x4c00, 0xb800, 0xbc00, 0xc000, 0x6000, 0x5c00, 0x15ba, 0x11bb, 0x14c2, 0x10bd, 0x11bc, 0x0dc1, 0x11c0, 0x0dc3, 0x0dc0, 0x09c1, 0x0bc4, 0x07c1, 0x0a00, 0x06cd, 0x09c2, 0x05c1, 0x05c0, 0x041a, 0x0274, 0x013a, 0x8000, 0x8000],
  [0x033d, 0x0231, 0x7e00, 0x5000, 0xb400, 0xb000, 0x4c00, 0xb000, 0x6000, 0x5400, 0x1ed6, 0x1a31, 0x1d14, 0x183b, 0x1bc2, 0x16b2, 0x1a32, 0x15ef, 0x15ee, 0x1055, 0x1334, 0x0f2d, 0x11f6, 0x0c5d, 0x1056, 0x0ae1, 0x0ae0, 0x07a2, 0x0464, 0x0232, 0x8000, 0x8000],
  [0x0001, 0x0001, 0x7fff, 0x7fff, 0x0000, 0x0000, 0x0000, 0x8100, 0x0000, 0x0000, 0x1fff, 0x0fff, 0x1005, 0x0005, 0x0000, 0x0000, 0x1005, 0x0005, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x1004, 0x1002, 0x0004, 0x0002, 0x8000, 0x8000],
  [0x0001, 0x0001, 0x7fff, 0x7fff, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x1fff, 0x0fff, 0x1005, 0x0005, 0x0000, 0x0000, 0x1005, 0x0005, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x1004, 0x1002, 0x0004, 0x0002, 0x8000, 0x8000],
  [0x0017, 0x0013, 0x70f0, 0x4fa8, 0xbce0, 0x4510, 0xbef0, 0x8500, 0x5f80, 0x54c0, 0x0371, 0x02af, 0x02e5, 0x01df, 0x02b0, 0x01d7, 0x0358, 0x026a, 0x01d6, 0x011e, 0x012d, 0x00b1, 0x011f, 0x0059, 0x01a0, 0x00e3, 0x0058, 0x0040, 0x0028, 0x0014, 0x8000, 0x8000],
];

/** Index of each reverb register inside a `SPU_REVERB_PRESETS` row. */
const F = {
  dAPF1: 0, dAPF2: 1, vIIR: 2, vCOMB1: 3, vCOMB2: 4, vCOMB3: 5, vCOMB4: 6, vWALL: 7,
  vAPF1: 8, vAPF2: 9, mLSAME: 10, mRSAME: 11, mLCOMB1: 12, mRCOMB1: 13, mLCOMB2: 14,
  mRCOMB2: 15, dLSAME: 16, dRSAME: 17, mLDIFF: 18, mRDIFF: 19, mLCOMB3: 20, mRCOMB3: 21,
  mLCOMB4: 22, mRCOMB4: 23, dLDIFF: 24, dRDIFF: 25, mLAPF1: 26, mRAPF1: 27, mLAPF2: 28,
  mRAPF2: 29, vLIN: 30, vRIN: 31,
} as const;

/**
 * The SPU's 39-tap half-band FIR, used both to filter the 44.1 kHz reverb bus
 * down to the DSP's 22.05 kHz rate and to filter the DSP's output back up.
 * Every second tap is zero except the centre one, which is what makes the odd
 * upsample phase a pure delay.
 */
const FIR: readonly number[] = [
  -1, 0, 2, 0, -10, 0, 35, 0, -103, 0, 266, 0, -616, 0, 1332, 0, -2960, 0, 10246,
  16384,
  10246, 0, -2960, 0, 1332, 0, -616, 0, 266, 0, -103, 0, 35, 0, -10, 0, 2, 0, -1,
].map((c) => c / 32768);
const FIR_NZ: [number, number][] = [];
const FIR_EVEN: [number, number][] = [];
for (let i = 0; i < FIR.length; i++) {
  if (FIR[i] !== 0) {
    FIR_NZ.push([i, FIR[i]!]);
    if (i % 2 === 0) FIR_EVEN.push([i, FIR[i]!]);
  }
}

const s16 = (v: number): number => (v > 0x7fff ? v - 0x10000 : v);
/** A reverb coefficient as a signed 1.15 fraction. */
const q15 = (v: number): number => s16(v) / 0x8000;
const sat = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

/**
 * One instance of the SPU reverb, for one libspu mode. Feed the reverb bus
 * (the sum of every voice whose reverb bit is set, post volume and pan) one
 * 44,100 Hz stereo sample at a time with `step`; add the result to the dry
 * mix scaled by the reverb output volume.
 */
export class SpuReverb {
  private readonly buf: Float32Array;
  private readonly cap: number;
  private pos = 0;
  private readonly p: readonly number[];
  private readonly inL = new Float32Array(39);
  private readonly inR = new Float32Array(39);
  private inPos = 0;
  private readonly outL = new Float32Array(20);
  private readonly outR = new Float32Array(20);
  private outPos = 0;
  private phase = 0;
  /** False for mode 0 (`SPU_REV_MODE_OFF`), whose work area is 16 bytes. */
  readonly enabled: boolean;

  constructor(mode: number) {
    const m = mode >= 0 && mode < SPU_REVERB_PRESETS.length ? mode : 0;
    this.p = SPU_REVERB_PRESETS[m]!;
    this.cap = Math.max(1, 0x40000 - SPU_REVERB_BASE[m]! * 4);
    this.buf = new Float32Array(this.cap);
    this.enabled = m !== 0 && this.cap > 8;
  }

  private rd(off: number): number {
    let i = (this.pos + off) % this.cap;
    if (i < 0) i += this.cap;
    return this.buf[i]!;
  }

  private wr(off: number, v: number): void {
    let i = (this.pos + off) % this.cap;
    if (i < 0) i += this.cap;
    this.buf[i] = sat(v);
  }

  /** One 22,050 Hz reverb cycle -- the documented hardware formula, verbatim. */
  private tick(lin: number, rin: number): void {
    const p = this.p;
    const A = (f: number): number => p[f]! * 4;
    const vIIR = q15(p[F.vIIR]!);
    const vWALL = q15(p[F.vWALL]!);
    const Lin = q15(p[F.vLIN]!) * lin;
    const Rin = q15(p[F.vRIN]!) * rin;

    // Same-side reflection (left->left, right->right).
    let prev = this.rd(A(F.mLSAME) - 1);
    this.wr(A(F.mLSAME), (Lin + this.rd(A(F.dLSAME)) * vWALL - prev) * vIIR + prev);
    prev = this.rd(A(F.mRSAME) - 1);
    this.wr(A(F.mRSAME), (Rin + this.rd(A(F.dRSAME)) * vWALL - prev) * vIIR + prev);
    // Different-side reflection (left->right, right->left).
    prev = this.rd(A(F.mLDIFF) - 1);
    this.wr(A(F.mLDIFF), (Lin + this.rd(A(F.dRDIFF)) * vWALL - prev) * vIIR + prev);
    prev = this.rd(A(F.mRDIFF) - 1);
    this.wr(A(F.mRDIFF), (Rin + this.rd(A(F.dLDIFF)) * vWALL - prev) * vIIR + prev);

    // Early echo (4-tap comb, reading the buffer).
    const c1 = q15(p[F.vCOMB1]!);
    const c2 = q15(p[F.vCOMB2]!);
    const c3 = q15(p[F.vCOMB3]!);
    const c4 = q15(p[F.vCOMB4]!);
    let lo = c1 * this.rd(A(F.mLCOMB1)) + c2 * this.rd(A(F.mLCOMB2)) + c3 * this.rd(A(F.mLCOMB3)) + c4 * this.rd(A(F.mLCOMB4));
    let ro = c1 * this.rd(A(F.mRCOMB1)) + c2 * this.rd(A(F.mRCOMB2)) + c3 * this.rd(A(F.mRCOMB3)) + c4 * this.rd(A(F.mRCOMB4));

    // Late reverb: two all-pass stages.
    const vAPF1 = q15(p[F.vAPF1]!);
    let t = this.rd(A(F.mLAPF1) - A(F.dAPF1));
    lo -= vAPF1 * t;
    this.wr(A(F.mLAPF1), lo);
    lo = lo * vAPF1 + t;
    t = this.rd(A(F.mRAPF1) - A(F.dAPF1));
    ro -= vAPF1 * t;
    this.wr(A(F.mRAPF1), ro);
    ro = ro * vAPF1 + t;

    const vAPF2 = q15(p[F.vAPF2]!);
    t = this.rd(A(F.mLAPF2) - A(F.dAPF2));
    lo -= vAPF2 * t;
    this.wr(A(F.mLAPF2), lo);
    lo = lo * vAPF2 + t;
    t = this.rd(A(F.mRAPF2) - A(F.dAPF2));
    ro -= vAPF2 * t;
    this.wr(A(F.mRAPF2), ro);
    ro = ro * vAPF2 + t;

    this.pos = this.pos + 1 === this.cap ? 0 : this.pos + 1;
    this.outL[this.outPos] = sat(lo);
    this.outR[this.outPos] = sat(ro);
    this.outPos = this.outPos + 1 === 20 ? 0 : this.outPos + 1;
  }

  /**
   * Feed one 44,100 Hz stereo sample of the reverb bus; returns that sample's
   * reverb output into `out` (before the reverb output volume). The DSP only
   * runs on every second call -- the odd sample is the FIR's interpolated
   * phase.
   */
  step(l: number, r: number, out: [number, number]): void {
    this.inL[this.inPos] = l;
    this.inR[this.inPos] = r;
    this.inPos = this.inPos + 1 === 39 ? 0 : this.inPos + 1;
    if (this.phase === 0) {
      let dl = 0;
      let dr = 0;
      for (const [i, c] of FIR_NZ) {
        let j = (this.inPos - 1 - i) % 39;
        if (j < 0) j += 39;
        dl += c * this.inL[j]!;
        dr += c * this.inR[j]!;
      }
      this.tick(dl, dr);
      let yl = 0;
      let yr = 0;
      for (const [i, c] of FIR_EVEN) {
        let j = (this.outPos - 1 - (i >> 1)) % 20;
        if (j < 0) j += 20;
        yl += 2 * c * this.outL[j]!;
        yr += 2 * c * this.outR[j]!;
      }
      out[0] = yl;
      out[1] = yr;
    } else {
      let j = (this.outPos - 1 - 9) % 20;
      if (j < 0) j += 20;
      out[0] = this.outL[j]!;
      out[1] = this.outR[j]!;
    }
    this.phase ^= 1;
  }
}
