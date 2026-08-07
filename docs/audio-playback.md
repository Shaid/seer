# Audio Playback: Shared UI, Pluggable Engines

How the viewer's bottom-docked music/audio transport bar was unified across
flower, wyrm, and middilgard — and extended to hunter, which had a real,
unaddressed gap — via `@seer-project/core`'s `PlaybackEngine` contract and
`@seer-project/audio-ui`'s `AudioBarController`/`NativeAudioEngine`.

Companion docs: [`viewer.md`](viewer.md) (the sibling "how the scaffold's
asset viewer works" doc this one follows the same style as — data-driven
selectors, autoplay, the indexed-texture shader), `../game-re-tooling/
seer-upstream.md` (the general "when/how to upstream reusable tooling"
guidance this migration followed).

---

## The problem

By mid-2026, four sibling seer-family projects had music/audio in some
form, and each had solved the UI chrome around it independently:

| Project | Playback engine | UI | Manifest shape |
|---|---|---|---|
| flower (Drakengard 3, PS3) | Native `<audio>` decoding a pre-existing `.mp3`/`.wav` | `#audio-bar`: play/pause, seek, time readout | `type: "audio"` rows in the normal manifest |
| wyrm (Dune/KGB, Amiga) | Live FLT4 tracker synthesis (`MusicPlayer`, Web Audio `AudioBufferSourceNode`s scheduled by a tick timer) | `#music-panel`: play, stop, region select, volume | `isMusic`/`musicTitle` fields in the normal manifest |
| middilgard (WIME/Excalibur/Conan, Amiga) | Live SMUS/Sonix synthesis (`@seer-project/smus`'s `SmusEngine`, whole-score offline render to one `AudioBuffer`) | `#music-strip`: single play/pause toggle, volume | A **separate** `music-manifest.json`, fetched outside the normal asset manifest |
| hunter (Carrier Command, Amiga) | — | **none** | One real `type: "audio"` entry (`disk2-music`), zero playback code |

Three genuinely different hand-rolled panels, one genuine gap. flower's
`#audio-bar` (`tools/viewer/viewer.ts`/`index.html`/`viewer.css` —
see `flower/docs/drakengard3/ps3/data-structure.md` §14) was the newest and
most complete, and became the reference the shared chrome was extracted
from.

## The scope decision: unify the UI, not the engines

Flower's native-`<audio>`-plays-a-pre-decoded-file case and wyrm's/
middilgard's live-synthesis cases are different problems — nothing
browser-native can play FLT4 or SMUS directly, that requires real synthesis
code (`@seer-project/tracker`, `@seer-project/smus`). Trying to unify the engines would mean
either forcing flower's simple case through a synthesis-shaped API for no
reason, or forcing wyrm/middilgard's stateful synthesis through a
decoded-file-shaped API that can't represent "no fixed duration" or "this
track is still being decoded." Neither is worth it.

What *is* shared across all three real implementations, byte-for-byte
identical in spirit: a play/pause button, a status readout, a docked
bottom-bar convention matching `#frame-strip`/`#mesh-anim-bar`, and
show/hide-on-selection wiring. That's the actual unification target.

## The contract: `PlaybackEngine` (`@seer-project/core`)

```ts
type PlaybackState = {
  isPlaying: boolean;
  currentTime: number;
  title: string;
  detail?: string;
  volume?: number;
} & (
  | { seekable: true; duration: number }
  | { seekable: false; duration: null }
);

export interface PlaybackEngine {
  play(): void | Promise<void>;
  pause?(): void;
  stop?(): void;
  seek?(seconds: number): void;
  setVolume?(volume: number): void;
  getState(): PlaybackState;
  onStateChange(cb: (state: PlaybackState) => void): () => void;
  dispose(): void;
}
```

Only `play`, `getState`, `onStateChange`, and `dispose` are required.
`pause`/`stop`/`seek`/`setVolume` are optional — the shared UI renders a
control for each only when both the DOM element was supplied **and** the
attached engine actually implements the matching method. This was derived
by reading all three real implementations' actual needs (see
`AudioBarElements`'s doc comment in `packages/audio-ui/src/audio-bar.ts`)
rather than guessing a shape up front, per the method every game-RE pass in
this family already follows for reverse-engineered formats — same rigor,
applied to a contract design instead of a byte layout.

`seekable` discriminates `PlaybackState`, so `duration` cannot contradict
it: a seekable state always carries a number, a non-seekable one always
`null`. Every engine here already derived both from one "do we know the
length?" test, but nothing enforced it — an engine reporting
`seekable: true, duration: null` compiled fine and then divided by null in
the shared UI. Consumers now narrow on `state.seekable` and get
`duration: number` without a null check.

`pause` became optional later than the rest, when `@seer-project/tracker`'s
player was measured against this contract: `TrackerPlayer` has only
`play()`/`stop()`, because stopping tears its worklet down and leaves no
paused state to resume from. Requiring `pause` would have forced its
adapter to fake one with a full stop — silently breaking the
resume-where-you-left-off semantics the bar implies — so the contract
admits the gap instead and the bar degrades: the toggle prefers `pause()`
and falls back to `stop()`. Implement at least one, or the bar cannot halt
playback at all.

`load(...)` is deliberately **not** part of the interface. Every engine
needs wildly different load parameters — a URL (flower), a song id + asset
base + compression format (wyrm), a manifest entry + two data directories
(middilgard) — so standardizing it would mean either a lowest-common-
denominator `unknown` parameter (defeats the point of an interface) or
forcing every engine into one shape it doesn't fit. Each concrete engine
keeps its own `load()`/`select()` method; the *viewer's own project-specific
code* calls that, then hands the resulting object — typed as
`PlaybackEngine` — to the shared UI.

### Why `seek`/`stop` are optional, not universal

This was the one genuinely hard design tradeoff (flagged as a likely one
before writing any code, then confirmed once wyrm's and middilgard's real
engines were actually read):

- **wyrm's tracker engine never implements `seek`.** A live FLT4 module has
  no fixed wall-clock duration — this player's tick loop doesn't simulate
  tempo-changing effects ahead of time, so "how long is this song" isn't
  knowable without playing the whole thing. `getState().seekable` is always
  `false`; the shared bar hides the seek slider entirely and shows
  `state.detail` (`"Ord 3/12 · Row 24 · PAL"`) where a time readout would go
  — exactly what wyrm's `#music-info` already displayed pre-migration.
- **middilgard's SMUS engine could seek, but deliberately doesn't.**
  `SmusEngine.renderAll()` renders the *whole* score to one `AudioBuffer`
  up front, so an exact duration is known and `AudioBufferSourceNode.start(0,
  offset)` would make seeking technically straightforward. It's still not
  implemented — adding it would be a **new feature**, not something the
  pre-migration `MusicPlayer` had, and this migration is scoped as a
  behavior-preserving refactor. Tracked here as a legitimate future
  enhancement, not a limitation of the design.
- **wyrm's tracker engine implements `stop()` as something distinct from
  `pause()`** — pause keeps the current order/row so the next `play()`
  resumes; stop resets to the start. flower's and middilgard's engines
  don't implement `stop()` at all, because their `pause()` already fully
  tears down/resets (middilgard's SMUS `pause()` *is* a full stop — the
  original `MusicPlayer` never supported true pause-and-resume for a
  rendered score either). The shared bar shows a Stop button only for the
  engine that actually has one.

None of this needed a change to the *interface* once wyrm and middilgard
were actually read — `stop?`/`seek?` being optional from the start absorbed
both real cases without modification. The one interface change that *did*
come from reading the real code: `seekInput` in `AudioBarElements` had to
become optional too, once it turned out wyrm's `#music-panel` never had a
seek slider in its markup at all (there was never anything to hide/show).

A later review found the slider's visibility was keyed **only** on
`state.seekable`, not on the engine actually implementing `seek()`. Since
`seek` is optional, an engine that knows its duration but can't act on a
seek request rendered a fully visible slider whose drag handler silently
did nothing and whose thumb snapped back on the next state update. It now
gates on both, like `stopBtn` and `volumeInput` always did. The slider's
scale is likewise read from its own `min`/`max` rather than assuming the
`0..1000` the real projects happen to use — markup with HTML's default
`0..100` range used to seek to a tenth of the intended position.

## `AudioBarController` (`@seer-project/audio-ui`)

The DOM-wiring counterpart — constructed once against a fixed set of
elements, `attach(engine)`/`detach()` called on every selection change:

```ts
const audioBar = new AudioBarController({
  bar: document.getElementById('audio-bar')!,
  toggleBtn: document.getElementById('audio-toggle') as HTMLButtonElement,
  timeLabel: document.getElementById('audio-time')!,
  seekInput: document.getElementById('audio-seek') as HTMLInputElement,  // optional
  stopBtn: document.getElementById('audio-stop') as HTMLButtonElement,   // optional
  volumeInput: document.getElementById('audio-volume') as HTMLInputElement, // optional
});

audioBar.attach(engine, { autoplay: true }); // on selection
audioBar.detach();                            // on deselection / switching away
```

`attach()` disposes whatever *different* engine was attached before it.
`detach()` stops playback and hides the bar but deliberately does **not**
dispose — see below.

### Re-attaching the same engine is a refresh, not a teardown

This was a real bug trap discovered while migrating wyrm, not designed in
up front. flower and hunter create a **new** `NativeAudioEngine` per track
selection (cheap, matches the original per-asset model), so `attach()`
disposing whatever was attached before is exactly right. wyrm and
middilgard instead wrap **one long-lived engine instance** around one
persistent `MusicPlayer`/decode-pipeline across every track selection — the
underlying player itself already tracks "which song is loaded," and
disposing it on every reselect would stop an already-playing track just
from clicking it again in the sidebar (wyrm), or force a needless
full-context teardown (middilgard).

`attach()` special-cases this: passing the *same* engine reference it
already has attached is a no-op on the engine itself (no dispose, no
re-subscribe) — just a state re-render and an optional `play()`. This is
what makes `TrackerPlaybackEngine`/`SmusPlaybackEngine` safe to construct
once, store in a module-level `const`, and hand to `attach()` on every
selection without the caller needing its own "is this the same track"
guard at the UI layer (the underlying `MusicPlayer`/`select()` calls still
have their own guards for whether to actually reload/re-decode — see
below).

### `detach()` stops, it does not dispose

The same reasoning applies to `detach()`, but it was missed at first and a
later review caught it. `detach()` used to dispose the engine, which is
fine for flower's and hunter's per-track engines but wrong for the very
pattern this document recommends two paragraphs up: construct once, store
in a module-level `const`, attach on every selection. The sequence
`attach(E)` → `detach()` → `attach(E)` — an entirely ordinary
audio → non-audio → audio browse — left the bar re-subscribed to a
*disposed* engine. It rendered once and then froze: the play/pause glyph
stuck, the time never advancing, and no error anywhere.

`detach()` now stops the engine (`stop()` when it has one, else `pause()`)
and unsubscribes, but parks the instance rather than disposing it, so
re-attaching resurrects it. The parked engine is disposed as soon as a
*different* engine is attached, or when the controller itself is disposed
— which is what stops the create-an-engine-per-track callers leaking one
engine per switch away from audio.

### Disposing a superseded engine must not clobber a shared element

`NativeAudioEngine` optionally wraps a caller-supplied `<audio>` element,
which flower does: one static element reused across every track, with a
fresh engine per selection. That combination hid a second lifecycle bug,
found in the same review.

The documented order is `new NativeAudioEngine({ element })` →
`engine.load(url, { autoplay: true })` → `audioBar.attach(engine)`. On the
second and every later selection, `attach()`'s first act is to dispose the
*previous* engine — whose `dispose()` ran `pause()`, `removeAttribute('src')`
and `load()` against the very element the new engine had already loaded and
started. The freshly selected track was silently stopped and its source
wiped, on every switch, for the shared-element case only.

Engines now claim the element on construction, and `dispose()` skips the
element teardown unless the disposing engine is still the claimant. Its own
listener unbinding always runs, so a superseded engine still releases its
subscriptions rather than leaking them.

### List-item music indicators, manifest field naming

The task considered unifying `type`/`audio`/`audioCategory` field naming
across all four manifests. It's only partially done, deliberately:

- flower and hunter already independently converged on
  `type: "audio"` / `audio: <path>` / `audioCategory` — no change needed,
  they already agree.
- wyrm's `isMusic`/`musicTitle` fields are **not** renamed. Full
  convergence would mean touching wyrm's asset-pipeline *producer* code
  (`tools/dune/build-assets.ts` et al.), which is out of scope for a
  UI-layer-only migration — the risk (breaking a working extraction
  pipeline) isn't worth the naming consistency win. wyrm's `viewer.ts`
  simply maps its own fields onto the generic concepts locally, at the
  point it builds the engine adapter.
- middilgard's music entries come from an **entirely separate manifest
  file** (`music-manifest.json`, fetched via `viewerConfig.musicManifest`),
  not the same `ManifestEntry` union the other three share at all — a
  structural difference, not just a naming one. Reconciling this would be
  a genuinely different, larger project (folding a second manifest format
  into the primary one) that this migration didn't attempt.

## `NativeAudioEngine` (`@seer-project/audio-ui`)

flower's original `#audio-player`/`drawAudioAsset` logic, extracted
verbatim into a reusable class wrapping a plain `<audio>` element:

```ts
const engine = new NativeAudioEngine({ element: audioPlayerEl }); // reuse a static element (flower's approach)
engine.load(`${ASSET_BASE}/${asset.audio}`, { title: asset.name, autoplay: true });
audioBar.attach(engine);
```

Omitting `element` creates a fresh, unattached `Audio()` — used by hunter,
whose `index.html` had no static `<audio>` element at all before this
migration.

## Engine adapters: wrapping, not reimplementing

Each project's real synthesis engine is untouched. A small adapter class
implements `PlaybackEngine` by forwarding to it:

- **wyrm**: `tools/viewer/tracker-playback-engine.ts`'s `TrackerPlaybackEngine`
  wraps the existing `MusicPlayer` (FLT4 parsing + Web Audio scheduling,
  `tools/viewer/music-player.ts` — unmodified). `onStateChange` forwards to
  `MusicPlayer.setOnUpdate` (a single-callback slot, not a subscriber list —
  fine here since exactly one engine is ever attached at a time).
- **middilgard**: `tools/viewer/components/smus-playback-engine.ts`'s
  `SmusPlaybackEngine` absorbed what used to be the DOM-owning half of
  `MusicPlayer` (`tools/viewer/components/music-player.ts`, **deleted** by
  this migration — it directly grabbed `document.getElementById(...)` and
  wired its own listeners, which is exactly the hand-rolled-panel pattern
  being replaced). The SMUS decode/render/`AudioContext` logic itself is
  copied unchanged; only DOM ownership moved to `AudioBarController`.

### A latent bug fixed as a side effect, not chased separately

Middilgard's original `MusicPlayer.show()` unconditionally reset
`this.playing = false` and the status text to `"Ready"` on **every**
selection of a MUSIC entry — including reselecting an already-*playing*
track, which would have desynced the internal `playing` flag from the real
`AudioBufferSourceNode` state and could have started a second overlapping
render on the next Play click. `SmusPlaybackEngine.select()` does not do
this (it only resets status when not already playing). This wasn't a
deliberate hunt — it fell out naturally from the interface not having a
`show()`-shaped side-effecting method at all, and is noted here rather than
silently absorbed because "no regressions" deserves an explicit accounting
of the one place behavior intentionally changed.

## hunter: closing a real gap

hunter had one genuine `type: "audio"` manifest entry
(`disk2-music`, Carrier Command's `disk.2` PCM stream decoded to `.wav` —
see `hunter/docs/explore/CarrierCommand/data-structure.md` "Music Format")
and zero playback code — the manifest shape already matched flower's
convention, but nothing in `tools/viewer/viewer.ts` handled `type: "audio"`
at all. Migration: `#audio-bar` markup/CSS ported verbatim from flower,
`ManifestEntry`'s sprite fields made optional (`type` didn't exist before),
`NativeAudioEngine`/`AudioBarController` wired in exactly like flower.

