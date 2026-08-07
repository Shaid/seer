import { parseIff, findChunks, findChunk } from '@seer-project/iff';
import type {
  InstrEmbedded,
  InstrExternal,
  Instr8SVX,
  SsFile,
} from './sampled-sound.ts';

function readCString(data: Uint8Array, start = 0, maxLen?: number): string {
  const end = maxLen !== undefined ? Math.min(data.length, start + maxLen) : data.length;
  let result = '';
  for (let i = start; i < end; i++) {
    if (data[i] === 0) break;
    result += String.fromCharCode(data[i]);
  }
  return result.trim();
}

// ─── Constants ───────────────────────────────────────────────────────────

const FILTER_COEFFS = [
  0x8000, 0x7683, 0x6dba, 0x6597, 0x5e10, 0x5717, 0x50a2, 0x4aa8, 0x451f, 0x4000, 0x3b41, 0x36dd,
  0x32cb, 0x2f08, 0x2b8b, 0x2851, 0x2554, 0x228f, 0x2000, 0x1da0, 0x1b6e, 0x1965, 0x1784, 0x15c5,
  0x1428, 0x12aa, 0x1147, 0x1000, 0x0ed0, 0x0db7, 0x0cb2, 0x0bc2, 0x0ae2, 0x0a14, 0x0955, 0x08a3,
  0x0800, 0x0768, 0x06db, 0x0659, 0x05e1, 0x0571, 0x050a, 0x04aa, 0x0451, 0x0400, 0x03b4, 0x036d,
  0x032c, 0x02f0, 0x02b8, 0x0285, 0x0255, 0x0228, 0x0200, 0x01da, 0x01b6, 0x0196, 0x0178, 0x015c,
  0x0142, 0x012a, 0x0114, 0x0100,
];

const CHANNEL_PAN = [0, 1, 1, 0];

const NOTE_PERIOD = [
  0x8000, 0x78d1, 0x7209, 0x6ba2, 0x6598, 0x5fe4, 0x5a82, 0x556e, 0x50a3, 0x4c1c, 0x47d6, 0x43ce,
];

// ─── Helpers ─────────────────────────────────────────────────────────────

function toI16(x: number): number {
  x &= 0xffff;
  return x & 0x8000 ? x - 0x10000 : x;
}

function toI32(x: number): number {
  x &= 0xffffffff;
  return x & 0x80000000 ? x - 0x100000000 : x;
}

export function sonixRateUnits(r: number): number {
  r &= 0xffff;
  if (r === 0) return 4000;
  const exp = 7 ^ ((r >> 5) & 7);
  const mant = (r & 0x1f) + 0x21;
  return mant << exp;
}

export function sampleOctaveForMidi(midi: number, lo: number, hi: number): number {
  const octv = 10 - Math.floor(midi / 12);
  return Math.max(lo, Math.min(hi, octv));
}

function noteDurationBeats(flags: number): number {
  const division = flags & 0x07;
  const dotted = !!(flags & 0x08);
  const ntuplet = (flags >> 4) & 0x03;
  let beats = 4.0 / (1 << division);
  if (dotted) beats *= 1.5;
  if (ntuplet === 1) beats *= 2.0 / 3.0;
  else if (ntuplet === 2) beats *= 4.0 / 5.0;
  else if (ntuplet === 3) beats *= 4.0 / 7.0;
  return beats;
}

// ─── Sonix filter bank generator ────────────────────────────────────────

export function sonixOneFilter(wave128: Uint8Array): Int8Array {
  const wave = new Int16Array(128);
  for (let i = 0; i < 128; i++) {
    wave[i] = wave128[i] < 128 ? wave128[i] : wave128[i] - 256;
  }
  const out = new Int8Array(64 * 128);
  let d3 = 0;
  let d4 = toI16(wave[127] << 7);
  let oi = 0;
  for (let step = 0; step < 64; step++) {
    const d1 = FILTER_COEFFS[step];
    let d2 = (0x8000 - d1) & 0xffff;
    d2 = ((d2 * 0xe666) >>> 0) >>> 16;
    const d1s = d1 >>> 1;
    for (let s = 0; s < 128; s++) {
      const d6 = toI16(toI16(wave[s] << 7) - d4);
      let prod = toI32(toI16(d1s) * d6);
      prod = toI32(prod << 2);
      d3 = toI16(d3 + (prod >> 16));
      d4 = toI16(d4 + d3);
      const d4u = d4 & 0xffff;
      const ror = ((d4u >>> 7) | ((d4u & 0x7f) << 9)) & 0xffff;
      out[oi++] = ror & 0xff;
      const prod3 = toI32(toI16(d3) * toI16(d2));
      d3 = toI16(toI32(prod3 << 1) >> 16);
    }
  }
  return out;
}

