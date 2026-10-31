# @seer-project/arcade-runtime

The runtime shell for browser-native *reimplementations* of arcade games —
ported game logic running against a virtual board, not an emulator. It
supplies everything around the game's step function: a fixed-step loop at
the board's refresh rate, an indexed framebuffer presenter (WebGL2 palette
shader, optionally through `@seer-project/retro-display`), keyboard/gamepad
input as per-player bitmasks, DIP switches, save states, rewind, input
replays, state hashes, and an AudioWorklet host for sound-driver ports.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Browser-only at runtime (canvas, WebGL2, Gamepad API, Web Audio), but every
pure part — loop timing, layout maths, palette packing, input masks, DIP
records, state hashing, replays, command scheduling — runs in Node, so a
port's regression tests need no DOM. The design assumes the sim is a
deterministic step function `(state, inputs) → state` over plain data: no
wall clock, no `Math.random`, no class instances in state.

## Installation

```bash
npm install @seer-project/arcade-runtime
```

Depends on `@seer-project/retro-display`.

## Fixed-step loop

```ts
import { createFixedStepLoop } from '@seer-project/arcade-runtime';

const loop = createFixedStepLoop({
  hz: 59.637, // Black Tiger's measured refresh, not the display's
  step: (frame) => sim.step(input.sample()),
  render: () => presenter.present(board.frame, board.paletteRgba),
});
loop.start();

loop.pause();       // keeps rendering, stops stepping
loop.stepOnce();    // frame advance
loop.setSpeed(2);   // fast-forward
loop.resume();
```

Each `requestAnimationFrame` adds the elapsed time to an accumulator counted
in steps and runs that many whole steps, so a 144 Hz monitor and a 60 Hz one
run the same number of sim steps per second. A backlog beyond
`maxCatchUpSteps` (default 4: a background tab, a debugger stop) is dropped
and counted in `droppedSteps` rather than replayed as a burst; resuming from
a pause doesn't catch up either. `requestFrame`/`cancelFrame` are injectable,
and `tick(time)` drives the loop by hand for headless runs.

## Indexed frames and presenters

```ts
import { createPresenter, pixelAspectForDisplay, type IndexedFrame } from '@seer-project/arcade-runtime';

const presenter = createPresenter({
  scale: 'integer',                           // or 'fit' / 'fill'
  pixelAspect: pixelAspectForDisplay(256, 224), // 7/6 on a 4:3 monitor
  retro: { profile: 'crt-aperture-grille' },  // optional, WebGL2 only
});
container.appendChild(presenter.canvas);

new ResizeObserver(([e]) => {
  const dpr = devicePixelRatio;
  presenter.resize(e.contentRect.width * dpr, e.contentRect.height * dpr);
}).observe(container);

const frame: IndexedFrame = { width: 256, height: 224, pixels: new Uint16Array(256 * 224) };
presenter.present(frame, paletteRgba); // paletteRgba: Uint8Array, 4 bytes per entry
```

A board renders palette **indices** (`Uint16Array`, one per pixel) and a
palette as RGBA bytes; colour is resolved only when presenting, so a fade is
a palette write. `createPresenter()` returns the WebGL2 presenter — R16UI
index texture, 256-wide RGBA8 palette texture, `texelFetch` lookups — and
falls back to a Canvas2D one that converts on the CPU. Both draw the same
pixels: alpha forced opaque, an index past the end of the palette drawn
black. With `retro` set, the scaled frame is drawn through retro-display and
`presenter.canvas` is retro-display's output canvas; it stays the same
canvas for the presenter's lifetime (`setRetroOptions({ profile: 'none' })`
turns the effect off). The Canvas2D fallback ignores `retro`.

`'integer'` scaling picks the largest whole vertical scale that fits, with
the width following the pixel aspect ratio. With `letterbox: true` (the
default) the canvas covers the target and the frame is centred on black.

The pure parts are exported for tests and offline tools:
`indexedToRgba(frame, palette)` (the CPU reference — also what a
screenshot or golden-PNG test should use), `packPaletteTexture(palette)`,
`computeLayout({...})` and `pixelAspectForDisplay(w, h, aspect)`.

## Input

```ts
import { createInputMap, ArcadeInput, inputNames } from '@seer-project/arcade-runtime';

const input = createInputMap(); // MAME default keys, gamepads 0/1 → P1/P2
const [p1, p2] = input.sample(); // once per step
if (p1 & ArcadeInput.BUTTON1) { /* ... */ }
inputNames(p1); // ['LEFT', 'BUTTON1']
```

Inputs are `UP DOWN LEFT RIGHT BUTTON1-4 START COIN SERVICE`, one bit each
in a per-player mask (`SERVICE` is a cabinet input; bind it to player 0).
Bits are logical (1 = pressed) — a port that reads active-low input ports
inverts them itself. `sample()` also counts a key pressed and released
between two samples as held for one sample, so a quick coin tap is never
lost; opposing directions held together are cleared (a real joystick can't
report left+right) unless `cleanOpposing: false`.

Bindings are plain JSON (`InputBindings`: `KeyboardEvent.code` → player +
input, plus a standard-mapping button table per gamepad), so a remap screen
saves them as-is:

