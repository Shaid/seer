# @seer-project/smus

SMUS (Simple Musical Score) interpreter and Sonix audio engine.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

A complete reference implementation of the EA IFF 85 SMUS music format
plus the Sonix synthesis/sample playback engine used by Melbourne House
on Amiga, DOS, and Apple IIGS. Parses SMUS files, `.instr` instrument
definitions, `.ss` sample files, and renders scores to stereo PCM audio
in real time.

## Installation

```bash
npm install @seer-project/smus
```

Depends on `@seer-project/core` and `@seer-project/iff`.

## Modules

### `smus.ts` — SMUS parser

Parses IFF FORM SMUS files into structured song data.

```ts
import { parseSMUS } from '@seer-project/smus';

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
} from '@seer-project/smus';

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

## Licensing & Commercial Use

Seer exists to reverse-engineer other people's work, and that is only possible
because the preservation and romhacking communities published what they found
instead of keeping it. The licence is chosen so that keeps happening: build on
Seer and your work stays open too, so the next person gets the same head start.

- **[AGPL-3.0-or-later](https://github.com/Shaid/seer/blob/main/LICENSE)** —
  free for personal, educational and open-source use. Note that the AGPL extends
  copyleft to **network use**: run a public web app or hosted service on this
  and you must publish your application's source under the AGPL.
- **Commercial licence** — waives that requirement so a proprietary or
  closed-source product can keep its codebase private. Flat-fee and subscription
  terms are available, and custom terms are negotiable.

If the copyleft doesn't fit what you're building, we would much rather have the
conversation than have you walk away — email
[dr.shaid@gmail.com](mailto:dr.shaid@gmail.com) with the subject
`[Commercial License Request - Project Name]`.

Full details: <https://seer.shaid.net/start-here/licensing/>.