// ─── Types ───────────────────────────────────────────────────────────────

export const SID_REST = 0x80;
export const SID_INSTRUMENT = 0x81;
export const SID_DYNAMIC = 0x84;
export const SID_TEMPO = 0x88;

export interface SEvent {
  sid: number;
  data: number;
}

export interface SmusScore {
  tempo: number;
  volume: number;
  name: string;
  instruments: Map<number, string>;
  tracks: SEvent[][];
}

export interface Instrument {
  name: string;
  kind: 'synth' | 'sample' | '8svx';
  wave: Float32Array;
  loopStart: number;
  loopEnd: number;
  baseMidi: number;
  baseRate: number;
  volume: number;
  filterBanks: Float32Array[] | null;
  modTable: Float32Array | null;
  envLevels: [number, number, number, number];
  envRates: [number, number, number, number];
  fBase: number;
  fEnv: number;
  fMod: number;
  lfoRate: number;
  lfoInc: number;
  lfoEnable: boolean;
  lfoOneshot: boolean;
  volRaw: number;
  volEnv: boolean;
  volMod: number;
  pitchMod: number;
  ssOneshot: number;
  ssRepeat: number;
  ssLo: number;
  ssHi: number;
  ssData: Float32Array | null;
  vibDepth: number;
  vibRate: number;
  vibDelay: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  filterStart: number;
  filterEnd: number;
}

interface VoiceState {
  active: boolean;
  channel: number;
  instrument: Instrument | null;
  pos: number;
  step: number;
  vol: number;
  samplesLeft: number;
  released: boolean;
  envLevel: number;
  envPhase: string;
  noteSamples: number;
  noteTotal: number;
  envFixed: number;
  envStage: number;
  lfoPhase: number;
  lfoFrozen: boolean;
  lfoMod: number;
  vibPhase: number;
  vibDelayLeft: number;
  sampleWave: Float32Array | null;
  sampleLoopStart: number;
  sampleLoopEnd: number;
  noteFreq: number;
  holdPhase: number;
  holdAmp: number;
  canHold: boolean;
  inHold: boolean;
}

interface TrackState {
  events: SEvent[];
  index: number;
  wait: number;
  instrumentReg: number;
  volume: number;
  chordNotes: Array<[number, number]>;
  done: boolean;
}

// ─── Instrument factory ──────────────────────────────────────────────────

function makeInstrument(
  name: string,
  kind: Instrument['kind'],
  wave: Float32Array,
  loopStart: number,
  loopEnd: number,
  baseMidi: number,
  baseRate: number,
): Instrument {
  return {
    name,
    kind,
    wave,
    loopStart,
    loopEnd,
    baseMidi,
    baseRate,
    volume: 1.0,
    filterBanks: null,
    modTable: null,
    envLevels: [255, 255, 200, 0],
    envRates: [128, 128, 128, 64],
    fBase: 128,
    fEnv: 0,
    fMod: 0,
    lfoRate: 0,
    lfoInc: 0,
    lfoEnable: false,
    lfoOneshot: true,
    volRaw: 255,
    volEnv: true,
    volMod: 0,
    pitchMod: 0,
    ssOneshot: 0,
    ssRepeat: 0,
    ssLo: 0,
    ssHi: 0,
    ssData: null,
    vibDepth: 0,
    vibRate: 0,
    vibDelay: 0,
    attack: 0.01,
    decay: 0.1,
    sustain: 0.7,
    release: 0.15,
    filterStart: 0.35,
    filterEnd: 0.7,
  };
}

export function defaultInstrument(name: string = 'default'): Instrument {
  const wave = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    const t = (2 * Math.PI * i) / 128;
    wave[i] = 0.4 * Math.sin(t) + 0.2 * Math.sin(2 * t);
  }
  return makeInstrument(name, 'synth', wave, 0, 128, 60, 16574.27);
}

// ─── SMUS parser (browser-compatible, uses existing IFF parser) ─────────

