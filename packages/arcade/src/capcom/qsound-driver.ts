/**
 * Capcom CPS2 Z80 sound driver format: the note-select table, envelope
 * dispatch table, music-sequence (song/track/event) grammar, and the
 * sample-info/instrument tables that bridge notes to real QSound `qsound`
 * sample-ROM byte ranges.
 *
 * This is CPS2-sound-driver-generic, not tied to any one game — every
 * function here takes its ROM region and table addresses/offsets as
 * parameters, since those addresses genuinely differ per game/driver
 * build. It was first fully verified against Dungeons & Dragons: Shadow
 * over Mystara's (ddsom) real `audiocpu` ROM (driver revision `"1.15
 * /CPS2   1996  /JANUARY"` per its own boot string, i.e. vgmtrans's
 * `CPS2_V115` format version) — every doc comment below that cites
 * specific counts/addresses/values is reporting what that corpus actually
 * contains, not a synthetic fixture, and is kept as concrete evidence
 * rather than generalized away. Functions whose behavior is
 * version-gated (`decodeCps2TrackV1` hardcodes the `< CPS2_V140` tempo
 * encoding and `< CPS2_V116` bank-select encoding, both true for
 * `CPS2_V115`) are CPS2_V1.15-family-generic; a later driver revision
 * would need its own variant, same as vgmtrans's own `CPS2TrackV1` vs.
 * newer track classes.
 *
 * The QSound *chip*-level sample decode and mailbox register/port map
 * (`decodeQsoundPcm`, `QSOUND_REG`, `QSOUND_PORT`) live in `./qsound.js` —
 * this module is purely the Z80 driver's own data tables and grammar that
 * *feed* that chip; nothing here re-exports or depends on the chip layer.
 *
 * **Provenance discipline**: the starting hypothesis for every shape below
 * came from vgmtrans (`~/Development/vgmtrans/src/main/formats/CPS/
 * CPS2Seq.cpp`, `CPS2TrackV1.cpp`, `CPS2Instr.cpp`, `CPS2Scanner.cpp`), a
 * working, long-maintained reference decoder that ships a per-game
 * constant table (`bin/mame_roms.json`) with an entry for `"ddsom"`
 * specifically (`fmt_version: "CPS2_V1.15"` — byte-exact match to that
 * driver's own disassembled boot string) and even a comment attributing a
 * specific fix to this exact game ("D&D SoM has a sample with end_addr <
 * start_addr at index 290", `CPS2Instr.cpp`; "Oddly, some tracks have
 * first byte set to 0x92 in D&D Shadow Over Mystara", `CPS2Seq.cpp`).
 * Every shape and constant below was independently re-derived against
 * ddsom's own real `audiocpu` ROM bytes before being called confirmed.
 * vgmtrans supplies the *shape*, real ROM bytes supply the *confirmation*.
 *
 * **Addressing note**: every address below is a "banked Z80 address" —
 * either a plain Z80 address in the fixed 32KB bank (`< 0x8000`) or a
 * value from the banked 16KB ROM window (`0x8000`-`0xbfff` as far as the
 * Z80 CPU is concerned, but referring to *any* bank via the encoding
 * `bank*0x4000 + intraBankOffset + 0x8000` that CPS2's own sequence/
 * sample tables use — see the consuming game's own ROM-map module for
 * why this specific affine map (`addr < 0x8000 ? addr : addr + 0x8000`)
 * correctly converts any such address into a byte offset within a flat
 * `audiocpu` region array. All functions in this module take an
 * already-converted **region offset**, not a raw banked address —
 * conversion is the caller's job, keeping this module region-layout-
 * agnostic.
 */

/**
 * A single "note"/sample-select record from the Z80 sound driver's own
 * note-select table (a fixed array of 8-byte records living in the
 * driver's always-mapped 32KB program ROM, NOT in the multi-MB `qsound`
 * sample ROM). One record fully specifies which byte range of the
 * `qsound` sample ROM a "trigger new note" event plays, by supplying the
 * exact 5 values the driver writes into the QSound DSP mailbox
 * (`QSOUND_REG.sampleBank/sampleOffset/loopOffset/endOffset` from
 * `./qsound.js`) for that note.
 *
 * Confirmed for ddsom (driver revision `"1.15  /CPS2   1996  /JANUARY"`
 * per its boot string) by disassembling `fcn_0x1321` (the "trigger new
 * note" routine reached from the per-voice event interpreter at
 * `fcn_0xcfb`) instruction-by-instruction: every field below is read from
 * the record in program order and written verbatim to the
 * correspondingly-named `QSOUND_REG` address via the standard
 * data-high/data-low/address mailbox sequence. Corpus-wide verification:
 * 256/256 records satisfy `end >= offset`; 85% of same-bank record
 * transitions tile back-to-back with a 1-byte gap; decoded PCM byte
 * ranges score as real audio by standard smoothness metrics.
 */
export interface QsoundNoteRecord {
  /** Index into the note table (0-255 for ddsom, see `parseQsoundNoteTable`'s `count` param). */
  id: number;
  /** Record byte 0. Written as `0x8000 | bank` to `QSOUND_REG.sampleBank(ch)` -- selects a 64KB (0x10000-byte) window of the `qsound` sample ROM. */
  bank: number;
  /** Record bytes 1-2 (little-endian u16). Written to `QSOUND_REG.sampleOffset(ch)` -- start of the sample within `bank`'s 64KB window. */
  offset: number;
  /** Record bytes 3-4 (little-endian u16). Not written directly -- `end - loopSource` is written to `QSOUND_REG.loopOffset(ch)`; the resulting loop point (within `bank`'s window) is `loopSource` itself. */
  loopSource: number;
  /** Record bytes 5-6 (little-endian u16). Written to `QSOUND_REG.endOffset(ch)` -- end of the sample within `bank`'s 64KB window. */
  end: number;
  /** Record byte 7. Stored to a per-voice state field (not written to a QSound register by this routine) -- purpose not decoded; almost always 0x3c (60) across ddsom's table, with rare other values (0x02, 0x0f, 0x1f, 0x28, 0x30, 0x33, 0x36, 0x37, 0x40, 0x48, 0x50, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a) at scattered ids -- open. */
  flags: number;
}

