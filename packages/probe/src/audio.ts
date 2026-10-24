/**
 * `seer-probe audio <file>` — the listen sheet.
 *
 * Three stages:
 * 1. Container signature scan — free ground truth when it hits (IFF
 *    8SVX/16SV/SMUS via existing parsers, MOD via the tracker's own
 *    loader plus the size-closure structural check, MED/SONX by magic).
 * 2. Raw-PCM parameter sweep when no container matches — every
 *    {signed|unsigned} × {8|16-bit} × {BE|LE} × {mono|stereo} combination
 *    scored on two corpus-validated statistics: normalized roughness (the
 *    measured byte-order discriminator) and lag-1 autocorrelation (the
 *    measured is-this-audio gate). Run per file, never per format — real
 *    corpora ship 15 of 16 clips one way and one the other.
 * 3. Artifacts: a spectrogram grid PNG (wrong byte order reads as flat
 *    broadband noise) and normalized WAV snippets of the top candidates —
 *    play five two-second clips and the answer is immediate.
 *
 * Sample rate is deliberately NOT guessed from the signal — it is not
 * recoverable from raw PCM. It is reported `null` unless a container
 * header supplies it, and snippet WAVs are written at an explicitly
 * assumed rate that the JSON labels as assumed. Every existing sample
 * rate in the wider corpus is a hardcoded guess; this command makes the
 * uncertainty explicit instead of inheriting the habit.
 */

import { Module } from '@seer-project/tracker';
import { isIff8svx, parse8svx } from '@seer-project/smus';
import { isHunkFile, parseHunkFile } from '@seer-project/amiga';
import { readBinary, writeJson, writePNG, writeWav } from '@seer-project/pipeline';
import { clamp01, printableAsciiAt, r16, r32 } from '@seer-project/core';
import { parseFlags } from './args.js';
import { artifactPath, ensureOutDir } from './out.js';
import { resolveRanges, type ByteRange } from './range.js';
import { lag1Autocorrelation, normalizedRoughness } from './score.js';
import { createCanvas, drawText, fillRect, heatColor, setPixel, type Canvas } from './render.js';

export interface PcmEncoding {
  bits: 8 | 16;
  signed: boolean;
  /** Only meaningful for 16-bit. */
  endian: 'be' | 'le' | null;
  channels: 1 | 2;
}

export interface AudioCandidate {
  encoding: PcmEncoding;
  /** Mean |Δsample| as a fraction of full scale — the byte-order discriminator. */
  roughness: number;
  /** Lag-1 autocorrelation — the is-this-audio gate (real audio ≈ 0.5–0.98). */
  autocorrelation: number;
  /**
   * Fraction of exactly-equal consecutive samples. Near-constant data
   * (flat bitmap regions, fill) is smooth but not audio; audio moves.
   */
  zeroDeltaFraction: number;
  score: number;
  /** Hypothesis strength, never a finding: 'plausible' or 'unlikely'. */
  verdict: 'plausible' | 'unlikely';
}

export interface ContainerHit {
  kind: string;
  /** Absolute byte offset of the container within the probed file. */
  offset: number;
  /** Container length in bytes when its header supplies one, else null. */
  length: number | null;
  detail: string;
  /** Real sample rate when the container header carries one. */
  sampleRate: number | null;
}

export interface AudioRangeResult {
  range: { start: number; end: number; label: string };
  candidates: AudioCandidate[];
  /** Always null for raw PCM — not recoverable from signal. */
  sampleRate: null;
}

export interface AudioResult {
  file: string;
  size: number;
  containers: ContainerHit[];
  ranges: AudioRangeResult[];
  /** The rate snippet WAVs were written at when no header supplied one. */
  assumedSnippetRate: number | null;
}

// ── Stage 1: container signatures ──────────────────────────────────────

const MOD_MAGICS = new Set(['M.K.', 'M!K!', 'FLT4', 'FLT8', '8CHN', '6CHN', '4CHN', 'OCTA', 'CD81']);

/**
 * MOD size-closure structural check:
 * `1084 + patterns*rowBytes*64 + Σ sampleWords*2 === fileLength` — the
 * closest thing in the corpus to a real structural audio detector.
 */
