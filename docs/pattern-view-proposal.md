# Pattern sequencer visualiser — proposal

**Status: proposed — not yet implemented.** How a shared pattern/score
visualiser panel gets added to the seer viewer family, reusing the same
"host owns DOM, package owns behaviour" split that `@seer-project/audio-ui`
and `@seer-project/mesh-viewer-ui` already established, and sitting
**alongside** the existing audio bar rather than replacing it.

Companion docs: [`audio-playback.md`](audio-playback.md) (the transport-bar
split this one extends — same rationale style, same verification
discipline), [`render-quality-proposal.md`](render-quality-proposal.md)
(the phase/exit-criterion format this follows).

## Context

Several projects now have working music playback for pattern/score-based
formats — wyrm (ProTracker MOD), middilgard (SMUS/Sonix), ceres (AKAO/
SPC700), valkyrie (a tri-Ace PS1 sequencer) — but none of them can show
*what's playing* beyond a text readout (`"Ord 3/12 · Row 24"`). This
proposal adds a pattern/timeline visualiser panel, with editing scoped as
an explicit future goal that the v1 document model should not foreclose,
but does not itself design.

## Scope

**v1 is view-only**, chosen against two hosts and two data shapes,
deliberately as different from each other as the family gets:

| Host | Format | Data shape | Renderer | Cursor strategy |
|---|---|---|---|---|
| wyrm (Dune/KGB, Amiga) | FLT4 / ProTracker MOD | fixed pattern × row × channel grid | vertical tracker grid | `LiveCursor` over a per-row callback |
| middilgard (WIME/Excalibur/Conan, Amiga) | SMUS / Sonix | variable-duration event stream, no grid | horizontal timeline / piano roll | `ScheduledCursor` over a precomputed schedule vs. wall clock |