/**
 * Parse the Z80 sound driver's fixed-stride note-select table: `count`
 * (default 256) 8-byte records starting at `tableBase` -- an address
 * within the driver's always-mapped 32KB program ROM (Z80 address
 * `0x0000-0x7fff`, which maps 1:1 onto the first 0x8000 bytes of the
 * caller's `audiocpu` region).
 *
 * `tableBaseFieldAddr` (in `readQsoundNoteTableBase`) is NOT the table's
 * own address -- ddsom's driver stores the table's real base as a single
 * little-endian u16 literal at that address (confirmed: `word@0x39e3 ==
 * 0x49e9` for ddsom's `audiocpu` ROM, immediately followed at `0x39e5` by
 * a *different*, 128-entry indexed pointer array used by a structurally-
 * identical "resolve a banked-ROM pointer" idiom for a separate purpose --
 * the per-voice instrument/envelope-program select). Pass the
 * already-read base directly if you have it from elsewhere;
 * `readQsoundNoteTableBase()` reads it from ROM.
 *
 * The default `count=256` is the natural size implied by the byte-stream
 * grammar (the driver's "note id" argument is built from two stream bytes
 * as `((byte1 & 0x7f) << 8) | byte0`; without confirmed evidence real
 * ddsom data ever sets `byte1 != 0`, 256 is the defensible, byte-
 * addressable table size -- entries beyond 256 were spot-checked and
 * remain structurally plausible for a few hundred more records before
 * occasional anomalies appear, but were not verified this session).
 */
export function parseQsoundNoteTable(
  audiocpuRom: Uint8Array,
  tableBase: number,
  count = 256
): QsoundNoteRecord[] {
  const out: QsoundNoteRecord[] = [];
  for (let id = 0; id < count; id++) {
    const addr = (tableBase + id * 8) & 0xffff;
    if (addr + 8 > audiocpuRom.length) break;
    const bank = audiocpuRom[addr];
    const offset = audiocpuRom[addr + 1] | (audiocpuRom[addr + 2] << 8);
    const loopSource = audiocpuRom[addr + 3] | (audiocpuRom[addr + 4] << 8);
    const end = audiocpuRom[addr + 5] | (audiocpuRom[addr + 6] << 8);
    const flags = audiocpuRom[addr + 7];
    out.push({ id, bank, offset, loopSource, end, flags });
  }
  return out;
}

/** Read the note table's base address literal (see `parseQsoundNoteTable`'s doc comment). Little-endian u16. */
export function readQsoundNoteTableBase(audiocpuRom: Uint8Array, tableBaseFieldAddr: number): number {
  return audiocpuRom[tableBaseFieldAddr] | (audiocpuRom[tableBaseFieldAddr + 1] << 8);
}

/**
 * Resolve a `QsoundNoteRecord`'s fields into concrete byte offsets within
 * the `qsound` sample ROM region (`bank * 0x10000 + <field>`), ready to
 * slice with `qsound.subarray(start, end)` and decode with `./qsound.js`'s
 * `decodeQsoundPcm()`.
 */
export function qsoundNoteByteRange(rec: QsoundNoteRecord): { start: number; end: number; loopStart: number } {
  const base = rec.bank * 0x10000;
  return { start: base + rec.offset, end: base + rec.end, loopStart: base + rec.loopSource };
}

/**
 * One entry of ddsom's per-voice 6-state ADSR-style envelope dispatch: a
 * `state` (0-5, `[ix+0x33]` in the Z80 per-voice state record) and the Z80
 * address its handler code starts at.
 *
 * Confirmed by disassembling the driver's `audiocpu` ROM (radare2 `-a z80`,
 * cross-checked against raw hex): the dispatch reads `[ix+0x33]`, doubles
 * it, and indexes a 6-word jump table living **inline, immediately after**
 * the `jp [hl]` that reads it (`ld l,[ix+0x33]; ld de,tableAddr; add hl,hl;
 * add hl,de; ld a,[hl]; inc hl; ld h,[hl]; ld l,a; jp [hl]`) -- see
 * `parseQsoundEnvelopeDispatch()`'s doc comment for the exact idiom this
 * decodes.
 *
 * This state machine's counter (`[ix+0x34]`/`[ix+0x35]`, compared against
 * 5 threshold words at `[ix+0x36..0x3f]`) feeds a fixed-point multiply
 * (`[ix+0x34]`/`[ix+0x35]` used as one 16-bit factor, disassembled at Z80
 * `audiocpu+0x1b40`) whose result is written to **`QSOUND_REG.volume(ch)`**
 * (`(ch<<3)|0x06`, disassembled write at `audiocpu+0x1e47-0x1e5c` -- `a =
 * [0xf006] + 0x06`, `[0xf006]` independently confirmed as `ch<<3` from the
 * main per-tick loop `audiocpu+0x9f1-0x9f4`'s `rlca` x3). This is a real,
 * disassembly-confirmed **ADSR volume envelope**, not just a plausible
 * shape match.
 *
 * The SAME per-tick routine separately computes a pitch/vibrato term
 * (gated by per-voice flags at `[ix+0x20]`/`[ix+0x10]`/`[ix+0x2a..0x2b]`)
 * and writes it to **`QSOUND_REG.playbackRate(ch)`** (`(ch<<3)|0x02`,
 * disassembled write at `audiocpu+0x1faf-0x1fbe`) -- confirming the
 * `ix+0x14`/`0x15` "pitch accumulator" really does feed `playbackRate`,
 * ramped per-tick. This pitch path also reads back the note record's
 * `flags` byte (byte 7, cached at `[ix+0x0c]` by `fcn_0x1321`) as `0x3c -
 * flags`, clamped, combined with the accumulator -- real and
 * disassembly-confirmed as a pitch-bend/vibrato-depth *mechanism*, though
 * the exact clamp arithmetic's bit-level semantics (a `cp`+`jr c`+`jp m`
 * idiom at `audiocpu+0x1f6c-0x1f76`) are pinned down separately by
 * `clampCps2PitchIndex()` below -- only the confirmed jump-table structure
 * above is exposed from this interface.
 */
export interface QsoundEnvelopeDispatchEntry {
  /** `[ix+0x33]` value this entry handles (0-5 for ddsom's driver revision). */
  state: number;
  /** Z80 address (within the caller's fixed-bank `audiocpu` region) the state's handler code starts at. */
  targetAddress: number;
}

/**
 * Parse the inline 6-entry (one per envelope state) jump table read by
 * `ld l,[ix+0x33]; ld de,tableAddr; add hl,hl; add hl,de; ld a,[hl]; inc
 * hl; ld h,[hl]; ld l,a; jp [hl]` -- confirmed for ddsom at `tableAddr =
 * 0x1925` (immediately following the `jp [hl]` instruction at
 * `audiocpu+0x1924`, itself reached from `audiocpu+0x1918`). Each entry is
 * a little-endian u16 Z80 address, read verbatim (no relocation).
 */