One additional, unrelated fix was needed to make this reachable at all:
`tools/viewer/index.html`'s `ASSET_BASE` was hardcoded to
`/assets/hunter/amiga` — the project's own canonical default game
(`src/game-id.ts`), which has no `manifest.json` at all (no 2D sprite
pipeline has been run for it yet). The real `disk2-music` entry lives under
`/assets/carrier-command/amiga/manifest.json`, a sibling game within the
same project. `ASSET_BASE` was repointed there so the audio-bar migration
has real, reachable data to prove itself against — this is a pre-existing,
unrelated inconsistency in hunter's viewer (a single hardcoded game path,
never migrated to the data-driven multi-game selector `viewer.md` §1
describes), not something this migration fully resolves. A proper
game/platform selector for hunter is tracked as a separate follow-up.

## Verification

Each of the four projects was checked with a real headless-Chromium
Playwright session against its own dev server and its own real, already-
extracted asset data (not mocked) — reading `<audio>`/`AudioBufferSourceNode`
state, DOM text, and button/class state after real clicks, drags, and
keyboard events, with `console.error`/`pageerror` capture on every run
(zero errors in all four).

| Project | What was exercised | Result |
|---|---|---|
| flower | Select→autoplay, pause/play toggle, seek-slider drag (0.30s → 64.6s of a 128.8s track, i.e. the requested 50%), switching to a second track (fresh restart, no overlap), switching to a non-audio category (bar hides, `<audio>` src cleared, paused) | All confirmed exact |
| hunter | Select→autoplay on the real `disk2-music` entry (51.2s .wav), pause/play toggle | Previously-open gap closed; confirmed working |
| wyrm | Select does **not** autoplay (matches original), Play starts the tick loop (row count observed advancing 1→11→21 over real wall-clock waits), region select (PAL→NTSC) still functions as a bespoke control, Stop resets to Row 1, replay works, **reselecting the same already-playing track does not restart it** (row kept advancing 5→7 rather than resetting — the `attach()` same-engine-refresh behavior), switching to a sprite asset hides the panel **without stopping playback** (background music continues — a deliberate pre-existing behavior), switching back reflects the still-advancing row count | All confirmed exact, including two subtle background-continuity behaviors that would have been easy to regress |
| middilgard | Select shows the strip without autoplaying, Play triggers real decode+render+start (`"Playing: Aragorn (10.8s, 4 tracks)"`), volume slider + its bespoke `%` label stay in sync, Pause fully stops (by design — matches the original single-button semantics), replay works, the `Space` keyboard shortcut toggles play/pause via the same button `AudioBarController` wired | All confirmed exact |