The renderer is chosen by **the data's own shape** (a `kind: 'grid' |
'timeline'` discriminant), never by project preference or a user-facing
toggle — MOD's fixed grid and SMUS's continuous event stream are genuinely
different structures, and bending one to look like the other would fake
structure neither format has.

**Explicitly out of scope for v1**, with reasoning in
[Future work](#future-work): ceres/AKAO (confirmed to have no pattern
structure at all — a free-running per-track event stream), valkyrie/VP1
(genuinely pattern-based, but its pattern data isn't exported to the
browser yet), crawl (no MOD implementation exists — dead end), adopting
`@seer-project/tracker`'s micromod engine (position-opaque and its worklet
handoff is likely broken), and editing itself.

## Verified findings this design rests on

Every claim below was re-read and confirmed against installed sources
during planning, not assumed from the format docs.

| Claim | Evidence |
|---|---|
| `PlaybackState.detail?: string` is the only position channel that exists today | `seer/packages/core/src/playback.ts` — `PlaybackStateCommon`; no structured position type anywhere |
| wyrm's player is hand-rolled; `@seer-project/tracker` is declared but unused | `wyrm/package.json` declares it; `grep -rn "seer-project/tracker" wyrm/src wyrm/tools` returns zero hits |
| `MusicPlayer.setOnUpdate` is a single nullable slot | `wyrm/tools/viewer/music-player.ts:141` — `private onUpdate: ((state: MusicState) => void) \| null = null` |
| The single-slot limitation is *itself* the audio bar's only consumer of it | `wyrm/tools/viewer/tracker-playback-engine.ts:47-54` — `TrackerPlaybackEngine.onStateChange` is wyrm's sole caller of `setOnUpdate`; a pattern panel calling it again would silently break the audio bar's position readout, not just share a documented limitation |
| micromod's position fields are all private with no getters | `seer/packages/tracker/src/micromod.ts:262-280` — `private seqPos/row/tick/speed/tempo/channels`; only `get finished()` exists |
| micromod's worklet handoff structured-clones a class instance | `seer/packages/tracker/src/player.ts:100` — `postMessage({ data: { player: this._player } } )`; the prototype does not survive |
| micromod quantizes period → semitone at load, discarding finetune | `micromod.ts:196-206` — `this.patterns[i] = oct * 12 + key` |
| SMUS semantics are decoded only at playback time | `seer/packages/smus/src/smus-engine.ts:508-543` `_consumeEvent`; no intermediate decoded-note type exists |
| **SMUS tempo is score-global, not per-track** | `smus-engine.ts:400-402` `_handleControl` writes `this.bpm`/`this.beatSamples` (engine fields), and `_advanceTracks` (`:545-556`) walks all four tracks per step against that shared value — confirmed by direct read during planning |
| `eventDuration()` (smus.ts:194) and the private `noteDurationBeats()` (smus-engine.ts:49) are bit-for-bit the same formula | Confirmed by direct comparison during planning — both mask `data & 0x07` for division, `& 0x08` for dot, `(data>>4) & 0x03` for tuplet, identical multipliers |
| middilgard renders offline into one looping buffer, reports no position | `middilgard/tools/viewer/components/smus-playback-engine.ts` — `renderAll()` → one `AudioBufferSourceNode`, `loop = true`; `getState()` hardcodes `currentTime: 0, seekable: false` |
| `expandTrackSchedule` is existing precedent for a precomputed schedule | `valkyrie/tools/shared/psx-vp-bgm.ts:630` — `{schedule: {tick, ev}[], endTick, loopStartTick}`; its `ScheduledEvent` type is module-private |
| Reading theme colours off CSS custom properties is established practice | `ceres/tools/viewer/music-view.ts:165` — `getComputedStyle(document.documentElement).getPropertyValue('--accent')` |
| Multi-lane frame-scrubbing precedent | `siren/tools/viewer/viewer.ts:1006-1029` `applySummonSequenceFrame`; data model in `siren/tools/shared/summon-sequence.ts` (frame-indexed `cameras[]/effects[]/audio[]`) |

### Three corrections found during design, not in the original brief

1. **A per-track schedule builder for SMUS would be wrong.** `SID_TEMPO`
   writes to the *engine's* shared `bpm`, not to `TrackState` — a tempo
   change in track 0 moves the wall-clock position of every subsequent note
   in tracks 1-3. `buildSmusTimeline` (§4.1 below) must be a whole-score
   lockstep walk, mirroring `_advanceTracks`, not four independent
   per-track walks.
2. **wyrm's row readout leads the audible row by one.** `MusicPlayer.tick()`
   schedules row N's notes, *then* increments `currentRow`, *then* calls
   `fireUpdate()`. While row 0 is sounding, the display already reads "Row
   2". Invisible as text; would be glaring next to a highlighted grid row.
   Fixed by moving one line — see §5.1(c).
3. **`SmusScore.tracks`'s element type is publicly unnamed.** `smus/index.ts`
   exports two different, differently-cased `SEvent` types from `smus.ts`
   and `smus-engine.ts`; a consumer of `SmusScore.tracks` today has no name
   for its own element type. Fixed as hygiene in Phase 4.

## 1. Package shape

**Two placements**, following the existing `playback.ts`/`audio-ui` split
exactly:

1. **`@seer-project/core` gains `src/pattern.ts`** — the document model,
   the `PatternCursor` interface, both cursor implementations, and the pure
   search/index helpers. Zero DOM, plain-Node testable.
2. **New package `@seer-project/pattern-ui`** — `PatternPanelController`
   plus the two canvas renderers. DOM-touching.

Format adapters live **with their format**: `@seer-project/smus` gains
`src/timeline.ts`; wyrm gains a project-local
`tools/viewer/flt4-pattern-document.ts` (its `Flt4Module` isn't upstreamed).

**Why the model goes in `core`, not the new UI package.** This is a
dependency-direction constraint, not a style preference: `@seer-project/smus`
must be able to *produce* a `PatternTimelineDocument`. If that type lived in
`@seer-project/pattern-ui`, the SMUS synthesis package would have to depend
on a UI package — an inversion the family has never made. `smus` already
depends on `core`; putting the model there keeps every dependency arrow
pointing the same direction it already does, exactly the reasoning
`audio-playback.md` gives for `PlaybackEngine` living in `core` while
`AudioBarController` lives in `audio-ui`. It also satisfies `core`'s
existing "no DOM" invariant — every type here is plain data, every function
pure.

**Why one UI package, not separate cursor/renderer packages.** The cursors
aren't DOM code and belong in `core` regardless, so "split the cursor out"
collapses to "split the two renderers apart" — and both renderers share the
panel controller, DPR/`ResizeObserver` handling, CSS-custom-property theme
resolution, and the rAF loop. Splitting duplicates all four or invents a
third package. The whole point of the shape-driven discriminated union is
that *the host doesn't choose which renderer* — a host picking a package
per renderer has the decision handed back to it. `mesh-viewer-ui` (one
package, one controller, host-authored DOM) is the shape to copy.

**Naming**: `@seer-project/pattern-ui`, matching the `-ui` suffix already
used for viewer-chrome packages (`audio-ui`, `mesh-viewer-ui`) — the suffix
itself signals "chrome you attach to DOM you own."

### Files

```
seer/packages/core/src/pattern.ts                          (new, ~260 lines, zero DOM)
seer/packages/core/src/index.ts                             (modified — re-export)
seer/packages/core/src/__tests__/pattern.test.ts             (new, plain Node)

seer/packages/pattern-ui/                                    (new package)
  package.json / tsconfig*.json / vitest.config.ts           (mirror mesh-viewer-ui / audio-ui exactly)
  LICENSE / README.md
  src/index.ts
  src/pattern-panel.ts        — PatternPanelController
  src/grid-renderer.ts        — vertical tracker grid
  src/timeline-renderer.ts    — horizontal piano roll
  src/theme.ts                — PatternTheme + CSS-custom-property resolution
  src/__tests__/pattern-panel.test.ts

seer/packages/smus/src/timeline.ts                           (new — buildSmusTimeline)
seer/packages/smus/src/index.ts                              (modified — export timeline + SmusEngineEvent)
seer/packages/smus/src/__tests__/timeline.test.ts             (new)
seer/packages/smus/src/__tests__/timeline-drift.test.ts       (new, marked slow)

wyrm/tools/viewer/music-player.ts                            (modified — §5.1)
wyrm/tools/viewer/tracker-playback-engine.ts                  (modified — §5.1)
wyrm/tools/viewer/flt4-pattern-document.ts                    (new)
wyrm/tools/viewer/__tests__/flt4-pattern-document.test.ts     (new)
wyrm/tools/viewer/{index.html,viewer.css,viewer.ts}           (modified — §5.3)

middilgard/tools/viewer/components/smus-playback-engine.ts    (modified — §6.2)
middilgard/tools/viewer/{index.html,viewer.css,viewer.ts}      (modified — §6.4)
```

## 2. Core types (`@seer-project/core/src/pattern.ts`)

### 2.1 The document model

```ts
/** Present because a document is expected to become a *serialized*
 *  artifact for formats (valkyrie/VP1) whose pattern data can't be parsed
 *  in the browser — same reason siren's SummonSequence carries one. */
