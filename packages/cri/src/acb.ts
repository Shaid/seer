/**
 * CRI ACB (Atom Cue Bank) reader — resolves an ACB's cue names and
 * waveform metadata, and pairs them with byte ranges in the ACB's AWB
 * (Atom Wave Bank), whether that's an external sibling file or an
 * embedded blob.
 *
 * ## Structure
 *
 * An ACB is itself one `@UTF` table (see cpk.ts) whose row 0 holds a
 * large flat set of columns, several of which are nested `@UTF` sub-tables
 * stored as type-0xb data blobs: `CueTable`, `CueNameTable`,
 * `WaveformTable`, `SynthTable`, `SequenceTable`, `TrackTable`, etc.
 * `WaveformTable` is the authoritative per-stream metadata source —
 * `EncodeType`, `Streaming`, `NumChannels`, `SamplingRate`, `NumSamples` —
 * confirmed against Dragon's Crown's `bgm.acb` (54 rows) and Grand Knights
 * History's `bgm.acb` (50 rows), and independently cross-checked against
 * `vgmstream-cli`'s own metadata report for `bgm.awb`: stream 1's reported
 * `sample rate: 48000 Hz`, `channels: 2`, `stream total samples: 3620736`
 * match `WaveformTable` row 0 (`Id:0, SamplingRate:48000, NumChannels:2,
 * NumSamples:3620736`) exactly, and `vgmstream-cli`'s own name resolution
 * (`stream name: BGM_000`) matches `CueNameTable` row 0 (`CueName:
 * "BGM_000", CueIndex:0`) — spot-checked at 6 positions spanning the full
 * 54-row range (indices 0, 1, 4, 9, 29, 53), 0 deviations.
 *
 * ## Cue name -> waveform resolution
 *
 * The full CRI cue graph (`CueTable.ReferenceType` — 1=Waveform direct,
 * 2=Synth, 3=Sequence, ... — chaining through `SynthTable`'s packed
 * `[u16 type, u16 index]` `ReferenceItems` pairs, and beyond that into
 * `SequenceTable`/`TrackTable`/`CommandTable` bytecode for randomized/
 * multi-layer cues) is not fully decoded here — verified by hand for one
 * `SYNTH`-referencing cue (Dragon's Crown `bgm.acb` CueIndex 0 ->
 * SynthTable row 0 -> ReferenceItems `[2,1]` (SYNTH, row 1) -> SynthTable
 * row 1 -> ReferenceItems `[1,0]` (WAVEFORM, row 0) -> WaveformTable row
 * 0), but not implemented as a general interpreter.
 *
 * Instead, this module uses **positional pairing**: `CueNameTable` row N's
 * name is paired with `WaveformTable` row N, used only when
 * `CueNameTable.numRows === WaveformTable.numRows` (the common case for
 * simple music/cue banks with no per-cue variation). This was independently
 * confirmed correct end-to-end by the `vgmstream-cli` cross-check above.
 * When the counts diverge — confirmed on Dragon's Crown's `se_common.acb`
 * (397 cue names vs. 350 waveforms, real per-cue randomization/variation) —
 * every waveform is still listed (full coverage, `WaveformTable` is
 * authoritative for that), but named generically (`waveform_<id>`) rather
 * than guessed, since no cue name can be soundly attributed. The full CRI
 * cue graph is intentionally left un-implemented (see above).
 */
import { parseUtf, readUtfRow, subUtfTable, type UtfTable } from './cpk.js';
import { parseAfs2, type AwbTable } from './awb.js';

/** Confirmed `WaveformTable.EncodeType` -> codec mappings (see module doc comment for the cross-check evidence). Unconfirmed values are reported as `unknown-<n>` rather than guessed — see `pixel-format-value-guessed-from-enum-not-confirmed.md`. */
const ENCODE_TYPE_CODEC: Record<number, string> = {
  2: 'hca', // Dragon's Crown (PS3) — confirmed via vgmstream-cli ("encoding: CRI HCA")
  8: 'atrac3', // Grand Knights History (PSP) — confirmed via the WAVE_FORMAT_SONY_SCX fmt-chunk tag on the raw stream
};

function codecForEncodeType(encodeType: number): string {
  return ENCODE_TYPE_CODEC[encodeType] ?? `unknown-${encodeType}`;
}

export interface AcbWaveform {
  /** Row index into WaveformTable — also the key used to look up byte ranges in the paired AWB (AwbEntry.id). */
  id: number;
  encodeType: number;
  /** Decoded from encodeType — see ENCODE_TYPE_CODEC. `'hca'` and `'atrac3'` are NOT decodable by this package (out of scope); only structural metadata is available for them. */
  codec: string;
  streaming: boolean;
  channelCount: number;
  sampleRate: number;
  sampleCount: number;
  durationSeconds: number;
}