export function parseSmusScore(buffer: ArrayBuffer): SmusScore {
  const form = parseIff(buffer);
  if (!form || form.type !== 'SMUS') {
    throw new Error('Not a FORM SMUS file');
  }

  let tempo = 128 * 120;
  let volume = 127;
  let ntracks = 0;
  let name = '';
  const instruments = new Map<number, string>();
  const tracks: SEvent[][] = [];

  const shdrChunk = findChunk(form, 'SHDR');
  if (shdrChunk && shdrChunk.data.length >= 4) {
    const dv = new DataView(
      shdrChunk.data.buffer,
      shdrChunk.data.byteOffset,
      shdrChunk.data.length,
    );
    tempo = dv.getUint16(0, false);
    volume = dv.getUint8(2);
    ntracks = dv.getUint8(3);
  }

  const nameChunk = findChunk(form, 'NAME');
  if (nameChunk) {
    name = readCString(nameChunk.data) || '';
  }

  const ins1Chunks = findChunks(form, 'INS1');
  for (const chunk of ins1Chunks) {
    if (chunk.data.length >= 4) {
      const dv = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length);
      const register = dv.getUint8(0);
      const instrName = readCString(chunk.data.subarray(4));
      instruments.set(register, instrName);
    }
  }

  const trakChunks = findChunks(form, 'TRAK');
  for (const chunk of trakChunks) {
    const evs: SEvent[] = [];
    for (let i = 0; i < chunk.data.length - 1; i += 2) {
      evs.push({ sid: chunk.data[i], data: chunk.data[i + 1] });
    }
    tracks.push(evs);
  }

  if (tracks.length === 0 && ntracks > 0) {
    throw new Error(`SHDR says ${ntracks} tracks but none found`);
  }

  return { tempo, volume, name: name || `song_${tracks.length}trk`, instruments, tracks };
}

// ─── SmusEngine ──────────────────────────────────────────────────────────

export class SmusEngine {
  sr: number;
  master: number;
  bpm: number;
  beatSamples: number;
  tracks: TrackState[];
  voices: VoiceState[];
  scoreVolume: number;
  instruments: Map<number, Instrument>;

  constructor(
    score: SmusScore,
    instruments: Map<number, Instrument>,
    sampleRate = 44100,
    masterVolume = 0.35,
  ) {
    this.instruments = instruments;
    this.sr = sampleRate;
    this.master = masterVolume;
    this.bpm = Math.max(score.tempo / 128.0, 1.0);
    this.beatSamples = (60.0 / this.bpm) * sampleRate;
    this.tracks = score.tracks.map((t) => ({
      events: t,
      index: 0,
      wait: 0,
      instrumentReg: 0,
      volume: 1.0,
      chordNotes: [],
      done: false,
    }));
    this.voices = [this._makeVoice(0), this._makeVoice(1), this._makeVoice(2), this._makeVoice(3)];
    this.scoreVolume = score.volume / 127.0;
    for (const tr of this.tracks) this._primeTrack(tr);
  }

  private _makeVoice(channel: number): VoiceState {
    return {
      active: false,
      channel,
      instrument: null,
      pos: 0,
      step: 0,
      vol: 0,
      samplesLeft: 0,
      released: false,
      envLevel: 0,
      envPhase: 'attack',
      noteSamples: 0,
      noteTotal: 0,
      envFixed: 0,
      envStage: 0,
      lfoPhase: 0,
      lfoFrozen: false,
      lfoMod: 0,
      vibPhase: 0,
      vibDelayLeft: 0,
      sampleWave: null,
      sampleLoopStart: 0,
      sampleLoopEnd: 0,
      noteFreq: 440,
      holdPhase: 0,
      holdAmp: 0,
      canHold: false,
      inHold: false,
    };
  }

  private _instForReg(reg: number): Instrument {
    return this.instruments.get(reg) || defaultInstrument(`reg${reg}`);
  }

  private _primeTrack(tr: TrackState): void {
    while (tr.index < tr.events.length) {
      const ev = tr.events[tr.index];
      if (ev.sid < 0x80) break;
      if (ev.sid === SID_REST) break;
      this._handleControl(tr, ev);
      tr.index++;
    }
  }

  private _handleControl(tr: TrackState, ev: SEvent): void {
    if (ev.sid === SID_INSTRUMENT) {
      tr.instrumentReg = ev.data;
    } else if (ev.sid === SID_DYNAMIC) {
      tr.volume = Math.max(ev.data, 1) / 127.0;
    } else if (ev.sid === SID_TEMPO && ev.data > 0) {
      this.bpm = ev.data;
      this.beatSamples = (60.0 / this.bpm) * this.sr;
    }
  }

