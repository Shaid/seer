# @seer/smus

SMUS (Simple Musical Score) interpreter and Sonix audio engine.

A complete reference implementation of the EA IFF 85 SMUS music format
plus the Sonix synthesis/sample playback engine used by Melbourne House
on Amiga, DOS, and Apple IIGS. Parses SMUS files, `.instr` instrument
definitions, `.ss` sample files, and renders scores to stereo PCM audio
in real time.

## Installation

```bash
npm install @seer/smus
```

Depends on `@seer/core` and `@seer/iff`.

## Modules

### `smus.ts` — SMUS parser

Parses IFF FORM SMUS files into structured song data.

```ts
import { parseSMUS } from '@seer/smus';

const song = parseSMUS(buffer);
if (song) {
  console.log(song.header.tempo);    // 128ths of quarter note per minute
  console.log(song.tracks.length);   // number of tracks
  console.log(song.instruments);     // instrument references
}
```

**Parsed types:**

| Type | Description |
| --- | --- |
| `SSong` | Top-level: header, name, instruments, tracks |
| `SScoreHeader` | Tempo, volume, track count |
| `SInstrumentRef` | Register, type, name |
| `SEventStream` | Array of `SEvent` |
| `SEvent` | Generic event (`sID` + `data`) |
| `SNote` | Note event with chord, tie, tuplet, dot, division, tone |

**Event types:**

| Constant | Value | Description |
| --- | --- | --- |
| `SID_FirstNote` – `SID_LastNote` | 0–127 | MIDI pitch |
| `SID_Rest` | 128 | Rest |
| `SID_Instrument` | 129 | Instrument change |
| `SID_TimeSig` | 130 | Time signature |
| `SID_KeySig` | 131 | Key signature |
| `SID_Dynamic` | 132 | Dynamic |
| `SID_Tempo` | 136 | Tempo change |

**Helpers:**

| Function | Description |
| --- | --- |
| `durationName(data)` | Human-readable duration (e.g. "dotted triplet quarter") |
| `eventDuration(data)` | Duration in quarter-note units |
| `tempoToBPM(tempo)` | Convert 128ths-of-QPM to BPM |

### `sampled-sound.ts` — `.instr` and `.ss` parser

Parses three `.instr` variants and `.ss` multi-octave sample files:

- **External (SampledSound)**: 128-byte header pointing to a `.ss` file
- **Embedded (synth)**: 502-byte self-contained synthesis instrument
  with waveshaper, filter, and envelope data
- **8SVX**: IFF FORM 8SVX sampled instrument

### `smus-engine.ts` — Sonix synthesis engine

`SmusEngine` renders SMUS scores to stereo PCM audio. Features:

- 4-voice polyphonic engine
- Multi-segment envelope generator (ADSR-style)
- Sonix filter bank synthesis
- LFO modulation and vibrato
- Sampled sound playback with looping
- Chord support
- Multi-octave `.ss` sample playback

```ts
import {
  SmusEngine,
  parseSmusScore,
  parseInstr,
  instrumentFromSynth,
  defaultInstrument,
  type Instrument,
} from '@seer/smus';

const score = parseSmusScore(smusFileBuffer);

// Build the register -> Instrument map the score's INS1 chunks reference.
// (Load each referenced .instr file's bytes and parse via parseInstr(),
// then convert with instrumentFromSynth/instrumentFromSampled/instrumentFrom8svx
// depending on parseInstr's returned variant — see sampled-sound.ts.)
const instruments = new Map<number, Instrument>();
instruments.set(0, defaultInstrument());

const engine = new SmusEngine(score, instruments, 44100, 0.35);
const [left, right] = engine.renderAll(); // stereo Float32Array, [-1, 1]
```

`SmusEngine`'s constructor is `(score, instruments, sampleRate = 44100,
masterVolume = 0.35)`. `renderAll(maxSeconds = 300)` runs the full score to
completion (trimming trailing silence) and returns `[left, right]`;
`renderBlock(n)` renders exactly `n` samples per call, for streaming/
real-time playback instead of an offline render.

## Testing

```bash
npm test
npm run lint
```