export function modSizeClosure(data: Uint8Array): { patterns: number; expected: number; matches: boolean } | null {
  if (data.length < 1084) return null;
  const magic = printableAsciiAt(data, 1080, 4);
  if (!MOD_MAGICS.has(magic)) return null;
  const channels = magic === '8CHN' || magic === 'FLT8' || magic === 'OCTA' || magic === 'CD81' ? 8 : magic === '6CHN' ? 6 : 4;
  let patterns = 0;
  for (let i = 0; i < 128; i++) patterns = Math.max(patterns, (data[952 + i] & 0x7f) + 1);
  let sampleBytes = 0;
  for (let s = 0; s < 31; s++) sampleBytes += r16(data, 20 + s * 30 + 22, 'be') * 2;
  const expected = 1084 + patterns * 64 * channels * 4 + sampleBytes;
  return { patterns, expected, matches: expected === data.length };
}

/**
 * Scan for known audio container signatures — at ANY offset, not just 0.
 *
 * Real corpora bury containers: the first untouched corpus this tool met
 * (Moonstone) ships its entire sound library as IFF `FORM 8SVX` files
 * concatenated inside the CODE hunk of a HUNK executable, so an
 * offset-0-only scan reports nothing. Three layers:
 *
 * 1. Whole-file magics (MOD at 1080, MED/SONX at 0) — position-defined.
 * 2. If the file is a HUNK executable, each CODE/DATA hunk payload is
 *    scanned separately and hits say which hunk they were inside — a
 *    CODE hunk wrapping non-code data is a documented real pattern.
 * 3. A FORM sweep over every even offset (IFF chunks are word-aligned),
 *    validated against the FORM's own size field so a stray "FORM"
 *    string can't fake a hit; 8SVX/16SV forms get their VHDR parsed for
 *    the real sample rate.
 */
export function scanContainers(data: Uint8Array): ContainerHit[] {
  const hits: ContainerHit[] = [];
  if (data.length < 12) return hits;

  const closure = modSizeClosure(data);
  if (closure) {
    let detail = `magic ${printableAsciiAt(data, 1080, 4)}, ${closure.patterns} patterns, size closure ${closure.matches ? 'holds' : `FAILS (expected ${closure.expected}, file ${data.length})`}`;
    try {
      const mod = new Module(data);
      detail += `, loads as "${mod.songName.trim()}" (${mod.numChannels}ch)`;
    } catch {
      detail += ', tracker loader rejected it';
    }
    hits.push({ kind: 'mod', offset: 0, length: data.length, detail, sampleRate: null });
  }

  const four = printableAsciiAt(data, 0, 4);
  if (four === 'MMD0' || four === 'MMD1' || four === 'MED ') {
    hits.push({ kind: 'med', offset: 0, length: null, detail: `OctaMED magic ${four}`, sampleRate: null });
  }
  if (four === 'SONX') {
    hits.push({ kind: 'sonix', offset: 0, length: null, detail: 'Sonix SONX magic', sampleRate: null });
  }

  if (isHunkFile(data)) {
    try {
      const hunks = parseHunkFile(data);
      const payloadHunks = hunks.filter((h) => h.fileOffset !== null && h.size > 0);
      hits.push({
        kind: 'hunk-wrapped',
        offset: 0,
        length: data.length,
        detail: `AmigaOS HUNK file (${hunks.map((h) => h.type).join('+')}); scanning hunk payloads`,
        sampleRate: null,
      });
      for (const h of payloadHunks) {
        hits.push(
          ...scanForms(data, h.fileOffset!, h.fileOffset! + h.size).map((hit) => ({
            ...hit,
            detail: `inside ${h.type} hunk ${h.index} — ${hit.detail}`,
          })),
        );
      }
      return hits;
    } catch {
      // Unparseable hunk stream (e.g. HUNK_EXT) — fall through to a raw sweep.
    }
  }

  hits.push(...scanForms(data, 0, data.length));
  return hits;
}

/**
 * Sweep [start, end) for valid IFF FORMs, chaining past each one found.
 *
 * The magic test compares bytes rather than building a string per
 * candidate offset: this loop runs once per even byte of every file in a
 * corpus, and allocating a 4-character string each time dominated the
 * whole scan's cost.
 */