export interface AcbTrack {
  name: string;
  /** `'cue-name'` when `name` is a real decoded CueNameTable entry; `'positional-placeholder'` when the cue/waveform counts diverged and no name could be soundly attributed (see module doc comment). */
  nameConfidence: 'cue-name' | 'positional-placeholder';
  waveform: AcbWaveform;
}

export interface ParsedAcb {
  cueCount: number;
  waveformCount: number;
  tracks: AcbTrack[];
  /** {offset,length}, relative to the ACB's own buffer (byte 0), of the embedded AwbFile blob — set if this bank carries its wave data inline rather than via an external sibling `.awb`. */
  embeddedAwb?: { offset: number; length: number };
}

function readWaveformTable(t: UtfTable): AcbWaveform[] {
  const out: AcbWaveform[] = [];
  for (let i = 0; i < t.numRows; i++) {
    const r = readUtfRow(t, i);
    const encodeType = Number(r['EncodeType'] ?? 0);
    const sampleRate = Number(r['SamplingRate'] ?? 0);
    const sampleCount = Number(r['NumSamples'] ?? 0);
    out.push({
      id: Number(r['Id'] ?? i),
      encodeType,
      codec: codecForEncodeType(encodeType),
      streaming: Number(r['Streaming'] ?? 0) !== 0,
      channelCount: Number(r['NumChannels'] ?? 0),
      sampleRate,
      sampleCount,
      durationSeconds: sampleRate > 0 ? sampleCount / sampleRate : 0,
    });
  }
  return out;
}

function readCueNames(t: UtfTable): { name: string; cueIndex: number }[] {
  const out: { name: string; cueIndex: number }[] = [];
  for (let i = 0; i < t.numRows; i++) {
    const r = readUtfRow(t, i);
    out.push({ name: String(r['CueName'] ?? `cue_${i}`), cueIndex: Number(r['CueIndex'] ?? i) });
  }
  return out;
}

/** Parse an ACB's top-level `@UTF` table and resolve its track list. `acbBuf` must be the whole (already-decompressed, if applicable) ACB file. */
export function parseAcb(acbBuf: Uint8Array): ParsedAcb {
  const utf = parseUtf(acbBuf);
  const row = readUtfRow(utf, 0);

  const waveformTableCol = row['WaveformTable'];
  const waveformTable = subUtfTable(utf, waveformTableCol);
  const waveforms = waveformTable ? readWaveformTable(waveformTable) : [];

  const cueNameTable = subUtfTable(utf, row['CueNameTable']);
  const cueNames = cueNameTable ? readCueNames(cueNameTable) : [];

  const positionalOk = cueNames.length > 0 && cueNames.length === waveforms.length;
  const byCueIndex = new Map(cueNames.map((c) => [c.cueIndex, c.name]));

  const tracks: AcbTrack[] = waveforms.map((waveform, i) => {
    const name = positionalOk ? (byCueIndex.get(i) ?? cueNames[i]?.name) : undefined;
    return name
      ? { name, nameConfidence: 'cue-name' as const, waveform }
      : { name: `waveform_${waveform.id}`, nameConfidence: 'positional-placeholder' as const, waveform };
  });

  const awbFileCol = row['AwbFile'] as { offset: number; length: number } | undefined;
  // AwbFile's {offset,length} is relative to the ACB's own data-blob base
  // (8 + utf.dataOffset), same as every other nested-table column — convert
  // to an offset relative to acbBuf's own byte 0 so parseEmbeddedAwb can
  // slice acbBuf directly without needing to re-derive the blob base.
  const embeddedAwb =
    awbFileCol && awbFileCol.length > 0
      ? { offset: 8 + utf.dataOffset + awbFileCol.offset, length: awbFileCol.length }
      : undefined;

  return { cueCount: cueNames.length, waveformCount: waveforms.length, tracks, embeddedAwb };
}

/** Parse the embedded AwbFile blob (always classic AFS2 in this corpus — CRI only uses the nested-CPK/ITOC AWB shape for external `.awb` sibling files) directly out of the ACB's own buffer. */
export function parseEmbeddedAwb(acbBuf: Uint8Array, embeddedAwb: { offset: number; length: number }): AwbTable | null {
  return parseAfs2(acbBuf.subarray(embeddedAwb.offset, embeddedAwb.offset + embeddedAwb.length));
}

export interface ResolvedAcbTrack extends AcbTrack {
  /** Byte offset relative to the AWB container's own start (external file or embedded blob) — absent if this waveform's id has no matching AWB entry. */
  awbOffset?: number;
  awbLength?: number;
}

/** Pair each track's waveform id against an already-parsed AwbTable's entries (looked up by id, not array position — AWB entry ids aren't always contiguous/0-based). */
export function resolveAcbAwbOffsets(tracks: AcbTrack[], awb: AwbTable): ResolvedAcbTrack[] {
  const byId = new Map(awb.entries.map((e) => [e.id, e]));
  return tracks.map((t) => {
    const e = byId.get(t.waveform.id);
    return e ? { ...t, awbOffset: e.offset, awbLength: e.size } : { ...t };
  });
}
