/**
 * SampledSound .instr / .ss parser.
 *
 * Parses three .instr variants used by Melbourne House / Sonix:
 *   - External (SampledSound): 128-byte header pointing to a .ss sample file
 *   - Embedded (synth): 502-byte self-contained synthesis instrument
 *   - 8SVX: IFF FORM 8SVX sampled instrument
 *
 * Also parses .ss (Sampled Sound) multi-octave sample files.
 */

import { BinaryReader } from '@seer-project/core';
import { parseIff, findChunk } from '@seer-project/iff';

// ─── Parsed types ──────────────────────────────────────────────────────

export interface InstrCommon {
  typeId: number;
  sampleParam: number;
  name: string;
}

/** Game-side envelope/vibrato parameters from an external (SampledSound) .instr. */
export interface ExternalParams {
  volume: number;
  envelopeLevels: [number, number, number, number];
  envelopeRates: [number, number, number, number];
  vibDepth: number;
  vibRate: number;
  vibDelay: number;
}

export interface InstrExternal extends InstrCommon {
  variant: 'external';
  ssStem: string;
  playType: number;
  envelopeId: number;
  overrides: number[];
  externalParams: ExternalParams;
}

export interface SynthData {
  /** Section 1: 128 signed bytes — source waveshaper transfer function */
  waveshaper: Int8Array;
  /** Section 2: 128 signed bytes — shaping/envelope curve */
  shapingCurve: Int8Array;
  /** Section 3: 128 unsigned bytes — transfer function lookup table */
  transferTable: Uint8Array;
  /** Section 4: 25 × u16 BE synthesis parameters */
  params: number[];
}

/** Named synthesis parameters extracted from the 25-element params array. */
export interface SynthParams {
  volRaw: number;
  volEnv: boolean;
  volMod: number;
  pitchMod: number;
  fBase: number;
  fEnv: number;
  fMod: number;
  lfoInc: number;
  lfoWord: number;
  lfoEnable: boolean;
  lfoOneshot: boolean;
  lfoRate: number;
  envelopeLevels: [number, number, number, number];
  envelopeRates: [number, number, number, number];
}

export interface InstrEmbedded extends InstrCommon {
  variant: 'embedded';
  synthData: SynthData;
  synthParams: SynthParams;
}

export interface Instr8SVX extends InstrCommon {
  variant: '8svx';
  oneShotHiSamples: number;
  repeatHiSamples: number;
  samplesPerHiCycle: number;
  samplesPerSec: number;
  ctOctave: number;
  annotation: string;
  sampleData: Uint8Array;
}

export type Instr = InstrExternal | InstrEmbedded | Instr8SVX;

// ─── Synthesis modulation data ────────────────────────────────────────

/**
 * Modulation parameters extracted from a 502-byte synthesis .instr file.
 *
 * These control real-time vibrato, pitch modulation, amplitude modulation,
 * and envelope processing during playback — the driver's LAB_0F4B voice
 * tick handler (lines 35774–35941 of WarInMiddleEarth.asm).
 *
 * The 434-byte synthesis block is divided into:
 *   Section 1 (waveshaper):  128 bytes — also serves as vibrato depth LFO shape
 *   Section 2 (shaping curve): 128 bytes — combined with waveshaper for 256-byte vibrato LFO
 *   Section 3 (transfer table): 128 bytes — modulation control parameters (u16 BE at byte offsets)
 *   Section 4 (params): 50 bytes (25 × u16 BE) — multi-segment envelope targets & rates
 */
export interface SynthModulation {
  /** 256-byte vibrato LFO lookup: waveshaper (bytes 0–127) + shaping curve (bytes 128–255) */
  vibratoLfo: Uint8Array;
  /** Transfer table u16 values indexed by byte offset ÷ 2 (big-endian) */
  transferTable: Uint16Array;
  /** Section 4 envelope parameters (25 × u16 big-endian) */
  section4Params: Uint16Array;
}