function scanForms(data: Uint8Array, start: number, end: number): ContainerHit[] {
  const hits: ContainerHit[] = [];
  let off = start & ~1;
  while (off + 12 <= end) {
    if (data[off] !== 0x46 || data[off + 1] !== 0x4f || data[off + 2] !== 0x52 || data[off + 3] !== 0x4d) {
      off += 2;
      continue;
    }
    const size = r32(data, off + 4, 'be');
    // Validate against the FORM's own size field: at least one 4CC of
    // content, and it must fit (+1 tolerates a missing final pad byte).
    if (size < 4 || off + 8 + size > end + 1) {
      off += 2;
      continue;
    }
    // Validate the type 4CC too — IFF form types are printable
    // alphanumerics/spaces with a non-space lead. Compressed data
    // contains "FORM" byte runs with plausible sizes often enough that
    // skipping this floods a corpus triage with junk kinds.
    const type = printableAsciiAt(data, off + 8, 4);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ]{3}$/.test(type)) {
      off += 2;
      continue;
    }
    const length = 8 + size + (size & 1);
    const form = data.subarray(off, Math.min(off + length, end));
    if (isIff8svx(form)) {
      try {
        const inst = parse8svx(form);
        hits.push({
          kind: 'iff-8svx',
          offset: off,
          length,
          detail: `VHDR samplesPerSec=${inst.samplesPerSec}, ${inst.sampleData.length} sample bytes`,
          sampleRate: inst.samplesPerSec,
        });
      } catch (e) {
        hits.push({
          kind: 'iff-8svx',
          offset: off,
          length,
          detail: `FORM 8SVX but VHDR parse failed: ${(e as Error).message}`,
          sampleRate: null,
        });
      }
    } else {
      hits.push({
        kind: `iff-${type.trim().toLowerCase()}`,
        offset: off,
        length,
        detail: `IFF FORM type ${type}`,
        sampleRate: null,
      });
    }
    off += length;
    off += off & 1;
  }
  return hits;
}

// ── Stage 2: raw-PCM sweep ─────────────────────────────────────────────

/** Samples scored per candidate — enough for both statistics to converge. */
const MAX_SCORE_SAMPLES = 1 << 16;

/** All encodings swept: 4 eight-bit + 8 sixteen-bit combinations. */
export function sweepEncodings(): PcmEncoding[] {
  const out: PcmEncoding[] = [];
  for (const signed of [true, false]) {
    for (const channels of [1, 2] as const) {
      out.push({ bits: 8, signed, endian: null, channels });
      for (const endian of ['be', 'le'] as const) {
        out.push({ bits: 16, signed, endian, channels });
      }
    }
  }
  return out;
}

/** Decode a byte range as the given PCM encoding, normalized to [-1, 1], one Float32Array per channel. */
export function decodePcm(
  data: Uint8Array,
  start: number,
  end: number,
  enc: PcmEncoding,
  maxSamples = MAX_SCORE_SAMPLES,
): Float32Array[] {
  const bytesPer = (enc.bits / 8) * enc.channels;
  const frames = Math.min(Math.floor((end - start) / bytesPer), maxSamples);
  const chans = Array.from({ length: enc.channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < enc.channels; ch++) {
      const off = start + f * bytesPer + ch * (enc.bits / 8);
      let v: number;
      if (enc.bits === 8) {
        v = enc.signed ? ((data[off] << 24) >> 24) / 128 : (data[off] - 128) / 128;
      } else {
        const raw = r16(data, off, enc.endian!);
        const val = enc.signed ? (raw << 16) >> 16 : raw - 0x8000;
        v = val / 32768;
      }
      chans[ch][f] = v;
    }
  }
  return chans;
}

/**
 * Corpus-derived thresholds, restated as fractions of full scale (the
 * lesson's absolute figures are 16-bit-specific): correct byte order
 * measured ≈ 0.01–0.07 roughness, byte-swapped ≈ 0.33.
 */
const ROUGHNESS_NOISE = 0.33;
/**
 * The corpus measurement puts correct-order real audio at ≤ 4,300 of
 * 16-bit full scale ≈ 0.066 in this normalization; 0.08 leaves headroom
 * without admitting bitmap-as-PCM decodes (measured ≈ 0.14).
 */
const PLAUSIBLE_ROUGHNESS = 0.08;
const PLAUSIBLE_AUTOCORR = 0.5;
/** Above this fraction of exactly-equal consecutive samples, "smooth" means "flat", not "audio" — a bitmap's solid fills decode to plateaus real recordings don't have. */
const MAX_ZERO_DELTA = 0.75;