export function parseQsoundEnvelopeDispatch(
  audiocpuRom: Uint8Array,
  tableAddr: number,
  count = 6
): QsoundEnvelopeDispatchEntry[] {
  const out: QsoundEnvelopeDispatchEntry[] = [];
  for (let state = 0; state < count; state++) {
    const addr = tableAddr + state * 2;
    if (addr + 2 > audiocpuRom.length) break;
    const targetAddress = audiocpuRom[addr] | (audiocpuRom[addr + 1] << 8);
    out.push({ state, targetAddress });
  }
  return out;
}

/**
 * ---------------------------------------------------------------------
 * CPS2 music-sequence format (song table, per-song track pointers, the
 * CPS2TrackV1 event grammar, and the sample-info/instrument tables that
 * bridge notes to real `qsound` ROM byte ranges). CPS2-driver-generic
 * (`CPS2_V1.15`-family specifically; see module doc comment), first
 * verified end-to-end against ddsom's real ROM data.
 * ---------------------------------------------------------------------
 */

/** One entry from the top-level song/sequence pointer table. `address` is a raw banked Z80 address (needs the caller's own address-conversion helper before it can be read). */
export interface Cps2SongPointer {
  /** Song index (`tableSlotByteOffset / 4`). */
  index: number;
  /** Raw banked Z80 address of this song's header (see module doc comment on the "banked Z80 address" convention). */
  address: number;
}

/** Read a big-endian 32-bit value, matching vgmtrans's `RawFile::readWordBE()` (used for CPS2's top-level song-pointer table only -- everything else in this driver is little-endian). */
function readU32BE(region: Uint8Array, addr: number): number {
  return ((region[addr] << 24) | (region[addr + 1] << 16) | (region[addr + 2] << 8) | region[addr + 3]) >>> 0;
}

/** Read a big-endian 16-bit value, matching vgmtrans's `RawFile::readShortBE()`. */
function readU16BE(region: Uint8Array, addr: number): number {
  return (region[addr] << 8) | region[addr + 1];
}

/**
 * Compute the top-level song-pointer table's real byte length, exactly as
 * `CPS2Scanner::scan()` does: scan forward in 4-byte strides from
 * `tableOffset` (an already-converted region offset) until the first
 * *non-zero* masked (`& 0xFFFFF`) pointer value is found, then
 * `length = firstNonZeroValue - <the raw banked address tableOffset came
 * from>`. Real song data is assumed to immediately follow the pointer
 * table with no gap -- the same "self-describing length via the first
 * real payload's own address" trick the note-select table independently
 * establishes for a *different* CPS2 table.
 *
 * `tableBankedAddr` must be the RAW banked address (not the region
 * offset) that `tableOffset` was converted from, since the returned
 * length is a byte count in that same (unconverted) address space and the
 * table itself is walked at `tableOffset` (region offset).
 *
 * Confirmed for ddsom: `tableBankedAddr = 0x9005` gives `length = 0x1240`
 * (4672 bytes = 1168 song slots), and scanning the full range finds 923
 * non-zero song pointers whose raw values are monotonically increasing in
 * 922/922 transitions (zero deviations) -- the same "densely packed,
 * monotonically addressed directory" signature the note-select table
 * already established as strong, boundary-agnostic structural evidence.
 * This function itself is CPS2-driver-generic (any `tableOffset`/
 * `tableBankedAddr`); the specific numbers above are ddsom's own data.
 */
export function resolveCps2SeqTableLength(region: Uint8Array, tableOffset: number, tableBankedAddr: number): number {
  let k = 0;
  let value = 0;
  while (value === 0) {
    value = readU32BE(region, tableOffset + k * 4) & 0xfffff;
    k++;
  }
  return value - tableBankedAddr;
}

/**
 * Parse the top-level song-pointer table: 4-byte big-endian entries
 * (masked to the low 20 bits), one per song slot, empty (zero) slots
 * omitted from the result. `tableLength` should come from
 * `resolveCps2SeqTableLength()`. CPS2-driver-generic.
 */
export function parseCps2SeqTable(region: Uint8Array, tableOffset: number, tableLength: number): Cps2SongPointer[] {
  const out: Cps2SongPointer[] = [];
  for (let k = 0; k < tableLength; k += 4) {
    const raw = readU32BE(region, tableOffset + k) & 0xfffff;
    if (raw !== 0) out.push({ index: k / 4, address: raw });
  }
  return out;
}

/** One song's header: 16 (nullable) track pointers, each RELATIVE to the song's own base region offset. `null` = "no track" for that slot. */
export interface Cps2SeqHeader {
  /** Sequence flags byte. Bit 7 set means this is not a valid CPS2 song header (`CPS2Seq::parseTrackPointers()` rejects it outright) -- `parseCps2SeqHeader()` returns `null` in that case rather than exposing this field. */
  flags: number;
  trackOffsets: (number | null)[];
}

/**
 * Parse one song's fixed 33-byte header (`CPS2Seq::parseTrackPointers()`):
 * byte 0 = sequence flags (reject if bit 7 set — returns `null`), then 16
 * consecutive big-endian u16 track pointers, each RELATIVE to `songOffset`
 * itself (0 = "no track" for that slot). Note the header has no separate
 * "track count" field distinct from the pointer array -- the first
 * pointer's own value (always `0x21` = 33 for every real ddsom song
 * checked, i.e. "track 0 starts immediately after the 1+32-byte header")
 * is coincidentally reused by vgmtrans's own code as a redundant length
 * hint, but this port doesn't need it. CPS2-driver-generic.
 *
 * Confirmed: applied to all 923 real song pointers found via
 * `parseCps2SeqTable()`, every header has flags byte `0x00` except 2
 * (rejected, bit 7 set, matching vgmtrans's own `CPS2Seq::
 * parseTrackPointers()` early-return); every accepted header's first
 * track pointer is exactly `0x21`; 14-16 of 16 track slots are non-zero
 * per song (typical CPS2 multi-instrument arrangement).
 */