## Package placement

- `@seer-project/core`'s `playback.ts`: the `PlaybackEngine`/`PlaybackState` types
  and `formatClock()` — pure, zero-DOM, matching `@seer-project/core`'s existing
  "generic binary/data utilities, no DOM" invariant (the same reason
  PixiJS-rendering helpers live in `@seer-project/engine-2d/pixi-helpers` instead of
  here).
- **New package `@seer-project/audio-ui`**: `AudioBarController` (DOM wiring) and
  `NativeAudioEngine` (the one concrete, format-agnostic engine every
  project can use as-is). DOM-touching code doesn't belong in `@seer-project/core`
  by that same existing invariant, and there wasn't an existing package for
  "viewer UI chrome that isn't just types" to extend — see
  `../../game-re-tooling/seer-upstream.md`'s package-placement table ("new
  package" for something with its own genuinely separate concern).
  Tested against hand-built fakes (a scriptable fake `PlaybackEngine` run
  through real jsdom DOM elements for `AudioBarController`; a minimal
  `EventTarget`-based fake `<audio>` element for `NativeAudioEngine`, since
  jsdom implements the DOM shape of `<audio>` but not its media playback) —
  no project's real game data needed, this package has no game-specific
  logic at all.

`@seer-project/tracker` and `@seer-project/smus` — the two real synthesis engines — are
unchanged by this migration. Both existed before it; this work only added
the adapter layer between them and the shared UI.