/** Score one byte range across all PCM encodings. Pure — no I/O. */
export function sweepAudio(data: Uint8Array, range: ByteRange): AudioRangeResult {
  const candidates: AudioCandidate[] = [];
  for (const enc of sweepEncodings()) {
    const chans = decodePcm(data, range.start, range.end, enc);
    if (chans[0].length < 256) continue;
    const rough = mean(chans.map(normalizedRoughness));
    const auto = mean(chans.map(lag1Autocorrelation));
    const zeroDelta = mean(chans.map(zeroDeltaFraction));
    const flat = zeroDelta > MAX_ZERO_DELTA;
    const score = flat ? 0 : 0.6 * clamp01(auto) + 0.4 * clamp01(1 - rough / ROUGHNESS_NOISE);
    candidates.push({
      encoding: enc,
      roughness: round4(rough),
      autocorrelation: round4(auto),
      zeroDeltaFraction: round4(zeroDelta),
      score: round3(score),
      verdict:
        !flat && auto >= PLAUSIBLE_AUTOCORR && rough <= PLAUSIBLE_ROUGHNESS ? 'plausible' : 'unlikely',
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return {
    range: { start: range.start, end: range.end, label: range.label },
    candidates,
    sampleRate: null,
  };
}

// ── Stage 3: artifacts ─────────────────────────────────────────────────

const FFT_SIZE = 256;
const HOP = 128;
const MAX_SPEC_COLS = 512;

/** In-place radix-2 FFT (re/im arrays, length must be a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/** Log-magnitude spectrogram of a mono signal: columns × FFT_SIZE/2 bins. */
export function spectrogram(samples: Float32Array): { cols: number; bins: number; mags: Float32Array } {
  const cols = Math.min(Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP)), MAX_SPEC_COLS);
  const bins = FFT_SIZE / 2;
  const mags = new Float32Array(cols * bins);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let c = 0; c < cols; c++) {
    for (let i = 0; i < FFT_SIZE; i++) {
      // Hann window.
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      re[i] = samples[c * HOP + i] * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b], im[b]);
      mags[c * bins + b] = Math.log10(1 + mag * 100);
    }
  }
  return { cols, bins, mags };
}

/** Spectrogram grid PNG for the top candidates of one range. */
export function renderSpectrogramGrid(
  data: Uint8Array,
  range: ByteRange,
  candidates: AudioCandidate[],
): Canvas {
  const bins = FFT_SIZE / 2;
  const cellW = MAX_SPEC_COLS;
  const captionH = 10;
  const cellH = bins + captionH + 4;
  const c = createCanvas(cellW + 8, candidates.length * cellH + 4, [24, 24, 24]);

  candidates.forEach((cand, i) => {
    const y0 = 4 + i * cellH;
    const chans = decodePcm(data, range.start, range.end, cand.encoding, MAX_SPEC_COLS * HOP + FFT_SIZE);
    const spec = spectrogram(chans[0]);
    let peak = 0;
    for (const v of spec.mags) peak = Math.max(peak, v);
    for (let col = 0; col < spec.cols; col++) {
      for (let b = 0; b < bins; b++) {
        // Low frequencies at the bottom.
        setPixel(c, 4 + col, y0 + (bins - 1 - b), heatColor(peak === 0 ? 0 : spec.mags[col * bins + b] / peak));
      }
    }
    const e = cand.encoding;
    const caption = `#${i + 1} ${e.signed ? 'S' : 'U'}${e.bits}${e.endian ? e.endian.toUpperCase() : ''} ${e.channels === 2 ? 'ST' : 'MO'} R=${cand.roughness.toFixed(3)} A=${cand.autocorrelation.toFixed(2)} ${cand.verdict.toUpperCase()}`;
    drawText(c, 4, y0 + bins + 2, caption, [220, 220, 220]);
    fillRect(c, 0, y0 + cellH - 2, c.width, 1, [60, 60, 60]);
  });
  return c;
}

// ── CLI ────────────────────────────────────────────────────────────────

/** The corpus's most common hardware playback rate ballpark; only used to make snippets audible. */
const ASSUMED_RATE = 8000;
const SNIPPET_SECONDS = 2;

export const AUDIO_USAGE = `seer-probe audio <file> [--range start:end] [--regions <probe-map.json>] [--top 5] [--out <dir>]
  Detect audio containers at any offset (HUNK-wrapped and concatenated
  IFF forms included; one WAV per 8SVX voice at its real VHDR rate), then
  sweep raw-PCM encodings scored by normalized roughness + lag-1
  autocorrelation. Writes a spectrogram grid PNG and WAV snippets of the
  top candidates (at an ASSUMED rate unless a container header supplied a
  real one — raw PCM cannot reveal its rate).`;