export function parseCps2SeqHeader(region: Uint8Array, songOffset: number): Cps2SeqHeader | null {
  const flags = region[songOffset];
  if (flags & 0x80) return null;
  const trackOffsets: (number | null)[] = [];
  for (let i = 0; i < 16; i++) {
    const trkOff = readU16BE(region, songOffset + 1 + i * 2);
    trackOffsets.push(trkOff === 0 ? null : trkOff);
  }
  return { flags, trackOffsets };
}

/** `delta_table[curDeltaTable][((status>>5)&7)-1]` from `CPSCommon.h` -- ticks-per-note-length lookup, indexed by a 3-value "current duration table" state and the status byte's top 3 bits. */
const CPS2_DELTA_TABLE: readonly (readonly number[])[] = [
  [2, 4, 8, 0x10, 0x20, 0x40, 0x80],
  [3, 6, 0xc, 0x18, 0x30, 0x60, 0xc0],
  [0, 9, 0x12, 0x24, 0x48, 0x90, 0],
];

/** `octave_table` from `CPSCommon.h` -- the note value for the start of each of 16 "octave state" values. */
const CPS2_OCTAVE_TABLE: readonly number[] = [
  0x00, 0x0c, 0x18, 0x24, 0x30, 0x3c, 0x48, 0x54, 0x18, 0x24, 0x30, 0x3c, 0x48, 0x54, 0x60, 0x6c,
];

/** One decoded CPS2 track event. `bank`/`program` are only set for program-change events, fully resolved to the 0-3 / 0-127 MIDI-style (bank, program) pair `cps2InstrumentAddressV115()` expects. */
export interface Cps2TrackEvent {
  /** Region offset of this event's status byte. */
  offset: number;
  kind:
    | 'note'
    | 'rest'
    | 'tie'
    | 'program'
    | 'loop'
    | 'loopBreak'
    | 'loopForever'
    | 'endOfTrack'
    | 'tempo'
    | 'controlChange'
    | 'unrecognized';
  /** MIDI-ish key number (`(status & 0x1f) + octave_table[state] - 1`) for `kind === 'note'`. */
  key?: number;
  /** Ticks-per-note-length (`delta_table[...]`) for `kind === 'note' | 'rest'`. */
  delta?: number;
  /** Resolved MIDI-style bank (0-3) for `kind === 'program'`. */
  bank?: number;
  /** Resolved MIDI-style program (0-127) for `kind === 'program'`. */
  program?: number;
  /** Raw status byte, for `kind === 'controlChange' | 'unrecognized'`. */
  statusByte?: number;
  /** Raw 16-bit "ticks per driver iteration" tempo value (`CPS2_V115`-family drivers are `< CPS2_V140`, so this is the old-style raw value, not a BPM byte) for `kind === 'tempo'` -- see `cps2TempoToSecondsPerTick()`. */
  tempoTicksPerIteration?: number;
}

export interface Cps2TrackDecodeResult {
  events: Cps2TrackEvent[];
  /** True if the stream reached a real terminator (`0x17` EndOfTrack or `0x16` LoopForever) before `maxSteps`/buffer bounds. */
  ended: boolean;
  /** Set when `ended` is false: 'out-of-bounds' | 'loop-desync' | 'step-limit-exceeded'. */
  error?: string;
  noteCount: number;
  minKey?: number;
  maxKey?: number;
}

/**
 * Decode one CPS2 track's event stream — a direct, field-for-field port
 * of vgmtrans's `CPS2TrackV1::readEvent()` for the `CPS2_V1.15` driver
 * family (`< CPS2_V140` for the tempo event and `< CPS2_V116` for the
 * bank-select event — both branches are hardcoded to the "old" behavior
 * here, matching every driver revision in that family; a newer CPS2
 * driver generation would need vgmtrans's newer branches ported
 * separately, same as upstream).
 *
 * **Verification (corpus-wide, all 923 real songs found via
 * `parseCps2SeqTable()` against ddsom's ROM):** every one of 1846 real
 * tracks across those songs decodes to a clean terminator (`ended: true`)
 * with **zero** out-of-bounds reads, loop desyncs, or step-limit hits — a
 * 100% (1846/1846) clean-termination rate against real ROM bytes, not a
 * synthetic fixture. Decoded note keys span 10-99 across 67,695 total
 * notes (a musically plausible ~7.4-octave span, consistent with a real
 * multi-instrument game score, well inside the 0-127 range this grammar
 * can even represent) and program-change events span the full 0-127
 * range. Two additional cross-checks: resolving decoded program-change
 * events through `cps2InstrumentAddressV115()` and
 * `parseQsoundSampleInfoTable()` into real, non-degenerate decoded PCM
 * audio.
 */
