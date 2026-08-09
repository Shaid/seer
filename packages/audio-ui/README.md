# @seer-project/audio-ui

Shared bottom-docked audio-bar UI chrome for the viewer tool.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

This package unifies the **UI layer only** — the play/pause button, seek
slider, time readout, optional stop button, optional volume slider, and the
docking/hide-show behavior that flower, wyrm, and middilgard each
independently hand-rolled around three genuinely different playback
engines (a native `<audio>` element decoding a pre-existing file; a live
FLT4 tracker synth; a live SMUS/Sonix synth). It does **not** attempt to
unify those engines — decoding a file and synthesizing one from tracker/
score data are different problems. See [`docs/audio-playback.md`](https://seer.shaid.net/guides/audio-playback/) in the seer
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

The seek slider's scale is read from its own `min`/`max`, so any range
works — the real projects use `0..1000` for sub-second resolution on long
tracks, and HTML's default `0..100` behaves identically. The volume slider
is a fixed `0..100`, mapped to the engine's `0..1`.

Then, on every asset selection:

```ts
const engine = new NativeAudioEngine();
engine.load(`${ASSET_BASE}/${asset.audio}`, { title: asset.name, detail: asset.audioCodec });
audioBar.attach(engine, { autoplay: true });
```

And on deselection / switching to a non-audio asset:

```ts
audioBar.detach(); // stops playback and hides the bar
```

`attach()` always disposes whatever *different* engine was attached before
it — you never need to call `detach()` between two audio selections, only
when leaving audio entirely (matches every real project's pre-existing
"switching asset stops the old one" behavior).

`detach()` stops the engine but deliberately does **not** dispose it, so an
engine you construct once and reuse across selections (wyrm's and
middilgard's are stored in a module-level `const`) can be handed back to
`attach()` later and still work. The parked engine is disposed as soon as a
different engine is attached, or when the controller itself is disposed —
so a create-an-engine-per-track caller doesn't leak one per switch away
from audio either.

### Why `pause`/`stop`/`seek`/`setVolume` are optional on the engine, not the UI

A live-synthesized tracker module (wyrm) has no fixed wall-clock timeline
to seek within — mid-song tempo effects aren't simulated ahead of time, so
"duration" isn't knowable without playing the whole thing. Rather than
faking a seek slider that can't do anything, `PlaybackEngine.seek` is
optional and `getState().seekable` reports whether seeking means anything
right now: when it's false, `AudioBarController` hides the slider and shows
`state.detail` (e.g. `"Order 3/12 · Row 24"`) where the time readout would
go. The slider is shown only when the engine implements `seek()` *and*
reports `seekable` — an engine that knows its duration but can't act on a
seek gets no slider rather than a dead one.

The same pattern covers `setVolume` (only rendered for an engine that
implements it), `stop` (wyrm's tracker engine can restart from position
zero independently of pause), and `pause` itself: `@seer-project/tracker`'s
player has only `play()`/`stop()`, because stopping tears its worklet down
and leaves no paused state to resume from. Requiring `pause` would force
that adapter to fake one with a full stop, silently breaking the
resume-where-you-left-off semantics the bar implies — so the bar degrades
instead. The play/pause toggle prefers `pause()` and falls back to
`stop()`; implement at least one.

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

When you reuse one static element this way, construct a fresh engine per
selection: each engine claims the element on construction, and `dispose()`
only tears the element down while the disposing engine is still the
claimant. That's what lets `attach()` dispose the *previous* engine after
the new one has already loaded and started the shared element without
killing the track that just began.

`load({ autoplay })` and `attach(engine, { autoplay })` both end up calling
`play()`. Pick whichever layer owns that decision — setting both calls it
twice.

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