export type PatternDocumentVersion = 1;

/** One vertical column (tracker channel) or horizontal band (score track). */
export interface PatternLane {
  index: number;           // 0-based, matching the source's own ordering
  label: string;            // "Ch 1", "Track 2", an instrument name
  pan?: number;             // -1..1, undefined when unpanned/unknown
}

/**
 * `raw` is deliberately not derived away: an Amiga period carries finetune
 * information a semitone index does not — exactly what micromod discards
 * at load (micromod.ts:196-206), and the strongest single argument against
 * adopting its `Module` as this model's source. See "Future work".
 */
export interface PatternPitch {
  semitone: number | null;  // for layout; null when raw doesn't map
  raw: number;               // the source's own encoding, losslessly kept
  rawKind: 'amiga-period' | 'midi-key';
}

// ─── Grid-shaped documents (MOD/FLT4, and any fixed pattern × row × channel format)

export interface PatternCell {
  pitch: PatternPitch | null;  // null = empty cell
  instrument: number;           // 1-based; 0 = none
  effect: number;
  param: number;
}

export interface PatternGridPattern {
  rows: PatternCell[][];        // rows[row][lane]; per-pattern row count
}

export interface PatternGridDocument {
  kind: 'grid';
  version: PatternDocumentVersion;
  format: string;                // 'flt4' | 'mk' | 'vp1' | ...
  title: string;
  lanes: PatternLane[];
  patterns: PatternGridPattern[];
  order: number[];                // indices into patterns; already trimmed
                                   // to the song's real length by the adapter
  restartOrder: number | null;    // order index looped back to, or null
}

// ─── Timeline-shaped documents (SMUS, and any variable-duration event stream)

export interface TimelineNote {
  lane: number;
  start: number;       // seconds from song start
  duration: number;    // seconds
  pitch: PatternPitch;
  instrument: number;
  velocity: number;    // 0..1
  chordMember: boolean;
  /** Index of the source event this note decoded from, within its lane's
   *  own source array. Unread in v1 — carried so editing isn't foreclosed. */
  sourceIndex: number;
}

export interface TimelineMarker {
  time: number;
  lane: number | null;  // null = score-wide (tempo)
  kind: 'tempo' | 'dynamic' | 'instrument' | 'time-signature' | 'raw';
  label: string;
  value?: number;
}

export interface PatternTimelineDocument {
  kind: 'timeline';
  version: PatternDocumentVersion;
  format: string;                 // 'smus' | 'akao' | ...
  title: string;
  lanes: PatternLane[];
  notes: TimelineNote[];           // sorted by start, then lane
  markers: TimelineMarker[];
  duration: number;                 // musical end (last note) — NOT the
                                     // rendered buffer's length; see §6.2
  loopStart: number | null;         // SMUS has none — always null there
}

export type PatternDocument = PatternGridDocument | PatternTimelineDocument;

/** Structural validation, mirroring siren's validateSummonSequence — a
 *  list of problems, empty when sound. Cheap enough to run on every
 *  adapter output in dev. */
export function validatePatternDocument(doc: PatternDocument): string[];
```

### 2.2 The cursor abstraction

```ts
export type PatternPosition =
  | { kind: 'grid'; orderIndex: number; pattern: number; row: number; playing: boolean }
  | { kind: 'timeline'; time: number; playing: boolean };

/**
 * The one interface the renderers consume. `LiveCursor` is push-driven (an
 * engine hands it a discrete position once per row); `ScheduledCursor` is
 * pull-driven (a continuous wall clock read against a precomputed
 * schedule). Neither leaks through — `PatternPanelController` polls
 * `position()` on rAF while `playing` is true, so a pull-driven cursor
 * doesn't need its own frame loop and a push-driven one doesn't need to
 * fake continuous updates.
 *
 * `onChange` is coarse and edge-triggered (fires on play/stop or document
 * replacement) — its only contract is waking the panel's rAF loop. An
 * implementation MAY fire it more often; consumers must not depend on
 * either the presence or absence of extra calls.
 */
export interface PatternCursor {
  readonly document: PatternDocument;
  position(): PatternPosition;
  onChange(cb: (position: PatternPosition) => void): () => void;
  dispose(): void;
}

/**
 * `subscribe` MUST support multiple concurrent subscribers — a single
 * nullable callback slot cannot be shared between the audio bar and the
 * pattern panel, which is exactly the limitation
 * `wyrm/tools/viewer/tracker-playback-engine.ts` already has against
 * `MusicPlayer.setOnUpdate` (see "Verified findings" above).
 */
export interface LiveCursorSource<TRaw> {
  subscribe(cb: (raw: TRaw) => void): () => void;
  read(): TRaw;   // for a freshly-attached panel to draw before the next tick
}

export class LiveCursor<TRaw> implements PatternCursor {
  constructor(
    document: PatternDocument,
    source: LiveCursorSource<TRaw>,
    map: (raw: TRaw, document: PatternDocument) => PatternPosition,
  );
  readonly document: PatternDocument;
  position(): PatternPosition;
  onChange(cb: (p: PatternPosition) => void): () => void;
  dispose(): void;   // unsubscribes from source
}

/** Injected rather than reading AudioContext directly, so the whole cursor
 *  is testable with a plain counter. */