/**
 * Extract modulation parameters from parsed synthesis data.
 * Only meaningful for `variant === 'embedded'` (502-byte) .instr files.
 */
export function parseSynthModulation(synthData: SynthData): SynthModulation {
  // Vibrato LFO: waveshaper (128 bytes) + shaping curve (128 bytes) = 256 bytes
  const vibratoLfo = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    vibratoLfo[i] = synthData.waveshaper[i] & 0xff;
    vibratoLfo[i + 128] = synthData.shapingCurve[i] & 0xff;
  }

  // Transfer table: 128 bytes → 64 × u16 big-endian
  const transferTable = new Uint16Array(64);
  for (let i = 0; i < 64; i++) {
    transferTable[i] = (synthData.transferTable[i * 2] << 8) | synthData.transferTable[i * 2 + 1];
  }

  // Section 4 params already parsed as u16 BE
  const section4Params = new Uint16Array(synthData.params);

  return { vibratoLfo, transferTable, section4Params };
}

export interface SsFile {
  /** Oneshot length in samples — the length of one copy at the lowest octave. */
  oneShotLen: number;
  /** Repeat length in samples (0 = no repeat, same as oneShotLen for looping). */
  repeatLen: number;
  /** Lowest octave available in the multi-octave payload (0–9). */
  loOctave: number;
  /** Highest octave available in the multi-octave payload (0–9, ≥ loOctave). */
  hiOctave: number;
  volume: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  tailLen: number;
  percmode: boolean;
  /** Raw multi-octave sample data — concatenated copies, one per octave from loOctave to hiOctave. */
  sampleData: Uint8Array;
}

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const SAMPLED_SOUND_MAGIC = 'SampledSound';
const SS_HEADER_SIZE = 0x3e;
const EMBEDDED_SAMPLE_SIZE = 434;
const INSTR_HEADER_COMMON_OFFSET = 0x20;
const SYNTH_OUTPUT_SIZE = 8192;
const SYNTH_OUTER_ITERS = 64;
const SYNTH_INNER_ITERS = 128;

/** SSonix feedback-integrator filter coefficients (LAB_0F7B, 64 × u16). */
const SYNTH_COEFFICIENTS = new Uint16Array([
  0x8000, 0x7683, 0x6dba, 0x6597, 0x5e10, 0x5717, 0x50a2, 0x4aa8, 0x451f, 0x4000, 0x3b41, 0x36dd,
  0x32cb, 0x2f08, 0x2b8b, 0x2851, 0x2554, 0x228f, 0x2000, 0x1da0, 0x1b6e, 0x1965, 0x1784, 0x15c5,
  0x1428, 0x12aa, 0x1147, 0x1000, 0x0ed0, 0x0db7, 0x0cb2, 0x0bc2, 0x0ae2, 0x0a14, 0x0955, 0x08a3,
  0x0800, 0x0768, 0x06db, 0x0659, 0x05e1, 0x0571, 0x050a, 0x04aa, 0x0451, 0x0400, 0x03b4, 0x036d,
  0x032c, 0x02f0, 0x02b8, 0x0285, 0x0255, 0x0228, 0x0200, 0x01da, 0x01b6, 0x0196, 0x0178, 0x015c,
  0x0142, 0x012a, 0x0114, 0x0100,
]);

// ═══════════════════════════════════════════════════════════════════════
// LAB_0F70 synthesis — feedback integrator waveform generator
// ═══════════════════════════════════════════════════════════════════════

function u16(val: number): number {
  return val & 0xffff;
}

function s16(val: number): number {
  return val > 0x7fff ? val - 0x10000 : val;
}

/**
 * Sonix filter bank generator — faithful port of the Sonix OneFilter
 * (smus-player.ts sonixOneFilter). Produces 64 banks × 128 samples of
 * signed 8-bit PCM from 128 unsigned (or offset-binary) waveform bytes.
 *
 * @param wave128 - 128 bytes of waveform data (unsigned, like smus-player expects)
 * @returns 8192 bytes (64×128) of signed 8-bit PCM filter banks
 */
