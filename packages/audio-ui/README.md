# @seer-project/audio-ui

Shared bottom-docked audio-bar UI chrome for the viewer tool.

This package unifies the **UI layer only** — the play/pause button, seek
slider, time readout, optional stop button, optional volume slider, and the
docking/hide-show behavior that flower, wyrm, and middilgard each
independently hand-rolled around three genuinely different playback
engines (a native `<audio>` element decoding a pre-existing file; a live
FLT4 tracker synth; a live SMUS/Sonix synth). It does **not** attempt to
unify those engines — decoding a file and synthesizing one from tracker/
score data are different problems. See `docs/audio-playback.md` in the seer
repo for the full design writeup and per-project migration evidence.

## Installation

```bash
npm install @seer-project/audio-ui
```

Depends on `@seer-project/core` (for the `PlaybackEngine`/`PlaybackState` contract
and `formatClock`).

## `AudioBarController` — the generic transport chrome

Construct once, against a fixed set of DOM elements (matching flower's
`#audio-bar` shape — the reference this was extracted from):

```ts
import { AudioBarController } from '@seer-project/audio-ui';

const audioBar = new AudioBarController({
  bar: document.getElementById('audio-bar')!,
  toggleBtn: document.getElementById('audio-toggle') as HTMLButtonElement,
  seekInput: document.getElementById('audio-seek') as HTMLInputElement,
  timeLabel: document.getElementById('audio-time')!,
  // Optional — only rendered for an engine that implements the matching method:
  stopBtn: document.getElementById('audio-stop') as HTMLButtonElement,
  volumeInput: document.getElementById('audio-volume') as HTMLInputElement,
});
```

Then, on every asset selection:

```ts
const engine = new NativeAudioEngine();
engine.load(`${ASSET_BASE}/${asset.audio}`, { title: asset.name, detail: asset.audioCodec });
audioBar.attach(engine, { autoplay: true });
```

And on deselection / switching to a non-audio asset:

```ts
audioBar.detach(); // disposes the engine and hides the bar
```

`attach()` always disposes whatever engine was attached before it — you
never need to call `detach()` between two audio selections, only when
leaving audio entirely (matches every real project's pre-existing
"switching asset stops the old one" behavior).

### Why `stop`/`seek`/`setVolume` are optional on the engine, not the UI

A live-synthesized tracker module (wyrm) has no fixed wall-clock timeline
to seek within — mid-song tempo effects aren't simulated ahead of time, so
"duration" isn't knowable without playing the whole thing. Rather than
faking a seek slider that can't do anything, `PlaybackEngine.seek` and
`getState().seekable` are both optional/boolean: when `seekable` is false,
`AudioBarController` hides the slider and shows `state.detail` (e.g.
`"Order 3/12 · Row 24"`) where the time readout would go. The same pattern
covers `stop` (wyrm's tracker engine can restart from position zero
independently of pause — most engines don't need this distinct from
`pause()`) and `setVolume` (only rendered for an engine that implements it).

## `NativeAudioEngine` — the pre-decoded-file case

A `PlaybackEngine` wrapping a plain `<audio>` element — this is flower's
original `#audio-player`/`drawAudioAsset` logic, extracted into a reusable,
format-agnostic class. Use it for any asset that's a real, directly
playable web audio file (mp3, wav, ogg…).

```ts
import { NativeAudioEngine } from '@seer-project/audio-ui';

// Reuse a static element (flower's approach — avoids a fresh decoder per
// selection), or omit `element` to have one created for you (hunter's case,
// which has no static <audio> element in its index.html).
const engine = new NativeAudioEngine({ element: document.getElementById('audio-player') as HTMLAudioElement });

engine.load('/assets/mygame/ps3/audio/theme.mp3', { title: 'Main Theme', autoplay: true });
```

Not suitable for a format that must be *synthesized* rather than decoded
(Amiga FLT4 tracker modules, SMUS scores) — see `@seer-project/tracker` and
`@seer-project/smus` for those, and wrap them in your own small `PlaybackEngine`
adapter (a few dozen lines — see wyrm's `TrackerPlaybackEngine` and
middilgard's `SmusPlaybackEngine` for worked examples).

## Testing

```bash
npm test
npm run lint
```

Both classes are tested against hand-built fakes rather than a real browser
media stack: `AudioBarController` against a scriptable fake `PlaybackEngine`
(jsdom exercises the real DOM wiring — classList, addEventListener, input
events), and `NativeAudioEngine` against a minimal `EventTarget`-based fake
`<audio>` element, since jsdom's own `<audio>` implements the DOM shape but
deliberately not media playback (`play()`/`pause()` throw "not
implemented"). No project's real game data is needed or used — this package
has no game-specific logic at all.