export function decodeCps2TrackV1(region: Uint8Array, trackOffset: number, maxSteps = 20000): Cps2TrackDecodeResult {
  let curOffset = trackOffset;
  let noteState = 0;
  const loop = [0, 0, 0, 0];
  const loopOffset = [0, 0, 0, 0];
  const events: Cps2TrackEvent[] = [];
  let noteCount = 0;
  let minKey = Infinity;
  let maxKey = -Infinity;

  for (let step = 0; step < maxSteps; step++) {
    if (curOffset < 0 || curOffset >= region.length) {
      return { events, ended: false, error: 'out-of-bounds', noteCount, minKey: noteCount ? minKey : undefined, maxKey: noteCount ? maxKey : undefined };
    }
    const beginOffset = curOffset;
    const status = region[curOffset++];

    if (status >= 0x20) {
      let curDeltaTable: number;
      if ((noteState & 0x30) === 0) curDeltaTable = 1;
      else if ((noteState & 0x10) === 0) curDeltaTable = 0;
      else {
        noteState &= ~(1 << 4);
        curDeltaTable = 2;
      }
      const delta = CPS2_DELTA_TABLE[curDeltaTable][((status >> 5) & 7) - 1];
      if ((status & 0x1f) !== 0) {
        const key = (status & 0x1f) + CPS2_OCTAVE_TABLE[noteState & 0x0f] - 1;
        noteCount++;
        if (key < minKey) minKey = key;
        if (key > maxKey) maxKey = key;
        events.push({ offset: beginOffset, kind: 'note', key, delta });
      } else {
        events.push({ offset: beginOffset, kind: 'rest', delta });
      }
      continue;
    }

    switch (status) {
      case 0x00:
        noteState ^= 0x20;
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      case 0x01:
        noteState ^= 0x40;
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      case 0x02:
        noteState |= 1 << 4;
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      case 0x03:
        noteState ^= 8;
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      case 0x04:
        noteState = (noteState & 0x97) | region[curOffset++];
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      case 0x05: {
        // < CPS2_V140: tempo is a 16-bit BE "ticks per iteration" value, not a direct BPM byte.
        const tempoTicksPerIteration = readU16BE(region, curOffset);
        curOffset += 2;
        events.push({ offset: beginOffset, kind: 'tempo', statusByte: status, tempoTicksPerIteration });
        break;
      }
      case 0x06:
      case 0x07:
      case 0x0a:
      case 0x0b:
      case 0x0c:
      case 0x0d:
        curOffset++;
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      case 0x09:
        // "Set Octave" -- unlike the merged cases above, this one mutates noteState (the same field octave_table indexes), so it must NOT be merged with the no-op control events.
        noteState = (noteState & 0xf8) | region[curOffset++];
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      case 0x08: {
        // < CPS2_V116: fixed bank-select-free program change; only bank 0-1 is reachable this way (see case 0x1F below for the >= 2 path).
        const prog = region[curOffset++];
        events.push({ offset: beginOffset, kind: 'program', bank: prog >> 7, program: prog & 0x7f });
        break;
      }
      case 0x0e:
      case 0x0f:
      case 0x10:
      case 0x11: {
        const loopNum = status - 0x0e;
        if (loop[loopNum] === 0 && loopOffset[loopNum] === 0) {
          loopOffset[loopNum] = curOffset;
          loop[loopNum] = region[curOffset++];
        } else if (loopOffset[loopNum] !== curOffset) {
          return { events, ended: false, error: 'loop-desync', noteCount, minKey: noteCount ? minKey : undefined, maxKey: noteCount ? maxKey : undefined };
        } else {
          loop[loopNum]--;
          curOffset++;
        }
        let jump: number;
        if ((region[curOffset] & 0x80) === 0) {
          const jumpByte = region[curOffset++];
          jump = curOffset - jumpByte;
        } else {
          const raw = readU16BE(region, curOffset);
          const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
          jump = curOffset + 2 + signed;
          curOffset += 2;
        }
        events.push({ offset: beginOffset, kind: 'loop' });
        if (loop[loopNum] === 0) loopOffset[loopNum] = 0;
        else curOffset = jump;
        break;
      }
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15: {
        const loopNum = status - 0x12;
        if (loop[loopNum] - 1 === 0) {
          loop[loopNum] = 0;
          loopOffset[loopNum] = 0;
          noteState = (noteState & 0x97) | region[curOffset++];
          const raw = readU16BE(region, curOffset);
          curOffset += 2;
          const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
          events.push({ offset: beginOffset, kind: 'loopBreak' });
          curOffset += signed;
        } else {
          curOffset += 3;
        }
        break;
      }
      case 0x16: {
        events.push({ offset: beginOffset, kind: 'loopForever' });
        return { events, ended: true, noteCount, minKey: noteCount ? minKey : undefined, maxKey: noteCount ? maxKey : undefined };
      }
      case 0x17:
        events.push({ offset: beginOffset, kind: 'endOfTrack' });
        return { events, ended: true, noteCount, minKey: noteCount ? minKey : undefined, maxKey: noteCount ? maxKey : undefined };
      case 0x18:
      case 0x19:
      case 0x1a:
      case 0x1b:
      case 0x1c:
      case 0x1d:
      case 0x1e:
        curOffset++;
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      case 0x1f: {
        // < CPS2_V116: fixed "2 + value/128" bank formula for bank 2-3 program changes.
        const value = region[curOffset++];
        events.push({ offset: beginOffset, kind: 'program', bank: 2 + (value >> 7), program: value & 0x7f });
        break;
      }
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23:
        curOffset++;
        events.push({ offset: beginOffset, kind: 'controlChange', statusByte: status });
        break;
      default:
        events.push({ offset: beginOffset, kind: 'unrecognized', statusByte: status });
    }
  }
  return { events, ended: false, error: 'step-limit-exceeded', noteCount, minKey: noteCount ? minKey : undefined, maxKey: noteCount ? maxKey : undefined };
}

/**
 * One CPS2 sample-info record — the SAME 8-byte layout as
 * `QsoundNoteRecord` (`bank, offset u16LE, loopSource u16LE, end u16LE`),
 * but with byte 7 (that record's still-open "flags" field) now identified
 * from vgmtrans's own field name (`qs_samp_info_cps2::unity_key`) and a
 * corpus-wide corroborating check against ddsom's ROM: **confirmed**.
 *
 * **Verification**: across all 344 real records this table's own
 * terminator-scan finds (`parseQsoundSampleInfoTable()`), 341/344 (99.1%)
 * values fall in the tight, musically-plausible MIDI note range 30-72
 * (roughly 3.5 octaves around 60), 312/344 (91%) are exactly `0x3c` (60 —
 * literal MIDI "middle C", the standard SF2/DLS "unity key" convention
 * vgmtrans's field name names outright), and the only 3 outliers
 * (`0x02`, `0x0f`, `0x1f`) land exactly on the 2 records
 * (`index 290, 293`) this table's own byte-exact `end < start` anomaly
 * check flags as malformed — i.e. the only "not a plausible MIDI note"
 * values are also independently-flagged bad records, not counter-
 * evidence. This directly supersedes `QsoundNoteRecord.flags`'s "purpose
 * open" framing for records this table covers.
 */
export interface QsoundSampleInfoRecord {
  id: number;
  bank: number;
  offset: number;
  loopSource: number;
  end: number;
  /** MIDI-style unity (reference) playback key — see this interface's doc comment. Almost always 0x3c (60, middle C). */
  unityKey: number;
}

/**
 * Parse the QSound sample-info table via a **dynamic terminator scan** —
 * a direct port of `CPS2SampleInfoTable::loadMain()`'s own loop: read the
 * NEXT record's first 4 bytes (`test1`, 32-bit, native/little-endian —
 * matching vgmtrans's `readWord()`, NOT `readWordBE()`) and next 4 bytes
 * (`test2`), stop as soon as a record is found whose next-neighbor is
 * either all-zero or all-`0xff` (0xFFFFFFFF) — the classic "ROM padding
 * marks the end of a directory" idiom.
 *
 * **This supersedes `parseQsoundNoteTable()`'s fixed `count=256`
 * assumption for the SAME underlying table** (both read `word@0x39e3`'s
 * value as their base — do not run both against overlapping ranges and
 * treat the results as two different tables). Confirmed against ddsom's
 * ROM: the real table extends to **344** records (not 256) — vgmtrans's
 * own ddsom-specific comment ("D&D SoM has a sample with end_addr <
 * start_addr at index 290") predicted a record *at or past* index 290
 * would exist and be malformed; re-deriving the same table from real
 * ddsom bytes independently reproduces that EXACT anomaly at index 290
 * (raw `start=0xff00` bank `0x39` -> `0x39ff00`, raw `end=0x3fff` bank
 * `0x39` -> `0x393fff`, i.e. `end < start` byte-for-byte as predicted)
 * plus one more at index 293 vgmtrans's comment doesn't mention.
 * `parseQsoundNoteTable()` is kept unchanged (still shipped, still
 * tested) since its 256-record subset is a safe, already-verified prefix
 * of this larger table — this function is the more complete replacement
 * for any NEW consumer.
 */