export interface ScheduleClock {
  elapsed(): number | null;   // seconds into the current playthrough,
                                // already loop-wrapped; null when stopped
}

export class ScheduledCursor implements PatternCursor {
  constructor(document: PatternTimelineDocument, clock: ScheduleClock);
  readonly document: PatternTimelineDocument;
  position(): PatternPosition;   // { kind:'timeline', time: clock.elapsed() ?? 0, playing: elapsed !== null }
  notify(): void;                 // call when playback starts/stops
  onChange(cb: (p: PatternPosition) => void): () => void;
  dispose(): void;
}
```

### 2.3 "Which notes are sounding at time t" — bounded, not naïve

`ScheduledCursor.position()` is trivial; the real search is one level up.
A plain `findIndex(n => n.start <= t)` is wrong — a long note that started
well before `t` may still be sounding.

```ts
/** Index of the last entry with timeOf(entry) <= t, or -1. Ties resolve
 *  to the LAST match, so a chord's members are all reachable scanning
 *  backward. Entries must be sorted ascending. */
export function findAtOrBefore<T>(
  entries: readonly T[], t: number, timeOf: (entry: T) => number,
): number;

export interface TimelineIndex {
  byLane: TimelineNote[][];   // same objects as document.notes, per lane
  maxDuration: number[];       // longest note per lane — bounds the scan
}
export function buildTimelineIndex(doc: PatternTimelineDocument): TimelineIndex;

/**
 * Every note sounding at t: per lane, binary-search the last note with
 * start <= t, then walk backward while start > t - maxDuration[lane],
 * keeping those with start + duration > t. O(lanes · (log n + k)), k
 * bounded by the lane's longest note, not the song's length.
 * Half-open interval: sounding at exactly `start`, not at `start+duration`.
 * Pass `out` to reuse an array across animation frames.
 */
export function notesAt(index: TimelineIndex, t: number, out?: TimelineNote[]): TimelineNote[];
```

## 3. `@seer-project/pattern-ui`

### 3.1 `PatternPanelController`

```ts
export interface PatternPanelElements {
  panel: HTMLElement;          // shown/hidden via .hidden, host-owned
  canvas: HTMLCanvasElement;
  toggleBtn?: HTMLButtonElement;
  label?: HTMLElement;          // "Ord 3/12 · Row 24" / "0:12 · 4 lanes"
}

export interface PatternPanelOptions {
  theme?: Partial<PatternTheme>;
  gridWindow?: number;              // rows visible either side of playhead, default 16
  timelineWindow?: number | null;   // seconds either side; null = fit whole song
  /** Reserved for editing and for a future seekable host — unwired in v1,
   *  since neither wyrm's nor middilgard's engine implements seek(). */
  onScrub?(position: PatternPosition): void;
}

export class PatternPanelController {
  constructor(elements: PatternPanelElements, options?: PatternPanelOptions);
  attach(cursor: PatternCursor): void;
  refresh(): void;
  detach(): void;
  dispose(): void;
}
```

**Lifecycle contract — matches `audio-ui`'s semantics exactly**, and the
README must say so in the same terms:

- `attach(cursor)` shows the panel, picks the renderer from
  `cursor.document.kind`, rebuilds the static layer, and starts the frame
  loop if `playing`. It disposes whatever *different* cursor was attached
  before — a host never calls `detach()` between two selections, only when
  leaving pattern-shaped assets entirely.
- **Re-attaching the same cursor is a refresh, not a teardown.** Not
  cosmetic: wyrm's viewer calls `attach()` on every music selection
  *including re-selecting the already-playing track*, and
  `audio-playback.md`'s verification table already checks this doesn't
  restart playback for the audio bar — the panel must not reset scroll
  position or rebuild its static layer in that case either.
- `detach()` hides the panel and stops the frame loop but does **not**
  dispose the cursor, so a long-lived cursor built once per song survives
  a later re-`attach()`. The parked cursor is disposed when a different one
  attaches, or the controller itself disposes.
- `refresh()` — same cursor, different content or size: re-read
  `cursor.document`, re-measure, re-resolve theme, rebuild static layer,
  redraw.
- `dispose()` unbinds every listener, disconnects the `ResizeObserver`,
  cancels the frame loop, disposes the parked cursor.

**Two decisions worth stating plainly:**

1. **The panel owns the frame loop, not the cursor** — it polls
   `position()` on rAF while `playing`, using `onChange` only to wake up.
   That's what lets a push-driven `LiveCursor` and pull-driven
   `ScheduledCursor` share one interface without either faking the other,
   and it decouples render rate from wyrm's actual tick rate (`(2500/125)*6
   = 120ms`/row, ~8.3Hz — visibly stuttery if drawing were driven by it
   directly).
2. **A null 2D context is a supported state, not an error.** jsdom returns
   `null` from `getContext('2d')` unless the `canvas` npm package is
   installed, which nothing in seer currently depends on. `PatternPanelController`
   runs all lifecycle/state/renderer-selection/frame-loop/label logic
   normally and skips only the draw calls — making the whole lifecycle
   testable in jsdom with zero new dependencies. The renderer choice is
   also mirrored onto `panel.dataset.patternMode` for exactly this reason
   (observable from a test without touching pixels).

### 3.2 Grid renderer (`grid-renderer.ts`)

Columns are lanes; each cell a fixed-width `C-2 05 A08` triplet, empty
cells `··· ·· ···` in a muted colour. Current row pinned at a fixed y,
pattern scrolls under it; rows from a different pattern than the current
one are dimmed. A narrow order-list strip along the top shows `document.order`
with the current index marked, `restartOrder` marked distinctly. **Only the
visible row window is drawn** — O(gridWindow × lanes) per frame regardless
of song length; no offscreen caching needed at that size.

### 3.3 Timeline renderer (`timeline-renderer.ts`)

X = time, Y = lane band, and within a band Y = pitch mapped over that
lane's own observed semitone range (so a bass lane and a lead lane each use
their full height). Notes are filled blocks coloured by instrument,
alpha-scaled by velocity; `chordMember` notes get a thin left-edge marker.
Markers render as ticks above the lanes. **All note blocks draw once into
an offscreen canvas on `refresh()`/`attach()`**; per frame the renderer
blits that layer, draws the playhead, overdraws the `notesAt()` active set.
Load-bearing for a future AKAO/VP1 timeline of thousands of notes, not just
WIME's few hundred. Scrub mechanics mirror `applySummonSequenceFrame`
(`siren/tools/viewer/viewer.ts:1006-1029`) — pointer x → position, clamped,
reported via `onScrub`; unconsumed by any host in v1.

### 3.4 Theme (`theme.ts`)

```ts
export interface PatternTheme {
  background: string; grid: string; text: string; textMuted: string;
  playhead: string; rowHighlight: string; noteFill: string; laneBand: string;
  instrumentPalette: string[];   // cycled per instrument register
}
/** Resolves from CSS custom properties on :root (--accent, --text-muted,
 *  --bg, …) with hardcoded fallbacks — same technique ceres's
 *  music-view.ts:165 already uses. Resolved once per refresh(), not per
 *  frame. */