export function synthesizeWaveform(wave128: Uint8Array | Int8Array): Int8Array {
  const wave = new Int16Array(128);
  for (let i = 0; i < 128; i++) {
    const v = wave128[i] & 0xff;
    wave[i] = v < 128 ? v : v - 256;
  }
  const out = new Int8Array(SYNTH_OUTPUT_SIZE);
  let d3 = 0;
  let d4 = s16(wave[127] << 7);
  let oi = 0;
  for (let step = 0; step < SYNTH_OUTER_ITERS; step++) {
    const coeff = SYNTH_COEFFICIENTS[step];
    let d2 = (0x8000 - coeff) & 0xffff;
    d2 = ((d2 * 0xe666) >>> 0) >>> 16;
    const d1s = coeff >>> 1;
    for (let s = 0; s < SYNTH_INNER_ITERS; s++) {
      const d6 = s16((s16(wave[s] << 7) - d4) & 0xffff);
      let prod = (d6 * d1s) | 0;
      prod = (prod << 2) | 0;
      d3 = u16(d3 + (prod >> 16));
      d4 = u16(d4 + s16(d3));
      const d4u = d4 & 0xffff;
      const ror = ((d4u >>> 7) | ((d4u & 0x7f) << 9)) & 0xffff;
      out[oi++] = ror & 0xff;
      const prod3 = (s16(d3) * s16(d2)) | 0;
      d3 = u16((prod3 << 1) >> 16);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// .instr parsing
// ═══════════════════════════════════════════════════════════════════════

function readCommonHeader(data: Uint8Array): InstrCommon {
  const r = new BinaryReader(
    data.buffer as ArrayBuffer,
    data.byteOffset + INSTR_HEADER_COMMON_OFFSET,
  );
  const typeId = r.readUint16();
  const sampleParam = r.readUint16();

  const nameBytes: number[] = [];
  for (let i = 0; i < 28; i++) {
    const b = r.readUint8();
    if (b === 0) break;
    nameBytes.push(b);
  }
  const name = String.fromCharCode(...nameBytes);

  return { typeId, sampleParam, name };
}

function isSampledSound(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  return new TextDecoder().decode(data.subarray(0, 12)) === SAMPLED_SOUND_MAGIC;
}

function isIff8svx(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const fourCC = new TextDecoder().decode(data.subarray(0, 4));
  const formType = new TextDecoder().decode(data.subarray(8, 12));
  return fourCC === 'FORM' && formType === '8SVX';
}

function parseExternal(data: Uint8Array): InstrExternal {
  const common = readCommonHeader(data);
  // 4 zero bytes at 0x40-0x43, then null-terminated filename at 0x44
  const stemBytes = data.subarray(0x44, 0x60);
  const nullIdx = stemBytes.indexOf(0);
  const ssStem = new TextDecoder().decode(
    nullIdx >= 0 ? stemBytes.subarray(0, nullIdx) : stemBytes,
  );

  const r2 = new BinaryReader(data.buffer as ArrayBuffer, data.byteOffset + 0x60);
  r2.readUint16(); // reserved
  r2.readUint16(); // reserved
  const playType = r2.readUint16();
  const envelopeId = r2.readUint16();

  const overrides: number[] = [];
  while (r2.remaining >= 2) {
    overrides.push(r2.readUint16());
  }

  // Extract named fields from overrides (matching smus-player.ts offsets)
  const volume = overrides.length > 0 ? overrides[0] : 0;
  const envelopeLevels: [number, number, number, number] = [
    overrides.length > 1 ? overrides[1] & 0xff : 255,
    overrides.length > 2 ? overrides[2] & 0xff : 255,
    overrides.length > 3 ? overrides[3] & 0xff : 200,
    overrides.length > 4 ? overrides[4] & 0xff : 0,
  ];
  const envelopeRates: [number, number, number, number] = [
    overrides.length > 5 ? overrides[5] : 128,
    overrides.length > 6 ? overrides[6] : 128,
    overrides.length > 7 ? overrides[7] : 128,
    overrides.length > 8 ? overrides[8] : 64,
  ];
  const vibDepth = overrides.length > 9 ? overrides[9] & 0xff : 0;
  const vibRate = overrides.length > 10 ? overrides[10] & 0xff : 0;
  const vibDelay = overrides.length > 11 ? overrides[11] & 0xff : 0;

  return {
    ...common,
    variant: 'external',
    ssStem,
    playType,
    envelopeId,
    overrides,
    externalParams: { volume, envelopeLevels, envelopeRates, vibDepth, vibRate, vibDelay },
  };
}

function parseEmbedded(data: Uint8Array): InstrEmbedded {
  const common = readCommonHeader(data);
  const block = data.subarray(0x44, 0x44 + EMBEDDED_SAMPLE_SIZE);

  // Section 1: 128 signed bytes — waveshaper
  const waveshaper = new Int8Array(block.buffer, block.byteOffset, 128);

  // Section 2: 128 signed bytes — shaping curve
  const shapingCurve = new Int8Array(block.buffer, block.byteOffset + 128, 128);

  // Section 3: 128 unsigned bytes — transfer function
  const transferTable = new Uint8Array(block.buffer, block.byteOffset + 256, 128);

  // Section 4: 25 × u16 BE — synthesis parameters
  const r = new BinaryReader(block.buffer as ArrayBuffer, block.byteOffset + 384);
  const params: number[] = [];
  for (let i = 0; i < 25; i++) {
    params.push(r.readUint16());
  }

  // Extract named params (mapping derived from smus-player.ts's loadSynthInstr)
  const volRaw = params[4] & 0xff;
  const volEnv = params[5] !== 0;
  const volMod = params[6] & 0xff;
  const pitchMod = params[8] & 0xff;
  const fBase = params[9] & 0xff;
  const fEnv = params[10] & 0xff;
  const fMod = params[11] & 0xff;
  const lfoInc = params[12] & 0xff;
  const lfoWord = params[13];
  const lfoSigned = lfoWord >= 0x8000 ? lfoWord - 0x10000 : lfoWord;
  const lfoEnable = lfoWord !== 0;
  const lfoOneshot = lfoSigned >= 0;
  const lfoRate = params[14] & 0xff;
  const envelopeLevels: [number, number, number, number] = [
    params[17] & 0xff,
    params[18] & 0xff,
    params[19] & 0xff,
    params[20] & 0xff,
  ];
  const envelopeRates: [number, number, number, number] = [
    params[21],
    params[22],
    params[23],
    params[24],
  ];

  const synthParams: SynthParams = {
    volRaw,
    volEnv,
    volMod,
    pitchMod,
    fBase,
    fEnv,
    fMod,
    lfoInc,
    lfoWord,
    lfoEnable,
    lfoOneshot,
    lfoRate,
    envelopeLevels,
    envelopeRates,
  };

  return {
    ...common,
    variant: 'embedded',
    synthData: { waveshaper, shapingCurve, transferTable, params },
    synthParams,
  };
}

function parse8svx(data: Uint8Array): Instr8SVX {
  // Slice to a tight buffer starting at byte 0 — `data` may be a view over a
  // larger backing buffer (e.g. a pooled Node Buffer), and parseIff/BinaryReader
  // read from the start of the ArrayBuffer they're given, ignoring byteOffset.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const form = parseIff(buf);
  if (!form || form.type !== '8SVX') {
    throw new Error('Expected IFF FORM 8SVX');
  }

  const vhdr = findChunk(form, 'VHDR');
  if (!vhdr) {
    throw new Error('8SVX missing VHDR chunk');
  }

  const vr = new BinaryReader(vhdr.data.buffer as ArrayBuffer, vhdr.data.byteOffset);
  const oneShotHiSamples = vr.readUint32();
  const repeatHiSamples = vr.readUint32();
  const samplesPerHiCycle = vr.readUint32();
  const samplesPerSec = vr.readUint16();
  const ctOctave = vr.readUint8();
  // sCompression = vr.readUint8(); // unused

  const anno = findChunk(form, 'ANNO');
  let annotation = '';
  if (anno) {
    annotation = new TextDecoder().decode(anno.data).replace(/\0+$/, '');
  }

  const body = findChunk(form, 'BODY');
  if (!body) {
    throw new Error('8SVX missing BODY chunk');
  }

  const sampleData = body.data;

  return {
    variant: '8svx',
    typeId: 0,
    sampleParam: 0,
    name: annotation.trim() || '8SVX',
    oneShotHiSamples,
    repeatHiSamples,
    samplesPerHiCycle,
    samplesPerSec,
    ctOctave,
    annotation,
    sampleData,
  };
}

// ─── .ss parsing ───────────────────────────────────────────────────────

export function parseSs(data: Uint8Array): SsFile {
  const r = new BinaryReader(data.buffer as ArrayBuffer, data.byteOffset);

  const oneShotLen = r.readUint16();
  const repeatLen = r.readUint16();
  const loOctave = r.readUint8();
  const hiOctave = r.readUint8();
  const volume = r.readUint16();
  const attack = r.readUint16();
  const decay = r.readUint16();
  const sustain = r.readUint16();
  const release = r.readUint16();
  r.readUint16(); // param1
  r.readUint16(); // param2
  r.readUint16(); // param3
  const tailLen = r.readUint16();
  r.readUint16(); // param4
  r.readUint16(); // param5
  r.readUint16(); // param6
  const percmode = r.readUint16();

  // Skip 30 reserved bytes (0x20–0x3D)
  r.seek(SS_HEADER_SIZE);

  const sampleData = new Uint8Array(data.buffer, data.byteOffset + r.offset);

  return {
    oneShotLen,
    repeatLen,
    loOctave,
    hiOctave,
    volume,
    attack,
    decay,
    sustain,
    release,
    percmode: percmode !== 0,
    tailLen,
    sampleData,
  };
}

// ─── Public API ────────────────────────────────────────────────────────

export function parseInstr(data: Uint8Array): Instr {
  if (isIff8svx(data)) {
    return parse8svx(data);
  }

  if (isSampledSound(data)) {
    return parseExternal(data);
  }

  const expectedEmbedded = INSTR_HEADER_COMMON_OFFSET + EMBEDDED_SAMPLE_SIZE + 8;
  if (data.length >= expectedEmbedded) {
    return parseEmbedded(data);
  }

  throw new Error(
    `Unknown .instr format: ${data.length} bytes, no SampledSound magic, no 8SVX IFF header`,
  );
}

// ─── Sample conversion helpers ─────────────────────────────────────────

/** View signed 8-bit PCM data as Int8Array. Sample data is already two's complement signed. */
export function unsignedToSigned(samples: Uint8Array): Int8Array {
  return new Int8Array(samples.buffer, samples.byteOffset, samples.length);
}

/** DMA sample rate from an Amiga period value (PAL). */
export function periodToSampleRate(period: number): number {
  if (period <= 0) return 0;
  return Math.round(3546895 / period);
}

/** Determine playback rate for an instrument from its `.instr` header.
 *
 * All .ss and embedded instruments use a reference rate derived from the
 * Amiga C-3 DMA period. This rate is used by both the WAV renderer and
 * the XM build pipeline. The WAV renderer applies additional pitch
 * corrections as needed (see convert-smus-to-wav.ts).
 *
 * 8SVX instruments report their own rate in the VHDR chunk.
 */
export function instrSampleRate(instr: Instr): number {
  if (instr.variant === '8svx') {
    return instr.samplesPerSec;
  }
  return 16726;
}
