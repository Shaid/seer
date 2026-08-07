# @seer-project/tracker

Custom 4-channel Paula sample-based tracker module parser and player — the
Dune Amiga audio engine. Reads ProTracker-compatible MOD modules and
synthesizes them in real time; no `.wav`/`.mp3` decoding involved.

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
(`play()`/`pause()`/`stop()`/`getState()`/`onStateChange()`/`dispose()`) —
see `docs/audio-playback.md` in the seer repo for a worked example.

## Testing

```bash
npm test
npm run lint
```