export function resolveTheme(overrides?: Partial<PatternTheme>): PatternTheme;
```

## 4. `@seer-project/smus` — timeline builder (Phase 4)

```ts
/**
 * Decodes a parsed SMUS score into an absolute-time note timeline, without
 * synthesizing audio.
 *
 * This is a WHOLE-SCORE walk, not per-track, and that's required for
 * correctness, not an optimisation: `_handleControl` (smus-engine.ts:400-402)
 * writes SID_TEMPO to the engine's own `bpm`, not to TrackState, so a
 * tempo change in track 0 moves every subsequent note in tracks 1-3. A
 * per-track builder would drift silently on any score with a mid-song
 * tempo change.
 *
 * Mirrors the engine exactly: bpm starts at max(score.tempo/128, 1); each
 * track is primed the way _primeTrack is (leading control events consumed
 * at zero cost); repeatedly advance every live track by the smallest
 * remaining wait, converting that span to seconds at the bpm in force
 * during it (seconds += beats * 60 / bpm), then consume whichever tracks
 * hit zero — including the chord-continuation recursion (data & 0x80
 * accumulates, the group emits together at one `start`).
 *
 * The one intentional divergence: the engine steps in 128-sample blocks
 * (renderBlock, smus-engine.ts:808-815), quantising note onsets to ~2.9ms
 * at 44.1kHz, while this walks in exact beats. Phase 0(b)'s probe and the
 * slow drift-check test both bound the gap at one grain — a third of a
 * frame at 60Hz, below anything visible.
 *
 * Durations come from the already-public eventDuration() in smus.ts,
 * confirmed bit-for-bit identical to the engine's private
 * noteDurationBeats() — both mask data & 0x3f the same way before this
 * call; no third copy of the formula is introduced.
 */
export function buildSmusTimeline(score: SmusScore): PatternTimelineDocument;
```

Fidelity notes carried in the doc comment, since each is a place picture
and sound legitimately differ:

- **`tieOut` is ignored** — the engine ignores it too (`_consumeEvent` never
  reads it), so a tied pair sounds and draws as two notes. Consistent, not
  a bug.
- **Lane ≠ voice for chords** — `_startVoice` places extra chord notes on
  *any free voice*, so audible panning can differ from the originating
  track. The timeline keeps every chord member in its source track's lane
  (the musically correct reading) and documents the divergence rather than
  reproducing it.
- **`document.duration` is the musical end**, shorter than the rendered
  buffer (which includes release tails) — see §6.2 for how the cursor
  handles the difference.
- **SMUS has no loop structure** — `loopStart` is always `null`; the
  viewer's `sourceNode.loop = true` is a UX affordance, not a format
  property.

Also in this phase: fix the `SmusScore.tracks` element-type export gap
(correction #3) — export a named `SmusEngineEvent` type from `smus-engine.ts`
via the package's `index.ts` so a consumer of `tracks: SmusEngineEvent[][]`
has something to write against.

## 5. wyrm integration (Phase 3)

### 5.1 Changes to `music-player.ts`

Three small, independently-justified changes:

**(a) Multi-subscriber updates.** Replace the single nullable
`onUpdate` field with a `Set`, replace `setOnUpdate` with
`addUpdateListener(cb): () => void`. Delete `setOnUpdate` rather than shim
it — its "unsubscribe by installing a no-op" idiom
(`setOnUpdate(() => {})`, used in both `onStateChange`'s teardown and
`dispose()`) becomes actively wrong once the slot is a set, since it would
silently leave the real listener installed. `TrackerPlaybackEngine` stores
its own unsubscribe and calls it from `dispose()`.

**(b) Expose the parsed module.** Add `getModule(): Flt4Module | null` and
export `Flt4Module`/`Note`/`Sample` (none currently exported) — the adapter
converts, `MusicPlayer` stays format-level with no view-model knowledge.

**(c) Report the row actually sounding.** Move `fireUpdate()` in `tick()`
to immediately before the `currentRow++`/order-wrap block instead of after.
One line; fixes correction #2. This *is* a user-visible change to
`#music-info` (reads one row lower than before) — called out as a
deliberate correction in the Phase 3 commit, with the Playwright gate
asserting panel and text now agree as the regression test.

