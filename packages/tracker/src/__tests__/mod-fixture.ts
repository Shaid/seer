/**
 * Builders for synthetic ProTracker MOD files.
 *
 * `Module`'s parser reads a fixed 1084-byte header (song name, 31 instrument
 * headers, sequence, format tag) followed by pattern data and then raw sample
 * data. Hand-rolling that layout per test would bury the assertion, so these
 * helpers emit a well-formed module and let each test vary just the field it
 * cares about.
 */

/** One instrument header's worth of fields, all in the units the file uses (lengths in *words*, i.e. half the byte count). */
export interface InstrumentSpec {
  lengthWords?: number;
  /** Raw 4-bit finetune nibble as stored, *not* the signed value `Module` derives from it. */
  fineTune?: number;
  /** Raw volume byte as stored, before the parser's `& 0x7F` and clamp to 64. */
  volume?: number;
  loopStartWords?: number;
  loopLengthWords?: number;
  /** Sample bytes appended after the pattern data; padded with zeros up to `lengthWords * 2`. */
  sample?: number[];
}

export interface NoteSpec {
  /** Cell index into the pattern area: `row * numChannels + channel`. */
  index: number;
  period?: number;
  instrument?: number;
  effect?: number;
  param?: number;
}

export interface ModSpec {
  songName?: string;
  /** Four-character format tag at offset 1080 — 'M.K.', 'FLT4', '6CHN', '16CH'... */
  tag?: string;
  sequence?: number[];
  sequenceLength?: number;
  restartPos?: number;
  notes?: NoteSpec[];
  instruments?: Record<number, InstrumentSpec>;
  /** Chop this many bytes off the end, to exercise the truncated-sample path. */
  dropTrailingBytes?: number;
}

const HEADER_BYTES = 1084;
const NUM_INSTRUMENTS = 31;

/** Mirrors `Module`'s own tag decoding, so fixtures and parser agree on channel count. */
export function channelsForTag(tag: string): number {
  if (tag === 'M.K.' || tag === 'M!K!' || tag === 'FLT4') return 4;
  if (tag.slice(1) === 'CHN') return tag.charCodeAt(0) - 48;
  if (tag.slice(2) === 'CH') return (tag.charCodeAt(0) - 48) * 10 + (tag.charCodeAt(1) - 48);
  throw new Error(`test fixture: unhandled tag ${tag}`);
}

function writeAscii(buf: Uint8Array, offset: number, text: string, len: number): void {
  for (let i = 0; i < len; i++) buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
}

function writeWord(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

export function buildMod(spec: ModSpec = {}): Uint8Array {
  const tag = spec.tag ?? 'M.K.';
  const numChannels = channelsForTag(tag);
  const sequence = spec.sequence ?? [0];
  const instruments = spec.instruments ?? {};

  // `Module` scans all 128 sequence slots, not just the active length.
  let numPatterns = 1;
  for (let i = 0; i < 128; i++) {
    const pat = (sequence[i] ?? 0) & 0x7f;
    if (pat >= numPatterns) numPatterns = pat + 1;
  }

  const patternBytes = numPatterns * 64 * numChannels * 4;
  let sampleBytes = 0;
  for (let i = 1; i <= NUM_INSTRUMENTS; i++) sampleBytes += (instruments[i]?.lengthWords ?? 0) * 2;

  const buf = new Uint8Array(HEADER_BYTES + patternBytes + sampleBytes);

  writeAscii(buf, 0, spec.songName ?? 'test module', 20);

  for (let i = 1; i <= NUM_INSTRUMENTS; i++) {
    const inst = instruments[i];
    if (!inst) continue;
    const base = 20 + (i - 1) * 30;
    writeAscii(buf, base, `inst${i}`, 22);
    writeWord(buf, base + 22, inst.lengthWords ?? 0);
    buf[base + 24] = inst.fineTune ?? 0;
    buf[base + 25] = inst.volume ?? 64;
    writeWord(buf, base + 26, inst.loopStartWords ?? 0);
    writeWord(buf, base + 28, inst.loopLengthWords ?? 0);
  }

  buf[950] = spec.sequenceLength ?? sequence.length;
  buf[951] = spec.restartPos ?? 0;
  for (let i = 0; i < 128; i++) buf[952 + i] = sequence[i] ?? 0;
  writeAscii(buf, 1080, tag, 4);

  for (const note of spec.notes ?? []) {
    const src = HEADER_BYTES + note.index * 4;
    const period = note.period ?? 0;
    const ins = note.instrument ?? 0;
    buf[src] = (ins & 0x10) | ((period >> 8) & 0x0f);
    buf[src + 1] = period & 0xff;
    buf[src + 2] = ((ins & 0x0f) << 4) | ((note.effect ?? 0) & 0x0f);
    buf[src + 3] = note.param ?? 0;
  }

  let sampleAt = HEADER_BYTES + patternBytes;
  for (let i = 1; i <= NUM_INSTRUMENTS; i++) {
    const inst = instruments[i];
    if (!inst) continue;
    const declared = (inst.lengthWords ?? 0) * 2;
    for (let j = 0; j < declared; j++) buf[sampleAt + j] = inst.sample?.[j] ?? 0;
    sampleAt += declared;
  }

  return spec.dropTrailingBytes ? buf.slice(0, buf.length - spec.dropTrailingBytes) : buf;
}

/**
 * A module that actually makes noise: one instrument with a non-trivial
 * sample, triggered on row 0 of channel 0.
 */
export function buildAudibleMod(overrides: ModSpec = {}): Uint8Array {
  const sample: number[] = [];
  for (let i = 0; i < 64; i++) sample.push(i < 32 ? 100 : -100); // a square wave
  return buildMod({
    instruments: { 1: { lengthWords: 32, volume: 64, sample } },
    notes: [{ index: 0, period: 856, instrument: 1 }],
    ...overrides,
  });
}
