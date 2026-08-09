# @seer-project/tracker

Custom 4-channel Paula sample-based tracker module parser and player — the
Dune Amiga audio engine. Reads ProTracker-compatible MOD modules and
synthesizes them in real time; no `.wav`/`.mp3` decoding involved.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

The core replay (`Module` + `Micromod`) is a TypeScript ESM port of the
classic single-file JavaScript ProTracker Replay engine, wrapped for the
browser with an `AudioWorklet`-based player.

## Installation

```bash
npm install @seer-project/tracker
```

Depends on `@seer-project/core` for shared binary utilities.

## Parsing and synthesis

```ts
import { Module, Micromod } from '@seer-project/tracker';

// Parse a MOD's raw bytes:
const mod = new Module(data); // data: Uint8Array

// Headless synthesis — fill interleaved stereo buffers, no Web Audio needed:
const player = new Micromod(mod, 44100);
const left = new Float32Array(1024);
const right = new Float32Array(1024);
player.getAudio(left, right, 1024); // call repeatedly per audio frame
```

| Export | Description |
| --- | --- |
| `Module` | Parses a ProTracker MOD module from raw bytes |
| `Instrument` | One instrument's sample/loop metadata (type-only export) |
| `Micromod` | Headless 4-channel synthesizer — `getAudio()`, `setSamplingRate()`, `setInterpolation()`, `setSequencePos()`, `finished` |

## `TrackerPlayer` — browser playback via Web Audio

`TrackerPlayer` runs the `Micromod` synth inside an `AudioWorklet`, so the
audio thread never blocks. Everything is created lazily — the `AudioContext`
and worklet module are only constructed on `play()`.

```ts
import { TrackerPlayer } from '@seer-project/tracker';

const player = new TrackerPlayer();
await player.load(rawModuleBytes);
player.volume = 0.5;
await player.play();            // creates/resumes its own AudioContext
player.stop();
```

| Member | Description |
| --- | --- |
| `load(data)` | Parse a MOD module (call before `play()`) |
| `play(ctx?)` | Start playback; optionally reuse an existing `AudioContext` |
| `stop()` | Stop playback and tear down the worklet/gain nodes |
| `volume` | Gain 0..1 (default 0.3) |
| `loaded` / `playing` | Read-only state flags |

## Integration with @seer-project/audio-ui

`TrackerPlayer` is a self-contained player, not a
`PlaybackEngine` from `@seer-project/core`. To drive it from the shared
audio-bar UI, wrap it in a small adapter implementing `PlaybackEngine`
(`play()`/`stop()`/`getState()`/`onStateChange()`/`dispose()`) — see
[`docs/audio-playback.md`](https://seer.shaid.net/guides/audio-playback/) in the seer repo for a worked example.

The adapter needs no `pause()`. `PlaybackEngine.pause` is optional
precisely because of this player: `stop()` tears the worklet down, so
there is no paused state to resume from, and faking pause with a full stop
would silently break the resume semantics the shared bar implies. The bar's
play/pause toggle falls back to `stop()` on its own. `setVolume(v)` maps to
this package's `volume` property in a one-liner.

## Testing

```bash
npm test
npm run lint
```

`Module` and `Micromod` are both pure and synchronous — no Web Audio — so
the parser and the replay/mixing engine are exercised directly under Node
against synthetic MOD files built by `src/__tests__/mod-fixture.ts`
(format tags, sequence decoding, instrument-header edge cases, truncated
sample data; rendering, determinism, panning, seek/rewind). `TrackerPlayer`
itself owns the `AudioContext`/worklet plumbing, so only its load/parse
state and its play/stop guards are covered.

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

This package also contains a TypeScript port of Martin Cameron's Micromod
ProTracker replay engine, used under the BSD 3-Clause licence — see
`THIRD-PARTY-LICENSES.md`, whose copyright notice must be retained in any
redistribution, including under a commercial licence.