**Not changed in v1**, noted rather than fixed: `restart` is parsed but
never honoured (the player stops at `songLength` instead of looping) — the
document still exposes `restartOrder` so the panel *displays* the loop
point correctly even though playback doesn't take it.

### 5.2 The adapter (`wyrm/tools/viewer/flt4-pattern-document.ts`)

```ts
/** Period → semitone by frequency ratio, not table lookup, so a finetuned
 *  period lands on the right note instead of falling through to null:
 *  semitone = round(12 * log2(PERIOD_C2/period)) + C2_SEMITONE.
 *  null for period <= 0 or a result outside 0..119. */
export function periodToSemitone(period: number): number | null;

/** orders sliced to songLength here, so nothing downstream needs to know a
 *  MOD's order array is a fixed 128 bytes. */
export function flt4ToPatternDocument(mod: Flt4Module): PatternGridDocument;

/** Clamped against document.order.length so a state observed mid-transition
 *  can't index out. */
export function musicStateToPosition(state: MusicState, doc: PatternGridDocument): PatternPosition;

export function musicPlayerSource(player: MusicPlayer): LiveCursorSource<MusicState>;
```

4 lanes, `Ch 1`..`Ch 4`, `pan` = `-0.65/0.65/0.65/-0.65` read straight off
the existing Paula stereo assignment in `tick()`, so lane colouring matches
what's audibly on each side.

### 5.3 Host wiring

`index.html` — a sibling of `#music-panel`:
```html
<div id="pattern-panel" class="hidden">
  <div id="pattern-panel-head">
    <span id="pattern-label"></span>
    <button id="pattern-toggle" type="button">Hide</button>
  </div>
  <canvas id="pattern-canvas"></canvas>
</div>
```
`viewer.css` mirrors `#music-panel`'s existing docking block. `viewer.ts`:
construct `patternPanel` alongside the existing `audioBarController`; in
`selectMusicTrack()`, build (or reuse, from a `Map<songId, cursor>`) a
cursor and `attach()` it — the cache is what makes re-selecting an
already-playing track hit the refresh path, not teardown, mirroring why
the existing code re-attaches the same `trackerEngine`. Add
`patternPanel.detach()` at each existing `setHidden(musicPanel, true)`
site — preserving the deliberate existing behaviour that switching to a
sprite asset hides the panel without stopping playback.

## 6. middilgard integration (Phase 6)

### 6.1 `ScheduleClock` for the offline blob

`SmusPlaybackEngine` gains:
```ts
/** The rendered buffer's own length — longer than document.duration by
 *  release tails. null when nothing is rendered. */
get renderDuration(): number | null;

/** Seconds since the current playthrough started, wrapped by the buffer's
 *  length (matching sourceNode.loop = true), or null when stopped.
 *  (ctx.currentTime - startedAt) % buffer.duration, startedAt captured at
 *  the existing sourceNode.start() call. */
elapsed(): number | null;
```
`teardownAudio()` clears `startedAt`, so `elapsed()` returns `null` after
`pause()` — correct, since middilgard's pause is a full stop by design.
**The two durations serve different jobs and must not be conflated**:
wrapping uses the buffer's length (what the audio does), layout uses
`document.duration` (the renderer clamps the playhead for the tail).

### 6.2 Showing the timeline before Play

`SmusPlaybackEngine.select()` deliberately doesn't render (a full
`renderAll()` is expensive and shouldn't fire on a sidebar click) — that
contract stays untouched. But the timeline needs no render: `parseSmusScore`
+ `buildSmusTimeline` is a parse and event walk over a few-KB file, so
`viewer.ts` does that itself on selection, independently of the engine.
The panel populates the moment a song is picked — a real UX win, and the
strongest evidence in the Phase 6 Playwright gate that the schedule is
genuinely precomputed rather than derived from audio. The `.smus` file is
fetched twice for a song that's then played; accepted for v1 (small file,
browser HTTP cache), noted as a `Map`-cache fix if it ever matters.

### 6.3 Host wiring

Same shape as wyrm — `#pattern-panel` sibling to `#music-strip`, reusing
the existing shared `.hidden` rule. Construct next to `audioBarController`;
build document + `ScheduledCursor` in the music-selection branch;
`patternPanel.detach()` at all three existing `setHidden(musicStrip, true)`
sites; `cursor.notify()` from the engine's state-change subscription so the
panel's frame loop wakes when a render finishes.

## 7. Testing

### Pure, plain Node

**`packages/core/src/__tests__/pattern.test.ts`** — `findAtOrBefore`
(empty/single/before-first/after-last/duplicate-resolves-to-last);
`buildTimelineIndex`/`notesAt` (active exactly at `start`, not at
`start+duration`; long note still sounding across later short notes;
chord members at identical `start` all returned; no cross-lane leakage;
`out` reuse doesn't accumulate); `validatePatternDocument` (unsorted notes,
an `order` entry indexing a missing pattern, out-of-range `restartOrder`,
a ragged row).