export async function runAudio(argv: string[]): Promise<number> {
  const { positional, flags } = parseFlags(argv, {
    range: 'string',
    regions: 'string',
    top: 'number',
    out: 'string',
  });
  const file = positional[0];
  if (!file) {
    console.error(AUDIO_USAGE);
    return 1;
  }
  const data = readBinary(file);
  const top = (flags.top as number) ?? 5;
  const outDir = ensureOutDir(flags.out as string | undefined);

  const containers = scanContainers(data);
  for (const hit of containers) {
    console.log(`container: ${hit.kind} at 0x${hit.offset.toString(16)} — ${hit.detail}`);
  }

  const result: AudioResult = { file, size: data.length, containers, ranges: [], assumedSnippetRate: null };
  let jsonSuffix = '';

  // Confirmed 8SVX voices short-circuit the sweep: the headers ARE the
  // answer. A file can hold many (concatenated banks, hunk-wrapped banks) —
  // one WAV per voice, each at its own real VHDR rate.
  const voices = containers.filter((h) => h.kind === 'iff-8svx' && h.sampleRate !== null);
  if (voices.length > 0) {
    voices.forEach((hit, i) => {
      const inst = parse8svx(data.subarray(hit.offset, hit.offset + (hit.length ?? data.length - hit.offset)));
      const mono = new Float32Array(inst.sampleData.length);
      for (let s = 0; s < mono.length; s++) mono[s] = ((inst.sampleData[s] << 24) >> 24) / 128;
      const wavPath = artifactPath(
        outDir,
        'audio',
        file,
        `-${i + 1}-0x${hit.offset.toString(16)}-r${inst.samplesPerSec}.wav`,
      );
      writeWav(wavPath, [mono], { sampleRate: inst.samplesPerSec });
      console.log(`wrote ${wavPath} (real header rate ${inst.samplesPerSec})`);
    });
  } else {
    const ranges = resolveRanges(
      { range: flags.range as string | undefined, regions: flags.regions as string | undefined },
      data.length,
      'audio',
    );
    if (ranges.length === 1 && !(ranges[0].start === 0 && ranges[0].end === data.length)) {
      jsonSuffix = `-0x${ranges[0].start.toString(16)}`;
    }
    result.assumedSnippetRate = ASSUMED_RATE;
    for (const r of ranges) {
      const swept = sweepAudio(data, r);
      result.ranges.push(swept);
      const topCands = swept.candidates.slice(0, top);
      if (topCands.length === 0) continue;

      // Suffix every partial range, not just multi-region runs — two --range
      // invocations on the same file must not overwrite each other's artifacts.
      const suffix = r.start === 0 && r.end === data.length ? '' : `-0x${r.start.toString(16)}`;
      const grid = renderSpectrogramGrid(data, r, topCands);
      const gridPath = artifactPath(outDir, 'audio', file, `${suffix}-spec.png`);
      await writePNG(gridPath, grid.rgba, grid.width, grid.height);
      console.log(`0x${r.start.toString(16)}-0x${r.end.toString(16)}: best ${describeEncoding(topCands[0])}`);
      console.log(`wrote ${gridPath}`);

      topCands.forEach((cand, i) => {
        const chans = decodePcm(data, r.start, r.end, cand.encoding, ASSUMED_RATE * SNIPPET_SECONDS);
        const wavPath = artifactPath(
          outDir,
          'audio',
          file,
          `${suffix}-${i + 1}-${encodingTag(cand.encoding)}-r${ASSUMED_RATE}assumed.wav`,
        );
        writeWav(wavPath, chans, { sampleRate: ASSUMED_RATE });
        console.log(`wrote ${wavPath}`);
      });
    }
  }

  const jsonPath = artifactPath(outDir, 'audio', file, `${jsonSuffix}.json`);
  writeJson(jsonPath, result);
  console.log(`wrote ${jsonPath}`);
  return 0;
}

function describeEncoding(c: AudioCandidate): string {
  return `${encodingTag(c.encoding)} roughness=${c.roughness} autocorr=${c.autocorrelation} (${c.verdict})`;
}

function encodingTag(e: PcmEncoding): string {
  return `${e.signed ? 's' : 'u'}${e.bits}${e.endian ?? ''}${e.channels === 2 ? 'st' : 'mo'}`;
}

function zeroDeltaFraction(samples: Float32Array): number {
  if (samples.length < 2) return 1;
  let eq = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] === samples[i - 1]) eq++;
  }
  return eq / (samples.length - 1);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}


function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