  private _startVoice(ch: number, midi: number, flags: number, tr: TrackState): void {
    const inst = this._instForReg(tr.instrumentReg);
    const durBeats = noteDurationBeats(flags);
    let nSamples = Math.max(1, Math.floor(durBeats * this.beatSamples));
    const freq = 440.0 * Math.pow(2, (midi - 69) / 12);

    let sampleWave: Float32Array | null = null;
    let sampleLoopStart = 0;
    let sampleLoopEnd = 0;

    let step: number;
    if (inst.kind === 'synth') {
      step = (freq * 128.0) / this.sr;
    } else if (inst.kind === 'sample' && inst.ssData) {
      const octv = sampleOctaveForMidi(midi, inst.ssLo, inst.ssHi);
      const oneshot = inst.ssOneshot;
      const repeat = inst.ssRepeat;
      const lo = inst.ssLo;
      const offset = oneshot * ((1 << octv) - (1 << lo));
      const length = oneshot << octv;
      sampleWave = inst.ssData.subarray(offset, offset + length);
      if (sampleWave.length === 0) sampleWave = inst.wave;
      const wlen = sampleWave.length;

      if (repeat > 0 && repeat < oneshot && wlen > 0) {
        sampleLoopStart = Math.min(wlen - 1, repeat << octv);
        sampleLoopEnd = Math.min(wlen, oneshot << octv);
        if (sampleLoopEnd - sampleLoopStart < 2) {
          sampleLoopStart = sampleLoopEnd = 0;
        } else {
          const ls = sampleLoopStart;
          const le = sampleLoopEnd;
          const loop = Float32Array.from(sampleWave.subarray(ls, le));
          const fade = Math.min(Math.max(le - ls, 2) >> 2, 32);
          if (fade >= 2) {
            for (let i = 0; i < fade; i++) {
              const t = (i + 1) / fade;
              const a = loop[i];
              const b = loop[le - ls - fade + i];
              loop[i] = a * t + b * (1.0 - t);
            }
            const newWave = Float32Array.from(sampleWave);
            for (let i = 0; i < le - ls; i++) newWave[ls + i] = loop[i];
            sampleWave = newWave;
          }
        }
      }

      const noteInOct = midi % 12;
      const rate = inst.baseRate * (NOTE_PERIOD[0] / NOTE_PERIOD[noteInOct]);
      step = rate / this.sr;

      if (sampleLoopEnd === 0 && wlen > 0) {
        nSamples = Math.min(
          nSamples,
          Math.floor(wlen / Math.max(step, 1e-6)) + Math.floor(this.sr / 20),
        );
      }
    } else {
      const baseFreq = 440.0 * Math.pow(2, (inst.baseMidi - 69) / 12);
      step = (inst.baseRate / this.sr) * (freq / Math.max(baseFreq, 1e-6));
      sampleWave = inst.wave;
      sampleLoopStart = inst.loopStart;
      sampleLoopEnd = inst.loopEnd;
    }

    const vol = tr.volume * inst.volume * this.scoreVolume;
    let vibDelay = 0;
    if (inst.vibDelay > 0) {
      vibDelay = Math.floor((sonixRateUnits(inst.vibDelay) / 8000.0) * this.sr);
    }

    const v = this.voices[ch];
    v.active = true;
    v.channel = ch;
    v.instrument = inst;
    v.pos = 0.0;
    v.step = step;
    v.vol = vol;
    v.samplesLeft = nSamples;
    v.released = false;
    v.envLevel = 0.0;
    v.envPhase = 'attack';
    v.noteSamples = 0;
    v.noteTotal = nSamples;
    v.envFixed = 0.0;
    v.envStage = 0;
    v.lfoPhase = 0.0;
    v.lfoFrozen = false;
    v.lfoMod = 0.0;
    v.vibPhase = 0.0;
    v.vibDelayLeft = vibDelay;
    v.sampleWave = sampleWave;
    v.sampleLoopStart = sampleLoopStart;
    v.sampleLoopEnd = sampleLoopEnd;
    v.noteFreq = freq;
    v.holdPhase = 0.0;
    v.holdAmp = 0.0;
    v.canHold = false;
    v.inHold = false;
  }

  private _consumeEvent(tr: TrackState, ch: number): void {
    if (tr.index >= tr.events.length) {
      tr.done = true;
      return;
    }
    const ev = tr.events[tr.index];
    tr.index++;

    if (ev.sid < 0x80) {
      const chord = !!(ev.data & 0x80);
      const flags = ev.data & 0x3f;
      const midi = ev.sid;
      if (chord) {
        tr.chordNotes.push([midi, flags]);
        this._consumeEvent(tr, ch);
        return;
      }
      const notes = tr.chordNotes.concat([[midi, flags]]);
      tr.chordNotes = [];
      this._startVoice(ch, notes[0][0], notes[0][1], tr);
      for (let n = 1; n < notes.length; n++) {
        const free = this.voices.findIndex((v) => !v.active);
        if (free >= 0) this._startVoice(free, notes[n][0], notes[n][1], tr);
      }
      tr.wait = noteDurationBeats(flags);
      return;
    }

    if (ev.sid === SID_REST) {
      tr.wait = noteDurationBeats(ev.data & 0x3f);
      return;
    }

    this._handleControl(tr, ev);
    this._consumeEvent(tr, ch);
  }