**`packages/smus/src/__tests__/timeline.test.ts`** — hand-built `SmusScore`
fixtures, no files, no audio: a quarter note at 120 BPM → `{start:0,
duration:0.5}`; rest-then-note offset; dotted/triplet/quintuplet/septuplet
against `eventDuration`; a leading `SID_INSTRUMENT` consuming zero time;
`SID_DYNAMIC`'s `max(data,1)/127` clamp; **the cross-track tempo test** — a
`SID_TEMPO` in track 0 shifting a later note in track 1, the test that
proves the whole-score design and would fail against a per-track builder;
a chord producing N notes sharing one `start` with `chordMember` correct;
`sourceIndex` round-tripping.

**`packages/smus/src/__tests__/timeline-drift.test.ts`** (slow) — a real
`SmusEngine` over the same fixture, spy on `_startVoice` (a cast past
`private`), `renderAll()`, assert every voice-start sample index is within
one 128-sample grain of `buildSmusTimeline`'s `start * 44100`. Keeps the
pure re-implementation from silently drifting from the engine it mirrors.

**`wyrm/tools/viewer/__tests__/flt4-pattern-document.test.ts`** —
`periodToSemitone` (exact table periods, a finetuned in-between period,
`period===0`→null, an absurd period→null); `flt4ToPatternDocument` over a
hand-built 2-pattern module (order sliced to `songLength`, an out-of-range
order entry handled without throwing, cell fields mapped 1:1, lane `pan`
matching Paula assignment); `musicStateToPosition` clamping at song end.

### jsdom, panel lifecycle

**`packages/pattern-ui/src/__tests__/pattern-panel.test.ts`** — same
construction as `mesh-settings-panel.test.ts`/`audio-bar.test.ts`: real
jsdom elements, a hand-built scriptable fake `PatternCursor`. Assertions
against `classList`, `dataset.patternMode`, `label.textContent`, cursor
call counts — never pixels (the 2D context is null by design). Covers:
show/bind-nothing on construction; `attach()` sets `dataset.patternMode`
from both `document.kind` arms; different-cursor `attach()` disposes the
previous exactly once; same-cursor `attach()` disposes nothing and doesn't
reset scroll (the wyrm re-selection case); `detach()` hides + stops the
frame loop without disposing; `attach()` after `detach()` resurrects the
parked cursor; `dispose()` disposes parked + removes every listener; frame
loop starts/stops with `playing` via a stubbed rAF; optional elements
absent; `refresh()` with nothing attached is a no-op.

### Playwright, per project

Same discipline as `audio-playback.md`'s verification table — headless
Chromium against each project's real dev server and real extracted data,
console errors captured, structural/state assertions only (no pixel diffs
— nothing here is pixel-pinned).

**wyrm**: select a music asset → `#pattern-panel` shows the order list and
grid **before** Play; Play → highlighted row advances monotonically across
3 samples and **agrees exactly with `#music-info`'s row readout on every
sample** (the regression test for the off-by-one fix); Stop → returns to
order 1/row 1; re-select the still-playing track → keeps advancing rather
than resetting; switch to a sprite asset → panel hides, audio keeps
playing, switch back shows the still-advancing row; PAL→NTSC still works.
Gate: all exact, zero console errors, every existing wyrm row in
`audio-playback.md` still passes unchanged.

