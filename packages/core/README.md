# @seer-project/core

Generic binary utilities for browser-based reverse-engineering projects.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Zero runtime dependencies. Browser-safe (no Node built-ins). This is the
foundation package that all other `@seer-project/*` packages depend on.

## Installation

```bash
npm install @seer-project/core
```

## Modules

### `binary.ts` — Low-level byte readers

Standalone functions for reading unsigned integers from `Uint8Array` with
configurable endianness. No format assumptions — safe for any binary target.

```ts
import { r8, r16, r24, r32 } from '@seer-project/core';

const value = r32(data, offset, 'be'); // uint32, big-endian
```

| Function | Width | Notes |
| --- | --- | --- |
| `r8(data, offset)` | 8-bit | Endianness N/A |
| `r16(data, offset, endian)` | 16-bit | `'be'` or `'le'` |
| `r24(data, offset, endian)` | 24-bit | |
| `r32(data, offset, endian)` | 32-bit | Returns unsigned (`>>> 0`) |
| `dataViewOf(data)` | — | Create a `DataView` over a `Uint8Array` |

### `binary-reader.ts` — Sequential cursor reader

`BinaryReader` wraps an `ArrayBuffer` with a sequential read cursor.
Endianness is a constructor parameter (default big-endian).

```ts
import { BinaryReader } from '@seer-project/core';

const reader = new BinaryReader(buffer, 0, 'be');
const magic = reader.readFourCC();   // "FORM"
const size  = reader.readUint32();
const chunk = reader.readBytes(size);
```

| Method | Returns | Description |
| --- | --- | --- |
| `readUint8()` / `readInt8()` | `number` | 8-bit integer |
| `readUint16()` / `readInt16()` | `number` | 16-bit integer |
| `readUint32()` / `readInt32()` | `number` | 32-bit integer |
| `readFourCC()` | `string` | 4-byte ASCII chunk ID |
| `readBytes(n)` | `Uint8Array` | Raw byte slice |
| `readCString(max?)` | `string` | Null-terminated ASCII string |
| `readString(len)` | `string` | Fixed-length ASCII string |
| `subReader(len)` | `BinaryReader` | Sub-reader for a byte range |
| `seek(offset)` / `skip(bytes)` | `void` | Move the cursor |

### `assets.ts` — Runtime asset loader

Fetch preprocessed JSON (and text) assets produced by the offline pipeline.
Browser-safe — uses `globalThis.fetch`, no Node built-ins.

Lives in `@seer-project/core` (not `@seer-project/pipeline`) to prevent Node-only
dependencies from leaking into browser bundles.

```ts
import { loadAssets, type AtlasMeta } from '@seer-project/core';

interface MyAssets {
  atlas: AtlasMeta;
  map: { cols: number };
}

const assets = await loadAssets<MyAssets>('/assets/mygame/amiga', {
  atlas: 'atlas.json',
  map: 'map.json',
});
```

Or use the factory for reusable loading:

```ts
import { createAssetLoader } from '@seer-project/core';

const load = createAssetLoader('/assets/mygame/amiga');
const assets = await load<MyAssets>({ atlas: 'atlas.json', map: 'map.json' });
```

### `atlas.ts` — Shared texture-atlas metadata

The one canonical `AtlasMeta`/`AtlasFrame` shape written by every offline
build-assets pipeline and read by both browser runtime and viewer tooling —
a shelf-packed atlas (arbitrarily positioned/sized frames), not a uniform
grid, since real extracted sprite art is essentially never uniformly sized.

```ts
import type { AtlasFrame, AtlasMeta } from '@seer-project/core';

const atlas: AtlasMeta = {
  width: 256,
  height: 256,
  frames: [{ name: 'hero_idle', x: 0, y: 0, w: 32, h: 48 }],
};
```

| Type | Description |
| --- | --- |
| `AtlasFrame` | `{ name, x, y, w, h }` — one packed sprite's position/size |
| `AtlasMeta` | `{ frames: AtlasFrame[], width, height }` — one atlas image |

### `palette.ts` — Palette-cycling utility

`cyclePalette(colors, start, end, direction)` rotates a contiguous
sub-range of a color array by one step, wrapping within that range only —
the classic 8/16-bit-era "colour cycling" animation trick (VGA palette
rotation, Amiga copper-list swaps). Generic over `T`, no DOM/WebGL/canvas
dependency; the caller owns how the result gets drawn or uploaded.

```ts
import { cyclePalette } from '@seer-project/core';

// Rotate indices 10-13 forward by one step, e.g. once per animation frame.
cyclePalette(paletteColors, 10, 13, 1);
```

### `playback.ts` — Audio playback-engine contract

`PlaybackEngine` is the interface the viewer's shared audio-bar UI
(`@seer-project/audio-ui`'s `AudioBarController`) drives — `play()`, plus
*optional* `pause()`/`stop()`/`seek()`/`setVolume()` an engine can leave
unimplemented rather than faking. (`pause` is optional because a tracker
engine tears its worklet down on stop and has no paused state to resume
from; implement at least one of `pause`/`stop` so the bar can halt
playback.) It intentionally does not standardize how a track is *loaded*
(a native `<audio>` engine needs a URL; a live tracker/SMUS synthesis
engine needs format-specific song data) — only the transport surface a
generic UI can drive. See `@seer-project/audio-ui`'s README and
[`docs/audio-playback.md`](https://seer.shaid.net/guides/audio-playback/) in the seer repo for the full design and worked
adapter examples (wyrm's FLT4 tracker, middilgard's SMUS engine).

`PlaybackState` is a discriminated union on `seekable`, so `duration` can
never contradict it — a seekable state always carries a number, and a
non-seekable one is always `null`. Narrowing gives consumers the non-null
type for free:

```ts
import type { PlaybackEngine, PlaybackState } from '@seer-project/core';
import { attemptPlayback, formatClock } from '@seer-project/core';

formatClock(125.9); // "2:05"

if (state.seekable) {
  const fraction = state.currentTime / state.duration; // number, not number | null
}

// Starting audio fails as either a rejected promise (autoplay policy) or a
// synchronous throw; this catches both.
attemptPlayback(() => engine.play(), (err) => console.warn('Playback failed:', err));
```

| Export | Description |
| --- | --- |
| `PlaybackState` | `{ isPlaying, currentTime, title, detail?, volume? }` + either `{ seekable: true, duration: number }` or `{ seekable: false, duration: null }` |
| `PlaybackEngine` | `{ play, pause?, stop?, seek?, setVolume?, getState, onStateChange, dispose }` |
| `formatClock(seconds)` | `mm:ss` formatting; `"0:00"` for `null`/`undefined`/negative/non-finite input |
| `attemptPlayback(play, onFailure)` | Runs a `play()` thunk, routing a rejection *or* a synchronous throw to `onFailure` |

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