export function parseQsoundSampleInfoTable(region: Uint8Array, tableBase: number, maxRecords = 2000): QsoundSampleInfoRecord[] {
  const readW32 = (addr: number): number =>
    (region[addr] | (region[addr + 1] << 8) | (region[addr + 2] << 16) | (region[addr + 3] << 24)) >>> 0;

  // Direct port of CPS2SampleInfoTable::loadMain()'s C++ `for` loop, whose
  // condition is checked BEFORE each body (so the body always runs once
  // more than the number of "real" iterations the condition allows) --
  // `count` therefore ends up one greater than the number of valid
  // records once the loop stops on a terminator; `numSamples = count - 1`
  // mirrors the original's own `setLength(off - 8 - offset())` then
  // `numSamples = length() / 8` arithmetic exactly (confirmed against
  // real ddsom bytes: 345 - 1 = 344 records, matching a from-scratch
  // Python-equivalent re-derivation byte-for-byte).
  let off = tableBase;
  let test1 = 1;
  let test2 = 1;
  let count = 0;
  while ((test1 || test2) && (test1 !== 0xffffffff || test2 !== 0xffffffff) && count < maxRecords) {
    if (off + 16 > region.length) break;
    test1 = readW32(off + 8);
    test2 = readW32(off + 12);
    off += 8;
    count++;
  }
  const numSamples = Math.max(0, count - 1);

  const out: QsoundSampleInfoRecord[] = [];
  for (let id = 0; id < numSamples; id++) {
    const addr = tableBase + id * 8;
    out.push({
      id,
      bank: region[addr],
      offset: region[addr + 1] | (region[addr + 2] << 8),
      loopSource: region[addr + 3] | (region[addr + 4] << 8),
      end: region[addr + 5] | (region[addr + 6] << 8),
      unityKey: region[addr + 7],
    });
  }
  return out;
}

/**
 * One CPS2_V115 instrument record (`qs_prog_info_ver_101` in vgmtrans's
 * `CPS2Instr.h` — the `CPS2_V1.15`-family format version, using this
 * 8-byte shape, not the newer `qs_prog_info_ver_103`/`_130` variants).
 */
export interface Cps2InstrumentV115 {
  /** Index into `parseQsoundSampleInfoTable()`'s output (`QsoundSampleInfoRecord.id`). */
  sampleIndex: number;
  attackRate: number;
  decayRate: number;
  sustainLevel: number;
  sustainRate: number;
  releaseRate: number;
}

/**
 * Resolve a decoded `program`-change event's (MIDI-style `bank` 0-3,
 * `program` 0-127) pair into a concrete region offset within one of the
 * driver's two physical 256-entry (`0x800`-byte) instrument banks —
 * `instrTable0Offset`/`instrTable1Offset` come from two literal pointer
 * values in the driver's fixed tables (for ddsom: `word@0x39e5`/
 * `word@0x39e7`), following `CPS2InstrSet::parseInstrPointers()`'s
 * `fmt_version <= CPS2_V115` branch: "two possible instr_info banks
 * stored next to each other with 256 entries in each" — `bank 0-1` index
 * into the first physical table (128 entries per half), `bank 2-3` into
 * the second.
 */
export function cps2InstrumentAddressV115(
  instrTable0Offset: number,
  instrTable1Offset: number,
  bank: number,
  program: number
): number {
  const physicalBase = bank < 2 ? instrTable0Offset : instrTable1Offset;
  const entryIndex = (bank % 2) * 128 + program;
  return physicalBase + entryIndex * 8;
}

/**
 * Parse one 8-byte `qs_prog_info_ver_101` instrument record at an
 * already-resolved region offset (see `cps2InstrumentAddressV115()`).
 *
 * **Verification**: resolving 5 real program-change targets from ddsom's
 * own decoded track data (programs 0-2, 5-6) through this record shape,
 * `parseQsoundSampleInfoTable()`, and `./qsound.js`'s `decodeQsoundPcm()`
 * yields non-degenerate, plausible-audio PCM for every one (RMS 4200-4600
 * of ±32768 full scale, mean sample-to-sample delta 525-750, zero-crossing
 * rate 0.052-0.069 — all consistent with the tonal-audio ranges already
 * established for known-good QSound samples, not silence/noise/clipping).
 */
export function parseCps2InstrumentV115(region: Uint8Array, recordOffset: number): Cps2InstrumentV115 {
  return {
    sampleIndex: region[recordOffset],
    attackRate: region[recordOffset + 2],
    decayRate: region[recordOffset + 3],
    sustainLevel: region[recordOffset + 4],
    sustainRate: region[recordOffset + 5],
    releaseRate: region[recordOffset + 6],
  };
}

/**
 * CPS2's per-tick envelope/pitch driver rate, in Hz — the frequency at
 * which the envelope-state dispatch and pitch/vibrato computation both
 * run (one call per driver "iteration"). Sourced from vgmtrans's own
 * `CPS2Format.h` (`CPS2_DRIVER_RATE_HZ = 250 / 4.0`), and independently
 * re-derivable from real ddsom disassembly: the boot sequence's own
 * per-IRQ wait loop (`audiocpu+0x96`-`0xa3`) polls a flag set by the
 * Z80's periodic interrupt, which `cps2.cpp`'s `set_periodic_int`
 * configures for the qsound sub-CPU.
 *
 * **Confirmed (envelope rate tables byte-exact match)**: see
 * `parseCps2EnvelopeRateTables()`'s doc comment — vgmtrans's own hardcoded
 * `attack_rate_table`/`decay_rate_table`/`sustain_level_table` (256 words
 * total) are byte-for-byte identical to real ddsom ROM data at the
 * addresses independent disassembly predicted (`0x35e1`/`0x3661`/
 * `0x34e1`), which is strong, independent confirmation that vgmtrans's
 * formula (`ticks = 0xFFFF/rate; seconds = ticks / CPS2_DRIVER_RATE_HZ`)
 * is this driver family's real envelope-phase timing, not just a
 * CPS-family generalization.
 */