**middilgard**: select a song → `#pattern-panel` shows 4 lanes and >0 notes
**before** Play (proves parse-without-render); Play → after render
completes, playhead x increases monotonically across 3 samples and
`notesAt` yields a non-empty active set; Pause → playhead clears (matches
the engine's full-stop semantics); replay works; volume slider still
tracks. Gate: all exact, zero console errors, every existing middilgard row
in `audio-playback.md` still passes unchanged.

The "panel populated before Play" assertion carries real weight in both
rows — in wyrm it proves the document comes from the parsed module rather
than accumulated ticks; in middilgard it proves the schedule is genuinely
precomputed rather than derived from audio.

## Phases

Every phase carries a stated exit criterion. Phases 1, 2, 4, 5, 7 are
checkpointable commits in `seer` alone; 3 and 6 are one commit each in a
downstream repo, separately verified — same discipline as the
settings-panel and render-quality rollouts.

0. **Probe** (throwaway code only). (a) Instrument `MusicPlayer.tick()` to
   log the row index at note-trigger time against the displayed readout on
   a real Dune module. (b) Prototype `buildSmusTimeline` against one real
   WIME `.smus`, diff its note starts against a `_startVoice` trace from a
   real `renderAll()`. (c) Confirm `canvas.getContext('2d')` returns `null`
   under this repo's vitest+jsdom setup.
   *Exit: written findings. (a) confirms correction #2 is a real bug,
   gating the Phase 3 line-move. (b) bounds the pure-walk drift — if it
   exceeds one 128-sample grain, the pure function is abandoned for an
   engine-emitted schedule and §4 is rewritten. (c) confirms the
   headless-tolerance requirement in §3.1 is necessary, not defensive.*
1. **`core` `pattern.ts`** — document model, cursors, search helpers,
   `validatePatternDocument`. No consumers yet.
   *Exit: `pattern.test.ts` green; package builds; the new file imports
   nothing DOM-typed (grep-checked).*
2. **`pattern-ui` + grid renderer** — scaffold + `PatternPanelController` +
   `theme.ts` + `grid-renderer.ts` + README.
   *Exit: `pattern-panel.test.ts` green under jsdom with a null 2D context;
   package builds and emits types; README's lifecycle prose matches
   `audio-ui`'s four semantics.*
3. **wyrm integration** — `music-player.ts` changes, adapter, host wiring.
   *Exit: full wyrm Playwright row passes, incl. highlight-agrees-with-text
   and re-select-doesn't-reset; `flt4-pattern-document.test.ts` green; zero
   console errors; wyrm's existing `audio-playback.md` rows unregressed.*
4. **`smus` `timeline.ts`** — `buildSmusTimeline` + export-hygiene fix.
   *Exit: `timeline.test.ts` green including the cross-track tempo test;
   drift check stays within one grain; `smus`'s existing tests unregressed;
   `SmusScore.tracks`'s element type is publicly nameable.*
5. **Timeline renderer** — `timeline-renderer.ts`, offscreen static layer,
   `notesAt`-driven highlight.
   *Exit: static layer rebuilt only on `attach()`/`refresh()`, not per
   frame (call-counted against a fake context); `pattern-panel.test.ts`
   extended to `kind:'timeline'` through the same lifecycle matrix.*
6. **middilgard integration** — `elapsed()`/`renderDuration`, host wiring,
   parse-on-select.
   *Exit: full middilgard Playwright row passes, incl. populated-before-
   Play and a monotonic playhead after; zero console errors; middilgard's
   existing `audio-playback.md` rows unregressed.*
7. **Documentation** — this doc's verification table filled in from the
   measured Phase 3/6 runs, matching `audio-playback.md`'s format.
   *Exit: real measured entries, no "TBD" rows, no aspirational wording.*

## Future work

**valkyrie/VP1 — the natural third host.** `patternOffsets` is a real,
reused order list, but pattern data isn't exported to the browser yet and
needs a new build-time JSON export stage, which would serialize a
`PatternGridDocument` directly — why `version`/`validatePatternDocument`
are in the v1 model rather than added later. `expandTrackSchedule`
(`valkyrie/tools/shared/psx-vp-bgm.ts:630`) already produces the tick-based
analogue of what `ScheduledCursor` consumes. VP1 is also the first format
that would plausibly want *both* views at once (a grid order list over
event-stream tracks) — the case that tells us whether the union needs a
third arm or a host just attaching two panels.

**`@seer-project/tracker` convergence** — the real MOD engine (full
effects, variable channels, a proper mixer), and the obvious long-term
replacement for wyrm's hand-rolled player. Two fixable blockers: position
opacity (promote `seqPos`/`row`/`tick`/`speed`/`tempo`/`channels` to public
getters, add a row-boundary hook at the end of `private seqRow()` around
line 511); and a likely-broken worklet handoff
(`postMessage({data:{player: this._player}})` structured-clones a class
instance, stripping the prototype — untested end-to-end, confirm before
relying on it). Bigger, independently valuable, and should not be
entangled with this visualiser.

**ceres/AKAO — ruled out, permanently.** A free-running per-track event
stream with no order list at all (`ceres/docs/ffvi/snes/data-structure.md`
§18.2). Not a pattern format; a *pattern* visualiser is the wrong lens. If
a timeline view is ever wanted, it's a straightforward
`PatternTimelineDocument` producer and the model already admits it without
change — evidence for the union, not a reason to reopen scope.

**The editing stretch goal — what v1 must not foreclose.** The editor
isn't designed here; these are the four places the document model would
need to change, all of which v1 is positioned for:

1. **Lossless pitch is already preserved — the load-bearing decision.**
   `PatternPitch.raw` keeps the Amiga period; micromod discards finetune at
   load. A document sourced from `Module` cannot round-trip to the
   original bytes. Concrete argument against ever making micromod's
   `Module` the canonical document, even after the convergence work above
   — the engine can be shared without the document model following it.
2. **Identity.** v1 is value-shaped, rebuilt wholesale by `refresh()`.
   Editing needs a stable address per cell/note: `{pattern,row,lane}`
   suffices for grid documents; timeline notes need a monotonic id.
3. **Provenance and invertibility.** `buildSmusTimeline`'s walk has no
   inverse today — no `SEvent` writer, and durations are quantised onto the
   division/dot/tuplet lattice, so an arbitrary edited duration isn't
   representable. Round-trip editing needs `writeSmusTrack(notes) →
   SEvent[]` plus, per note, a back-reference to its source event and
   original flags byte — **`TimelineNote.sourceIndex` exists in v1 for
   exactly this reason**: costs one number, unread today, unrecoverable
   later without re-walking a score that may by then be edited.
4. **Mutability seam.** The panel's lifecycle already has a home
   (`attach(cursor, {editable})`), and `onScrub` is the pointer-input seam.
   Undo, dirty state, write-back are out of scope.

## Critical files for implementation

- `seer/packages/core/src/playback.ts` — the contract `pattern.ts` extends
- `seer/packages/audio-ui/src/audio-bar.ts` + its README — the lifecycle
  `PatternPanelController` mirrors semantically
- `seer/packages/smus/src/smus-engine.ts` — `_consumeEvent` (508-543),
  `_handleControl` (395-404), `_advanceTracks` (545-557), `renderBlock`
  (808-815) — `buildSmusTimeline` mirrors all four
- `wyrm/tools/viewer/music-player.ts` — `setOnUpdate` → multi-subscriber,
  `getModule()`, the `fireUpdate()` line move in `tick()`
- `middilgard/tools/viewer/components/smus-playback-engine.ts` — gains
  `elapsed()`/`renderDuration`
- `seer/packages/mesh-viewer-ui/package.json` — the scaffold to clone for
  `@seer-project/pattern-ui`