```ts
import { rebindKey } from '@seer-project/arcade-runtime';

const code = await input.captureNextKey();
input.setBindings(rebindKey(input.bindings, code, { player: 0, input: 'BUTTON1' }));
localStorage.setItem('bindings', JSON.stringify(input.bindings));
```

Defaults (`defaultInputBindings()`) follow MAME: P1 arrows +
LCtrl/LAlt/Space/LShift, P2 R/F/D/G + A/S/Q/W, `1`/`2` start, `5`/`6` coin,
`9` service.

## DIP switches

```ts
import { defineDipSwitches, type DipSettings } from '@seer-project/arcade-runtime';

const dips = defineDipSwitches({
  lives: {
    label: 'Lives', default: 3, bank: 1, mask: 0x03,
    options: [
      { value: 2, label: '2', bits: 0x02 }, { value: 3, label: '3', bits: 0x03 },
      { value: 5, label: '5', bits: 0x01 }, { value: 7, label: '7', bits: 0x00 },
    ],
  },
} as const);

const settings = dips.parse(JSON.parse(localStorage.getItem('dips') ?? '{}')); // typed: { lives: 2 | 3 | 5 | 7 }
const [dswA, dswB] = dips.toBanks(settings); // raw bytes, unset bits 1 (active-low)
```

`parse` drops unknown keys and resets invalid values to the default.
`bank`/`mask`/`bits` are optional; with them, `toBanks`/`fromBanks` convert
to and from the raw DSW bytes the original code read.

## State, rewind and replays

```ts
import {
  snapshotState, restoreState, hashStateHex, assertPlainData,
  RingBuffer, InputRecorder, runReplay,
} from '@seer-project/arcade-runtime';

const save = snapshotState(state);  // deep copy, typed arrays included
restoreState(state, save);          // in place: typed arrays are set(), not replaced

const rewind = new RingBuffer<typeof state>(600);
rewind.push(snapshotState(state));  // e.g. every step
restoreState(state, rewind.pop()!);

const rec = new InputRecorder(2);
rec.record(masks);                   // every step
const replay = rec.toReplay({ dips: settings }); // plain JSON

// A regression test: replay headlessly and compare per-frame hashes.
const { hashes } = runReplay({ state: initialState(), step: simStep, replay, hashEvery: 60 });
```

`restoreState` keeps object and typed-array identity, so a renderer holding
`state.tileRam` keeps seeing live data after a load or rewind.
`hashState`/`hashStateHex` are a 32-bit FNV-1a over a canonical walk —
sorted object keys, float64 bytes for numbers (`-0` and NaN folded), and
element type + raw bytes for typed arrays — so equal data hashes equal
regardless of key order. `assertPlainData` throws with the offending path
(`state.player.ai is a Map`) for anything that would break snapshots or
hashes; run it in tests or debug builds.

## Audio

Game logic posts sound commands stamped with the sim frame, as the main CPU
wrote the sound latch; the sound-driver port runs in an AudioWorklet.

```ts
// main thread
import { createAudioWorkletHost } from '@seer-project/arcade-runtime';
import workletUrl from './sound.worklet.ts?worker&url'; // Vite bundles the worklet's imports

const audio = await createAudioWorkletHost({
  moduleUrl: workletUrl,
  processorName: 'blktiger-sound',
  hz: 59.637,
  processorOptions: { /* passed to the generator */ },
});
startButton.onclick = () => audio.start(); // needs a user gesture
audio.command(loop.frame, 0x1b);
audio.volume = 0.5;
```

```ts
// sound.worklet.ts
import { defineGeneratorProcessor } from '@seer-project/arcade-runtime/worklet';
import { Ym2203Fm, Ym2203Ssg } from '@seer-project/arcade/yamaha';

defineGeneratorProcessor<number>('blktiger-sound', ({ sampleRate, options, post }) => {
  // build the driver + chips here
  return {
    command(byte) { /* latch byte into the driver */ },
    render(channels, offset, count) { /* write count samples at offset into every channel */ },
  };
});
```

The worklet maps frame stamps to sample positions: the first command anchors
"now + `leadFrames`" (default 2), and later ones keep their spacing from it,
so commands three steps apart play three steps' worth of samples apart. If
the clocks drift too far (the sim paused or fast-forwarded) it re-anchors
rather than bursting or stalling. Each render quantum is split at command
boundaries, so a command lands on its exact sample. `stop()` silences
output and drops queued commands without resetting the generator; `reset()`
calls its `reset()`.

Import the worklet side from `@seer-project/arcade-runtime/worklet`, not
the package root — it pulls in no DOM code. `@seer-project/arcade/yamaha`
has no imports at all, so it is safe in a worklet; the `@seer-project/arcade`
root barrel is not (it pulls in `node:fs`). The worklet logic
(`GeneratorRunner`, `CommandScheduler`) is plain classes, testable in Node.

## Testing

```bash
npm test
npm run lint
```

Everything except the two presenters and `createAudioWorkletHost` is
tested in Node, including `defineGeneratorProcessor` against a fake
worklet scope. The presenters and host need a real WebGL2 context or
`AudioContext` and are verified in the browser.

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