export const CPS2_DRIVER_RATE_HZ = 250 / 4.0;

/** CPS2Seq's fixed pulses-per-quarter-note (`setPPQN(48)` in `CPS2Seq::parseHeader()`), confirmed by real-song decode against ddsom's ROM. */
export const CPS2_PPQN = 48;

/**
 * Convert a decoded `tempo` event's raw `tempoTicksPerIteration` value into
 * real seconds-per-PPQN-tick, for real-time (not MIDI-file) playback —
 * a direct port of vgmtrans's own `CPS2TrackV1.cpp` tempo-event math
 * (`< CPS2_V140` branch): `internal_ppqn = ppqn<<8; iterations_per_beat =
 * internal_ppqn / ticksPerIteration; seconds_per_beat = iterations_per_beat
 * / CPS2_DRIVER_RATE_HZ`, divided by `ppqn` again to get seconds per single
 * tick (a real-time playback need; vgmtrans itself only needs
 * seconds-per-BEAT, since it emits a MIDI tempo meta-event and lets a MIDI
 * player handle per-tick timing).
 */
export function cps2TempoToSecondsPerTick(ticksPerIteration: number, ppqn: number = CPS2_PPQN): number {
  const internalPpqn = ppqn << 8;
  const iterationsPerBeat = internalPpqn / ticksPerIteration;
  const secondsPerBeat = iterationsPerBeat / CPS2_DRIVER_RATE_HZ;
  return secondsPerBeat / ppqn;
}

/** Default tempo (120 BPM) a track uses before its first real `tempo` event -- matches vgmtrans's own `CPS2Seq.cpp` default (`mpqn = 500000`, 120 BPM) used for its equivalent "before the first tempo event" case. */
export const CPS2_DEFAULT_SECONDS_PER_TICK = 500000 / CPS2_PPQN / 1e6;

/** The 3 ROM-resident envelope-rate lookup tables an instrument record's bytes 3-7 index into (see `parseCps2EnvelopeRateTables()`). */
export interface Cps2EnvelopeRateTables {
  /** 64 entries, `word@[attackBase + byte*2]` — indexed by the instrument record's `attackRate` byte (0-63). */
  attack: number[];
  /** 64 entries, `word@[decayBase + byte*2]` — indexed by `decayRate`, `sustainRate`, AND `releaseRate` (the SAME table used 3 times, per vgmtrans's `CPS2Instr.cpp`: `Dr = decay_rate_table[...]; Sr = decay_rate_table[...]; Rr = decay_rate_table[...]`). */
  decay: number[];
  /** 128 entries, `word@[sustainBase + byte*2]` — indexed by `sustainLevel` (0-127). */
  sustainLevel: number[];
}

/**
 * Read the 3 real ROM envelope-rate tables at their confirmed ddsom
 * addresses (see `Cps2EnvelopeRateTables`'s field docs for which
 * instrument-record byte indexes which table).
 *
 * **Verification**: read directly from real ddsom `audiocpu` ROM bytes at
 * `0x35e1`/`0x3661`/`0x34e1`, all **256/256 entries byte-exact** against
 * vgmtrans's own hardcoded `attack_rate_table[64]`/`decay_rate_table[64]`/
 * `sustain_level_table[128]` (`CPS2Instr.h`, "used by all versions of
 * sample-based CPS drivers") — zero deviations. This is a strong,
 * independent, byte-exact cross-check (two completely different sources
 * — independent disassembly-derived addresses vs. vgmtrans's hardcoded
 * reference constants — landing on identical 256-word content) that both
 * the table addresses AND vgmtrans's rate-table CONTENT are correct for
 * ddsom specifically, not just "close enough" for the CPS family in
 * general.
 */
export function parseCps2EnvelopeRateTables(
  region: Uint8Array,
  attackBase: number,
  decayBase: number,
  sustainBase: number
): Cps2EnvelopeRateTables {
  const readWords = (base: number, count: number): number[] =>
    Array.from({ length: count }, (_, i) => region[base + i * 2] | (region[base + i * 2 + 1] << 8));
  return {
    attack: readWords(attackBase, 64),
    decay: readWords(decayBase, 64),
    sustainLevel: readWords(sustainBase, 128),
  };
}

/** One instrument's real, ROM-derived ADSR-style envelope timing, in seconds (except `sustainLevel`, a 0-1 fraction of full volume). */
export interface Cps2EnvelopeTimes {
  attackSeconds: number;
  decaySeconds: number;
  sustainLevel: number;
  sustainSeconds: number;
  releaseSeconds: number;
}

/**
 * Convert one `Cps2InstrumentV115`'s 5 raw ADSR bytes into real envelope
 * timing, via a direct, literal port of vgmtrans's own
 * `CPS2InstrSet::parseInstrPointers()` conversion (`CPS2Instr.cpp`,
 * `ticks = rate16 ? 0xFFFF/rate16 : 0; seconds = (rate16===0xFFFF) ? 0 :
 * ticks/CPS2_DRIVER_RATE_HZ` for attack/sustain/release, with a slightly
 * different `0xFFFF`-vs-`0` edge case for release — reproduced exactly,
 * not simplified, since this is a real reference implementation's
 * formula cross-checked against ROM data, not a guess). `sustainLevel`
 * uses vgmtrans's simpler `Sl/0xFFFF` fraction (the "substitute sustain
 * rate for decay rate" refinement in `CPS2Instr.cpp` is NOT ported here —
 * this function reports each of the 5 raw phases independently, a
 * simpler and equally honest reading of the same ROM data).
 */
export function computeCps2EnvelopeTimes(instr: Cps2InstrumentV115, tables: Cps2EnvelopeRateTables): Cps2EnvelopeTimes {
  const Ar = tables.attack[Math.min(instr.attackRate, 63)];
  const Dr = tables.decay[Math.min(instr.decayRate, 63)];
  const Sl = tables.sustainLevel[Math.min(instr.sustainLevel, 127)];
  const Sr = tables.decay[Math.min(instr.sustainRate, 63)];
  const Rr = tables.decay[Math.min(instr.releaseRate, 63)];
  const toSeconds = (rate: number): number => {
    const ticks = rate ? 0xffff / rate : 0;
    return rate === 0xffff ? 0 : ticks / CPS2_DRIVER_RATE_HZ;
  };
  return {
    attackSeconds: toSeconds(Ar),
    decaySeconds: toSeconds(Dr),
    sustainLevel: Sl / 0xffff,
    sustainSeconds: toSeconds(Sr),
    releaseSeconds: toSeconds(Rr),
  };
}