  private _advanceTracks(beats: number): void {
    for (let ch = 0; ch < Math.min(4, this.tracks.length); ch++) {
      const tr = this.tracks[ch];
      if (tr.done) continue;
      tr.wait -= beats;
      while (tr.wait <= 1e-9 && !tr.done) {
        this._consumeEvent(tr, ch);
        if (tr.wait <= 1e-9 && !tr.done && tr.index >= tr.events.length) {
          tr.done = true;
        }
      }
    }
  }

  private _sonixEnvStep(
    v: VoiceState,
    n: number,
  ): { env: Float32Array; bank: Float32Array | null } {
    const inst = v.instrument!;
    const wantBank = inst.kind === 'synth' && inst.filterBanks !== null;

    const levels = [inst.envLevels[0], inst.envLevels[1], inst.envLevels[2], inst.envLevels[3]];
    const stepPerSample = (rateWord: number): number => {
      const units = sonixRateUnits(rateWord);
      const secs = Math.max(0.008, units / 2500.0);
      return 255.0 / (secs * this.sr);
    };
    const rates = [
      stepPerSample(inst.envRates[0]),
      stepPerSample(inst.envRates[1]),
      stepPerSample(inst.envRates[2]),
      stepPerSample(inst.envRates[3]),
    ];

    const envOut = new Float32Array(n);
    const bankOut = wantBank ? new Float32Array(n) : null;

    let env = v.envFixed;
    let stage = v.envStage;
    let lfo = v.lfoPhase;

    const lfoSpeed = inst.lfoRate || inst.lfoInc;
    const useLfo =
      (inst.lfoEnable || inst.fMod || inst.volMod || inst.pitchMod) &&
      lfoSpeed > 0 &&
      inst.modTable !== null;
    let lfoStep = 0;
    if (useLfo) {
      const lfoHz = inst.lfoOneshot
        ? 0.35 + (lfoSpeed / 255.0) * 5.0
        : 0.15 + (lfoSpeed / 255.0) * 1.2;
      lfoStep = (lfoHz * 256.0) / this.sr;
    }

    const modTable = inst.modTable;
    let frozen = v.lfoFrozen;
    let modHeld = v.lfoMod;
    let gateLeft = v.samplesLeft;

    for (let i = 0; i < n; i++) {
      if (gateLeft <= 0 && stage < 3) {
        stage = 3;
        v.released = true;
      }

      let target = levels[Math.min(stage, 3)];
      if (stage >= 3) target = 0;
      let spd = rates[Math.min(stage, 3)];
      if (stage >= 3 && spd < 1e-6) spd = 255.0 / (0.05 * this.sr);

      const dist = Math.abs(env - target);
      if (dist <= spd) {
        env = target;
        if (stage < 2) stage++;
      } else if (env < target) {
        env = env + spd;
      } else {
        env = env - spd;
      }

      let mod = modHeld;
      if (modTable && lfoStep > 0 && !frozen) {
        mod = modTable[Math.floor(lfo) & 255] * 128.0;
        lfo += lfoStep;
        if (inst.lfoOneshot && lfo >= 254.0) {
          lfo = 254.0;
          frozen = true;
          mod = modTable[254] * 128.0;
        } else if (!inst.lfoOneshot && lfo >= 256.0) {
          lfo -= 256.0;
        }
        modHeld = mod;
      }

      const envI = Math.max(0, Math.min(255, Math.round(env)));
      envOut[i] = envI / 255.0;

      if (bankOut) {
        let filt = (255 - inst.fBase - ((envI * inst.fEnv) >> 8) + (mod * inst.fMod) / 256.0) | 0;
        filt = Math.max(0, Math.min(255, filt));
        bankOut[i] = filt >> 2;
      }

      if (gateLeft > 0) gateLeft--;
    }

    v.envFixed = env;
    v.envStage = stage;
    v.lfoPhase = lfo;
    v.lfoFrozen = frozen;
    v.lfoMod = modHeld;
    v.envLevel = n ? envOut[n - 1] : v.envLevel;
    return { env: envOut, bank: bankOut };
  }

