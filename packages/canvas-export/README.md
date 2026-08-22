# @seer-project/canvas-export

Asset-agnostic canvas capture: watermarked screenshot export, deterministic
video-clip recording, and a shared toggle-popover controller. Works against
**any** canvas-based viewer — the 3D mesh viewport (`@seer-project/engine-3d`),
a 2D sprite/atlas canvas, or a WebGL2 shader pass — not just meshes.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Screenshot/watermark/video-recording have nothing to do with meshes — they
operate on whatever's currently drawn into a canvas. That's why this is a
separate package rather than part of `@seer-project/mesh-viewer-ui`: a
future 2D sprite viewer (or any other canvas-based seer viewer) gets export
for free, with zero new export code of its own. See
[`docs/render-quality-proposal.md`](https://seer.shaid.net/guides/render-quality/)
and its companion 2D doc in the seer repo for the full design writeup.

## Installation

```bash
npm install @seer-project/canvas-export
```

Zero runtime dependencies — no `@seer-project/*`, no three.js.

## `CaptureSource` — the seam

```ts
export interface CaptureSource {
  readonly canvas: HTMLCanvasElement;
  renderNow?(): void;
}
```

Everything in this package operates against a `CaptureSource`, never a
bare `HTMLCanvasElement` directly. Two things to get right implementing one:

- **`canvas` must be a getter, not a captured field**, if your host ever
  replaces its canvas element (a 2D viewer that rebuilds a fresh `<canvas>`
  per redraw is the concrete case this guards against) — a plain field
  would go stale the moment the element is swapped.
- **`renderNow()`** is required for any WebGL source without
  `preserveDrawingBuffer` — without it, a capture can read an
  already-cleared or about-to-be-swapped buffer instead of the last
  rendered frame. Omit it only for a source whose buffer is always already
  current (a plain Canvas2D context has no separate front/back buffer to
  go stale). **Callers must read the canvas synchronously right after
  calling `renderNow()`** — no `await` in between.

## Screenshots

```ts
import { downloadScreenshot } from '@seer-project/canvas-export';

const source = { canvas: viewport.renderer.domElement, renderNow: () => viewport.renderNow() };
await downloadScreenshot(source, 'my-model', {
  watermark: { text: 'My Model — My Game (PSX) — siren — a seer project' },
});
```

Watermark text is entirely host-supplied — this package never builds the
branding string itself, since only the host's viewer knows the asset name,
game, platform, and project. `captureBlob(source, opts?)` is the lower-level
form if you want the `Blob` yourself rather than triggering a download.

## Video clips

```ts
import { recordClip } from '@seer-project/canvas-export';

const { blob } = await recordClip(source, {
  driver: { start: () => turntable.start(), stop: () => turntable.stop() },
  durationSeconds: 4,
  fps: 30,
  watermark: { text: '…' },
});
```

`recordClip` is a **video-only, deterministic** capture — not a real-time
`captureStream(fps)` recording. It renders and commits one explicit frame
at a time (via `captureStream(0)`'s on-demand mode and
`track.requestFrame()`), so the exported clip's frame pacing is exactly
`1/fps` seconds apart regardless of how fast or slow the host machine
actually is: a slow machine takes longer to produce the clip, but the clip
itself comes out identical every time. There is no audio track — `driver`
starts and stops whatever visual animation is being recorded (a turntable
orbit, an animation-clip playback), not an audio-synchronized real-time
capture. A host whose canvas element is replaced mid-recording (see the
`CaptureSource` note above) needs a stable canvas for the whole clip — the
persistent-canvas requirement is a Vite/browser constraint on
`HTMLCanvasElement.captureStream()`, which is called once at the start of
recording.

`pickVideoMimeType(isSupported, preferred?)` is the pure mime-type
negotiation this uses internally (vp9 → vp8 → av01 → generic webm → mp4,
Safari's `MediaRecorder` only emitting mp4 is why that's the final
fallback rather than being dropped) — exported in case a host wants to
show the negotiated format before recording starts.

## `createPopover` — shared toggle-panel chrome

```ts
import { createPopover } from '@seer-project/canvas-export';

const unsubscribe = createPopover(toggleBtn, panel);
// later, when tearing the panel down entirely:
unsubscribe();
```

Toggle-click / outside-click / Escape-to-close, extracted from
`@seer-project/mesh-viewer-ui`'s original `MeshSettingsPanel` implementation
so it, this package's own future controls, and any future settings-style
popover share one implementation instead of duplicating it per package.
Uses the `.hidden { display: none }` class every seer project's own
`viewer.css` already defines as its open/closed source of truth.

## Testing

```bash
npm test
npm run lint
```

Every test runs against hand-built fakes rather than a real browser media
stack — a fake 2D context recording draw calls for the watermark/compose
tests, and a fake `MediaRecorder`/`captureStream` for the video tests —
since jsdom implements the DOM shape but deliberately not real canvas
rendering (`getContext('2d')` returns `null` unless the heavyweight
`canvas` npm package is installed) or media capture APIs at all. No
project's real game data or a real GPU is needed.

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