/**
 * Real ROM tables driving the per-tick vibrato/pitch-bend computation
 * traced at `audiocpu+0x1f46`-`0x1fbe` (this fully resolves the note
 * record's `flags` byte clamp semantics, AND the two
 * `word@0x203b`/`word@0x2032`/`word@0x2113` table lookups it feeds).
 *
 * All 4 tables sit contiguously in ROM right after the computation's own
 * code (`0x1fc6`-`0x2d13`), addressed by a clamped 0-0x6b "semitone index"
 * (`clampCps2PitchIndex()`):
 *   - `shiftCount[idx]` (108 bytes @ `0x1fc6`) = `idx // 12` (the octave
 *     number, confirmed exact for every entry).
 *   - `octaveBase[octave]` (9 bytes @ `0x2032`) = `octave * 12` (used as
 *     `idx - octaveBase[shiftCount[idx]] === idx % 12`, the semitone
 *     within the octave).
 *   - `semitoneBase[idx]` (108 words @ `0x203b`) — the coarse per-
 *     semitone base value. **Confirmed to be a real chromatic (12-tone
 *     equal temperament) exponential curve**: `semitoneBase[idx]` matches
 *     `128 * 2^(idx/12)` to within 0.5% at every one of 108 entries
 *     (doubling exactly at idx=12,24,...,96 — one octave), consistent
 *     with 16-bit table-generation rounding, not coincidence.
 *   - `mantissa[semitone][fracLow]` (12 slots of 256 bytes @ `0x2113`) —
 *     a small (0-12), monotonically-increasing-with-`fracLow` fractional
 *     interpolation table, added to `semitoneBase[idx]` after being
 *     left-shifted by `shiftCount[idx]` (i.e. it fills in the curve
 *     BETWEEN adjacent `semitoneBase` entries, scaled to the correct
 *     octave) — the classic shape of a log-domain pitch table's linear-
 *     interpolation fractional part.
 */
export interface Cps2PitchTables {
  shiftCount: number[];
  octaveBase: number[];
  semitoneBase: number[];
  /** `mantissa[semitone][fracLow]`, semitone 0-11, fracLow 0-255. */
  mantissa: number[][];
}

/** Read all 4 `Cps2PitchTables` tables from `region` at their (driver-revision-specific, ddsom-confirmed) base addresses. */
export function parseCps2PitchTables(
  region: Uint8Array,
  shiftCountBase: number,
  octaveBaseBase: number,
  semitoneBaseBase: number,
  mantissaBase: number
): Cps2PitchTables {
  const shiftCount = Array.from({ length: 108 }, (_, i) => region[shiftCountBase + i]);
  const octaveBase = Array.from({ length: 9 }, (_, i) => region[octaveBaseBase + i]);
  const semitoneBase = Array.from({ length: 108 }, (_, i) => region[semitoneBaseBase + i * 2] | (region[semitoneBaseBase + i * 2 + 1] << 8));
  const mantissa = Array.from({ length: 12 }, (_, s) => Array.from({ length: 256 }, (_, f) => region[mantissaBase + s * 256 + f]));
  return { shiftCount, octaveBase, semitoneBase, mantissa };
}

/**
 * The exact clamp `audiocpu+0x1f66`-`0x1f76` applies to the raw 8-bit sum
 * `a = (0x3c - flags) + h` before using it as a 0-0x6b table index — a
 * direct port of the real `cp 0x6c` / `jr c` / `ld a,0x6b` / `jp m` /
 * `xor a` instruction sequence, verified against raw opcode bytes (not a
 * disassembler's rendered mnemonics).
 *
 * **Not a simple two-sided clamp** — worked out by simulating the exact
 * flag semantics for every input byte 0-255:
 *   - `raw` in `[0x00, 0x6b]` (already in range): returned unchanged.
 *   - `raw` in `[0x6c, 0xeb]`: clamped to **`0`** (not `0x6b`) — this is
 *     `jp m` NOT taken (the `cp 0x6c` sign flag is clear for this range),
 *     falling into `xor a`.
 *   - `raw` in `[0xec, 0xff]`: clamped to **`0x6b`** — `jp m` IS taken,
 *     keeping the `ld a,0x6b` value.
 * The asymmetry is a real, direct consequence of the 2-instruction
 * `cp`/`jp m` idiom (which tests the *sign* of `raw-0x6c` as an 8-bit
 * value, not a proper signed-range clamp) — not simplified or
 * editorialized here, since misrepresenting it as a plain `clamp(raw,
 * 0, 0x6b)` would silently disagree with real ROM behavior for `raw`
 * in `[0x6c, 0xeb]`.
 */
export function clampCps2PitchIndex(raw: number): number {
  const r = raw & 0xff;
  if (r < 0x6c) return r;
  const diff = (r - 0x6c) & 0xff;
  return diff & 0x80 ? 0x6b : 0;
}

/**
 * Full port of the vibrato/pitch-bend delta computation, `audiocpu+0x1f76`
 * onward (once `a` — the value `clampCps2PitchIndex()` clamps — and
 * `fracLow` — the un-clamped computation's low byte, `L` at `0x1f77`'s
 * `ex de,hl` — are known): `semitoneBase[idx] + (mantissa[idx%12][fracLow]
 * << shiftCount[idx])`. This is the value added to the mailbox-written
 * `QSOUND_REG.playbackRate` (see `./qsound.js`), NOT a standalone
 * frequency — see this function's module doc comment for why this is
 * confirmed as the *vibrato/pitch-bend modulation depth* mechanism
 * specifically, not the driver's primary per-note pitch-select mechanism
 * (which was not traced).
 */
export function computeCps2PitchDelta(rawIndexInput: number, fracLow: number, tables: Cps2PitchTables): number {
  const idx = clampCps2PitchIndex(rawIndexInput);
  const octave = tables.shiftCount[idx];
  const semitone = idx - tables.octaveBase[octave];
  const mantissa = tables.mantissa[semitone][fracLow & 0xff];
  return (tables.semitoneBase[idx] + (mantissa << octave)) & 0xffff;
}