  private _renderVoice(v: VoiceState, n: number): Float32Array {
    const inst = v.instrument!;
    const out = new Float32Array(n);

    if (inst.kind === 'synth' && inst.filterBanks) {
      const { env, bank } = this._sonixEnvStep(v, n);
      const amp = inst.volEnv ? env : new Float32Array(n).fill(1.0);

      for (let i = 0; i < n; i++) {
        const pos = v.pos + v.step * i;
        const idx = (Math.floor(pos) & 0x7fffffff) % 128;
        const b0 = Math.min(63, Math.max(0, Math.floor(bank![i])));
        const b1 = Math.min(63, b0 + 1);
        const frac = bank![i] - b0;
        const s = inst.filterBanks![b0][idx] * (1 - frac) + inst.filterBanks![b1][idx] * frac;
        out[i] = s * amp[i] * v.vol * 1.4;
      }

      v.pos = v.pos + v.step * n;
      v.noteSamples += n;
      if (v.samplesLeft > 0) v.samplesLeft = Math.max(0, v.samplesLeft - n);
      if (v.envFixed <= 1.0 && (v.envStage >= 3 || inst.envLevels[Math.min(v.envStage, 3)] === 0)) {
        v.active = false;
      }
      return out;
    }

    const wave = v.sampleWave || inst.wave;
    const ls = v.sampleLoopStart;
    const le = v.sampleLoopEnd;
    const wlen = wave.length;
    if (wlen === 0) {
      v.active = false;
      return out;
    }

    const { env: envArr } = this._sonixEnvStep(v, n);

    let take = n;
    const positions = new Float64Array(take);
    {
      const baseStep = v.step;
      let pos = v.pos;
      if (inst.vibDepth > 0 && inst.vibRate > 0) {
        const vibHz = 0.8 + (inst.vibRate / 255.0) * 6.0;
        const depth = (inst.vibDepth / 128.0) * 0.015;
        let delay = v.vibDelayLeft;
        let phase = v.vibPhase;
        for (let i = 0; i < take; i++) {
          const stepVal = delay > 0 ? baseStep : baseStep * (1.0 + depth * Math.sin(phase));
          if (delay > 0) delay--;
          else phase += (2.0 * Math.PI * vibHz) / this.sr;
          positions[i] = pos;
          pos += stepVal;
        }
        v.vibDelayLeft = delay;
        v.vibPhase = phase;
      } else {
        for (let i = 0; i < take; i++) {
          positions[i] = pos;
          pos += baseStep;
        }
      }
    }

    if (le > ls) {
      const ll = le - ls;
      for (let i = 0; i < take; i++) {
        const p = positions[i];
        let idx: number;
        if (p < le) {
          idx = Math.min(p, wlen - 1.001);
        } else {
          idx = ls + ((p - ls) % ll);
        }
        const i0 = Math.floor(idx);
        const frac = idx - i0;
        let i1 = i0 + 1;

        if (p >= le) {
          if (i1 >= le) i1 = ls;
          const c0 = Math.min(Math.max(i0, ls), le - 1);
          const c1 = Math.min(i1, le - 1);
          out[i] =
            (wave[Math.max(0, Math.min(c0, wlen - 1))] * (1 - frac) +
              wave[Math.max(0, Math.min(c1, wlen - 1))] * frac) *
            envArr[i] *
            v.vol;
        } else {
          const c0 = Math.max(0, Math.min(i0, wlen - 1));
          const c1 = Math.min(i1, wlen - 1);
          out[i] = (wave[c0] * (1 - frac) + wave[c1] * frac) * envArr[i] * v.vol;
        }
      }
      if (positions[take - 1] >= le) {
        v.pos = ls + ((positions[take - 1] - ls) % ll);
        v.inHold = true;
      } else {
        v.pos = positions[take - 1] + v.step;
      }
    } else {
      let valid = 0;
      for (let i = 0; i < take; i++) {
        if (positions[i] < wlen) {
          const idx = Math.floor(positions[i]);
          out[i] = wave[Math.min(idx, wlen - 1)] * envArr[i] * v.vol;
          valid++;
        } else {
          break;
        }
      }
      if (valid > 0) {
        v.pos = positions[valid - 1] + v.step;
        take = valid;
      } else {
        v.active = false;
        return out;
      }
    }

    v.noteSamples += take;
    if (v.samplesLeft > 0) v.samplesLeft = Math.max(0, v.samplesLeft - take);
    if (le <= ls && v.pos >= wlen) {
      v.active = false;
    } else if (
      v.envFixed <= 1.0 &&
      (v.envStage >= 3 || (v.envStage >= 2 && inst.envLevels[2] === 0))
    ) {
      v.active = false;
    }
    return out;
  }

  /** Render a block of `n` samples, returning stereo interleaved. */
  renderBlock(n: number): [Float32Array, Float32Array] {
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    const grain = 128;
    let pos = 0;
    while (pos < n) {
      const g = Math.min(grain, n - pos);
      this._advanceTracks(g / this.beatSamples);
      for (const v of this.voices) {
        if (v.active && v.instrument) {
          const mono = this._renderVoice(v, g);
          const side = CHANNEL_PAN[v.channel & 3];
          if (side === 0) {
            for (let i = 0; i < g; i++) outL[pos + i] += mono[i];
          } else {
            for (let i = 0; i < g; i++) outR[pos + i] += mono[i];
          }
        }
      }
      pos += g;
    }
    const master = this.master;
    for (let i = 0; i < n; i++) {
      outL[i] = Math.max(-1, Math.min(1, outL[i] * master));
      outR[i] = Math.max(-1, Math.min(1, outR[i] * master));
    }
    return [outL, outR];
  }

