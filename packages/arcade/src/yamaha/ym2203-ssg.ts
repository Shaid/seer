/**
 * Register-driven YM2203 SSG (PSG) section: 3 square tones, 17-bit LFSR noise, mixer, 4-bit volumes (hardware
 * envelope generator not modelled; Black Tiger's SSG player never enables it, section 2.1.2).
 *
 * Structure follows the ymfm SSG engine that MAME 0.289 uses (BSD-3, aaronsgiles/ymfm `ymfm_ssg.cpp`): the engine
 * toggles a tone every `period` engine clocks, so f = engineRate / (2 N); with the YM2203 default FM prescaler (/6)
 * the engine runs at master/16, giving f = master / (32 N).  Octave verdict: MAME-ref matched, see
 * the kolbold repo, docs/blktiger/arcade/data-structure.md sec 2.1.4.  Not hardware ground truth.
 */

/** Level table by 4-bit volume register value (index 0 = silent). v -> ymfm amplitude[2v+1]. */
export const SSG_LEVELS: readonly number[] = [0, 141, 222, 306, 441, 585, 836, 1112, 1595, 2146, 3081, 4135, 6006, 8155, 11976, 16382];

export class Ym2203Ssg {
  readonly engineRate: number;
  private reg = new Uint8Array(16);
  private toneCount = [0, 0, 0];
  private toneState = [0, 0, 0];
  private noiseCount = 0;
  private noiseState = 1;
  private frac = 0;

  readonly master: number;
  readonly divisor: number;
  private levels: readonly number[];

  /** @param master chip clock (3 579 545 Hz) @param divisor engine rate = master / divisor (MAME ymfm: 16) */
  constructor(master = 3_579_545, divisor = 16, levels: readonly number[] = SSG_LEVELS) {
    this.master = master;
    this.divisor = divisor;
    this.levels = levels;
    this.engineRate = master / divisor;
  }

  write(reg: number, val: number): void {
    if (reg < 16) this.reg[reg] = val;
  }

  private clockEngine(): void {
    for (let c = 0; c < 3; c++) {
      const p = this.reg[c * 2] | ((this.reg[c * 2 + 1] & 15) << 8);
      this.toneCount[c]++;
      if (this.toneCount[c] >= p) {
        this.toneState[c] ^= 1;
        this.toneCount[c] = 0;
      }
    }
    this.noiseCount++;
    if (this.noiseCount >> 1 >= (this.reg[6] & 31) && this.noiseCount !== 1) {
      this.noiseState ^= (((this.noiseState & 1) ^ ((this.noiseState >> 3) & 1)) << 17);
      this.noiseState >>= 1;
      this.noiseCount = 0;
    }
  }

  private level(): number {
    let sum = 0;
    const mix = this.reg[7];
    for (let c = 0; c < 3; c++) {
      const noiseOn = ((mix >> (3 + c)) & 1) | (this.noiseState & 1);
      const toneOn = ((mix >> c) & 1) | this.toneState[c];
      if ((noiseOn & toneOn) === 0) continue;
      sum += this.levels[this.reg[8 + c] & 15];
    }
    return sum;
  }

  /** One output sample at `rate` Hz: box-average of the engine-rate level over the sample period. */
  sample(rate: number): number {
    const step = this.engineRate / rate;
    this.frac += step;
    const n = Math.floor(this.frac);
    this.frac -= n;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.clockEngine();
      acc += this.level();
    }
    return n > 0 ? acc / n : this.level();
  }
}