  get finished(): boolean {
    const tracksDone = this.tracks.every((t) => t.done || t.index >= t.events.length);
    const voicesIdle = this.voices.every((v) => !v.active);
    return tracksDone && voicesIdle;
  }

  /** Render entire song to stereo Float32Arrays. */
  renderAll(maxSeconds = 300): [Float32Array, Float32Array] {
    const chunks: Array<[Float32Array, Float32Array]> = [];
    const block = 2048;
    const maxSamples = Math.floor(maxSeconds * this.sr);
    let total = 0;
    this._advanceTracks(0);
    while (total < maxSamples) {
      const [l, r] = this.renderBlock(block);
      chunks.push([l, r]);
      total += block;
      if (this.finished && this.voices.every((v) => !v.active)) break;
    }

    const totalLen = chunks.reduce((s, [l]) => s + l.length, 0);
    const left = new Float32Array(totalLen);
    const right = new Float32Array(totalLen);
    let off = 0;
    for (const [l, r] of chunks) {
      left.set(l, off);
      right.set(r, off);
      off += l.length;
    }

    const thresh = 1e-4;
    let lastNz = -1;
    for (let i = totalLen - 1; i >= 0; i--) {
      if (Math.abs(left[i]) > thresh || Math.abs(right[i]) > thresh) {
        lastNz = i;
        break;
      }
    }
    if (lastNz >= 0) {
      const trimLen = Math.min(totalLen, lastNz + Math.floor(this.sr / 4));
      return [left.subarray(0, trimLen), right.subarray(0, trimLen)];
    }
    return [left, right];
  }
}

// ─── Instrument conversion (parsed format → engine Instrument) ──────────

/** Convert a 502-byte synth InstrEmbedded to an engine Instrument. */
export function instrumentFromSynth(instr: InstrEmbedded, name: string): Instrument {
  const sd = instr.synthData;
  const sp = instr.synthParams;
  const waveshaper = new Uint8Array(128);
  for (let i = 0; i < 128; i++) waveshaper[i] = sd.waveshaper[i] & 0xff;

  const banksI8 = sonixOneFilter(waveshaper);
  const banks: Float32Array[] = [];
  for (let i = 0; i < 64; i++) {
    const bank = new Float32Array(128);
    for (let j = 0; j < 128; j++) bank[j] = banksI8[i * 128 + j] / 128.0;
    banks.push(bank);
  }

  const modTableArr = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    // sd.shapingCurve is already a signed Int8Array (values -128..127); reading
    // it back as a raw unsigned byte via `& 0xff` before re-applying the
    // unsigned->signed transform avoids double-converting already-signed
    // values (which corrupted the LFO modulation table for negative bytes).
    const v = i < 128 ? sd.shapingCurve[i] & 0xff : sd.transferTable[i - 128];
    modTableArr[i] = (v & 0x80 ? v - 256 : v) / 128.0;
  }

  const vol = 0.35 + 0.65 * (Math.max(sp.volRaw, 1) / 255.0);

  const rateToSec = (r: number) => Math.max(0.005, Math.min(1.5, sonixRateUnits(r) / 10000.0));
  const attack = rateToSec(sp.envelopeRates[0]);
  const decay = rateToSec(sp.envelopeRates[1]);
  const release = rateToSec(sp.envelopeRates[3]);
  const sustain = sp.envelopeLevels[2] ? sp.envelopeLevels[2] / 255.0 : 0.15;

  const bank0 = Math.max(0, Math.min(63, (255 - sp.fBase - ((255 * sp.fEnv) >> 8)) >> 2));
  const mid = Float32Array.from(banks[bank0]);
  const bFull = (255 - sp.fBase - ((255 * sp.fEnv) >> 8)) >> 2;
  const bZero = (255 - sp.fBase) >> 2;
  const filterStart = Math.max(0, Math.min(63, bFull)) / 63.0;
  const filterEnd = Math.max(0, Math.min(63, bZero)) / 63.0;

  return {
    name,
    kind: 'synth',
    wave: mid,
    loopStart: 0,
    loopEnd: 128,
    baseMidi: 60,
    baseRate: 16574.27,
    volume: vol,
    filterBanks: banks,
    modTable: modTableArr,
    envLevels: sp.envelopeLevels,
    envRates: sp.envelopeRates,
    fBase: sp.fBase,
    fEnv: sp.fEnv,
    fMod: sp.fMod,
    lfoRate: sp.lfoRate,
    lfoInc: sp.lfoInc,
    lfoEnable: sp.lfoEnable,
    lfoOneshot: sp.lfoOneshot,
    volRaw: sp.volRaw,
    volEnv: sp.volEnv,
    volMod: sp.volMod,
    pitchMod: sp.pitchMod,
    ssOneshot: 0,
    ssRepeat: 0,
    ssLo: 0,
    ssHi: 0,
    ssData: null,
    vibDepth: 0,
    vibRate: 0,
    vibDelay: 0,
    attack,
    decay,
    sustain,
    release,
    filterStart,
    filterEnd,
  };
}

/** Convert an .ss + InstrExternal pair to an engine Instrument. */
export function instrumentFromSampled(instr: InstrExternal, ss: SsFile, name: string): Instrument {
  const lo = ss.loOctave;
  let hi = ss.hiOctave;
  if (hi < lo) hi = lo;

  const mid = sampleOctaveForMidi(60, lo, hi);
  const off = ss.oneShotLen * ((1 << mid) - (1 << lo));
  const ln = ss.oneShotLen << mid;

  const sampleF32 = new Float32Array(ss.sampleData.length);
  for (let i = 0; i < ss.sampleData.length; i++) {
    sampleF32[i] = (ss.sampleData[i] & 0x80 ? ss.sampleData[i] - 256 : ss.sampleData[i]) / 128.0;
  }

  let wave = sampleF32.subarray(off, off + ln);
  if (wave.length === 0) {
    const maxLen = Math.max(1, Math.min(sampleF32.length, ss.oneShotLen << lo));
    wave = sampleF32.subarray(0, maxLen);
  }

  const ep = instr.externalParams;
  // The .instr's own volume override is authoritative — the driver never
  // falls back to the .ss file's embedded volume field at playback time.
  const effectiveVolume = Math.max(ep.volume, 1);
  const volume = effectiveVolume / 255.0;
  const sustain = ep.envelopeLevels[2] ? ep.envelopeLevels[2] / 255.0 : 0.0;

  return {
    name,
    kind: 'sample',
    wave: Float32Array.from(wave),
    loopStart: 0,
    loopEnd: 0,
    baseMidi: 60,
    baseRate: 8363,
    volume,
    filterBanks: null,
    modTable: null,
    envLevels: ep.envelopeLevels,
    envRates: ep.envelopeRates,
    fBase: 128,
    fEnv: 0,
    fMod: 0,
    lfoRate: 0,
    lfoInc: 0,
    lfoEnable: false,
    lfoOneshot: true,
    volRaw: effectiveVolume,
    volEnv: true,
    volMod: 0,
    pitchMod: 0,
    ssOneshot: ss.oneShotLen,
    ssRepeat: ss.repeatLen,
    ssLo: lo,
    ssHi: hi,
    ssData: sampleF32,
    vibDepth: ep.vibDepth,
    vibRate: ep.vibRate,
    vibDelay: ep.vibDelay,
    attack: 0.01,
    decay: 0.1,
    sustain,
    release: 0.15,
    filterStart: 0,
    filterEnd: 0,
  };
}

/** Convert an 8SVX instrument to an engine Instrument. */
export function instrumentFrom8svx(instr: Instr8SVX, name: string): Instrument {
  const wave = new Float32Array(instr.sampleData.length);
  for (let i = 0; i < instr.sampleData.length; i++) {
    wave[i] =
      (instr.sampleData[i] & 0x80 ? instr.sampleData[i] - 256 : instr.sampleData[i]) / 128.0;
  }

  return {
    name,
    kind: '8svx',
    wave,
    loopStart: instr.oneShotHiSamples,
    loopEnd: instr.oneShotHiSamples + instr.repeatHiSamples,
    baseMidi: 60,
    baseRate: instr.samplesPerSec || 8363,
    volume: 1.0,
    filterBanks: null,
    modTable: null,
    envLevels: [255, 255, 200, 0],
    envRates: [128, 128, 128, 64],
    fBase: 128,
    fEnv: 0,
    fMod: 0,
    lfoRate: 0,
    lfoInc: 0,
    lfoEnable: false,
    lfoOneshot: true,
    volRaw: 255,
    volEnv: true,
    volMod: 0,
    pitchMod: 0,
    ssOneshot: 0,
    ssRepeat: 0,
    ssLo: 0,
    ssHi: 0,
    ssData: null,
    vibDepth: 0,
    vibRate: 0,
    vibDelay: 0,
    attack: 0.01,
    decay: 0.1,
    sustain: 0.7,
    release: 0.15,
    filterStart: 0,
    filterEnd: 0,
  };
}
