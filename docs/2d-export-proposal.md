# 2D sprite viewer: export, grading, and retro display shaders — proposal

**Status: implemented (Phases 1–6 complete), pending independent review.**
Companion to [`docs/render-quality-proposal.md`](render-quality-proposal.md)
(the 3D mesh-viewer "photo mode" work) — this is the 2D-sprite-viewer
equivalent, scoped to what actually carries over from that plan. All six
phases shipped to siren, flower, and chimera: screenshot/video export, the
persistent-canvas refactor, colour grading, and the new
`@seer-project/retro-display` package (all five `DisplayProfile` values,
including curvature/glow/chromatic-aberration) behind a consolidated 🎨
Display panel. One data-driven caveat carried through every phase's commit
message: siren has zero exercisable 2D sprite assets across all three of
its games, so its shader/frame-advance/recording/grading/retro-display
paths were verified via temporary debug hooks synthesizing test data
(always reverted before commit, confirmed via `grep`) rather than against
real production assets — chimera and flower both have real texture data
and were verified against it directly.

> **Revision 2** follows the same design review that produced revision 2 of
> the 3D proposal. The headline correction: **revision 1's "zero new export
> code" claim was false for video.** Screenshots are genuinely nearly free;
> video recording requires a persistent-canvas refactor of the 2D draw path
> across three repos, which revision 1 did not budget. That refactor is now
> its own phase. See [Corrections from review](#corrections-from-review).

## Context

[`docs/render-quality-proposal.md`](render-quality-proposal.md) splits
export (screenshot/watermark/video recording) into an asset-agnostic
package, `@seer-project/canvas-export`, specifically so the 2D sprite/atlas
viewer — the Canvas2D-drawn baked-PNG path, plus the hand-rolled WebGL2
indexed-palette + colour-cycling shader in each project's `viewer.ts` — can
reuse it. This doc covers what's new for 2D:

1. **Export** — reuse `canvas-export`. Screenshots are cheap; video needs a
   draw-path refactor first.
2. **Colour grading** (brightness/contrast/saturation/hue) — a cheap,
   viewer-only nicety.
3. **Retro display simulation shaders** — CRT/LCD scanlines, shadow
   mask/aperture grille, phosphor glow, vignette, chromatic aberration —
   simulating how this pixel art actually looked on period hardware, which
   is a genuinely good fit for a *reverse-engineering* asset viewer (the
   source material's real presentation context), not just a generic filter
   gallery.

None of 3D's shadows/AO/DOF/path-tracing carry over — there's no depth,
geometry, or lighting model for a flat sprite to hook any of it into. That
entire axis of the 3D plan is inapplicable here.

**Sequencing note.** `canvas-export` is now Phase 1 of the 3D plan rather
than Phase 7, so this document's Phase 1 is unblocked immediately. Revision
1 of both docs contained a contradiction — this one called itself
independent of the 3D work while being gated behind that plan's
second-most-speculative phase. That is resolved.

## The 2D draw path as it exists today

Every claim below is verified against `siren/tools/viewer/viewer.ts`;
flower and chimera share the shape. This section exists because revision 1
planned against an imagined draw path, and the real one is the whole reason
Phase 2 exists.

For a sprite frame, `drawAsset` (lines 539-549):

1. constructs a **new `Image()`** and issues a **fresh fetch** of the atlas
   PNG;
2. in `onload`, does `canvasWrap.innerHTML = ''` (line 541);
3. creates a **brand-new `<canvas>` element**, sized to `frame.w * zoom ×
   frame.h * zoom`, and appends it.

Under autoplay this runs every `AUTOPLAY_INTERVAL_MS = 150` (line 1168),
i.e. **6.7 times a second**. `drawFullAtlas` (line 566) and the shader path
(line 779) follow the same wipe-and-recreate shape.

The shader path is worse: `drawAssetShader` calls `initGL(canvas)` (line
787), which calls `canvas.getContext('webgl2')` (line 658) — **a new WebGL2
context per draw**, with no context attributes.

## Part 1 — Screenshots (Phase 1, genuinely cheap)

Reuse `canvas-export`'s `captureBlob`/`downloadScreenshot`/`drawWatermark`
unchanged. Two things the 2D `CaptureSource` must get right, both of which
revision 1 got wrong:

- **`canvas` must be a getter.** The element identity changes on every
  draw (line 541 above). A `CaptureSource` built once with a captured
  reference holds a detached node. This is why `capture-source.ts`
  documents the getter requirement at the interface level.
- **`renderNow` is required for the shader path**, not omittable.
  Revision 1 claimed "a plain Canvas2D canvas's buffer is always current,
  so `renderNow` is simply omitted (screenshot capture is *simpler* for 2D
  than for the WebGL mesh viewer, which needs the `preserveDrawingBuffer`
  workaround)." That is true for exactly one of three draw paths.
  `viewer.ts:658` is `getContext('webgl2')` with **no attributes** — the
  same non-preserved drawing buffer as the mesh viewer, needing the same
  treatment. And Part 3 below introduces a *third* WebGL path with the same
  constraint.

Watermark text is host-built from data the viewer already has, same shape
as the 3D panel's `watermarkText()`.

## Part 2 — Persistent-canvas refactor (Phase 2, the real cost)

`canvas.captureStream()` cannot work against the draw path described above.
Three independent showstoppers:

1. **The bound canvas is destroyed 6.7 times a second.** The
   `MediaStreamTrack` goes to `ended` on the first frame advance.
2. **Dimensions change per frame** — sprite frames have different `w`/`h`.
   Even with a stable element, a mid-stream resolution change breaks the
   recording.
3. **The redraw is asynchronous** (`img.onload`), so there is no
   synchronisation point between "the driver advanced a frame" and "the
   pixels exist" — which the deterministic fixed-timestep recorder in
   `canvas-export` requires.

And a two-second recording through `drawAssetShader` would create ~13 WebGL2
contexts, against a browser cap around 16.

So Phase 2 restructures the 2D draw path onto:

- **one persistent, fixed-size canvas**, sized to the largest frame (or the
  atlas) and reused, with sprite frames drawn into a stable viewport rather
  than sizing the element per frame;
- **a cached atlas `Image`**, loaded once per asset rather than re-fetched
  per frame;
- **one persistent WebGL2 context** for the shader path, with `initGL`
  hoisted out of the per-draw call;
- **a synchronous `redraw()`** once the atlas is loaded, so capture has a
  defined point to read after.

This touches `drawAsset`, `drawFullAtlas`, and `drawAssetShader` in siren,
then flower and chimera. It is the largest phase in this document, not the
cheapest — revision 1 had it as neither.

**It is worth doing independently of export.** The per-frame WebGL2 context
creation is a live resource leak, and re-fetching the atlas PNG on every
autoplay tick is wasteful even if the browser cache absorbs it.

## Part 3 — 2D video export (Phase 3)

Once Part 2 lands, this is the thin wiring revision 1 imagined: a
`CaptureSource` over the persistent canvas, and a `driver` wrapping the
existing autoplay timer or summon-sequence timeline —
`{start: () => togglePlayback(true), stop: () => togglePlayback(false)}` —
handed to `recordClip()`. No turntable equivalent exists for 2D (no camera
to orbit); recording is always "play the frame sequence".

Unlike the 3D side, no `requestEveryFrame()` lease is involved — there is
no frame limiter here.

## Part 4 — Colour grading (Phase 4)

Brightness/contrast/saturation/hue-rotate via the Canvas 2D context's own
**`ctx.filter`** property — *not* the CSS/DOM `style.filter` property.
`ctx.filter` is a real pixel-level operation applied during `drawImage`, so
it is identical between the live preview and anything `toBlob()` or the
recorder captures. `style.filter` is compositor-level only and would **not**
appear in an export. Set it before each `ctx.drawImage(...)` in the draw
functions:

```ts
ctx.filter = `brightness(${b}) contrast(${c}) saturate(${s}) hue-rotate(${h}deg)`;
```

`buildGradingFilterString(opts: GradingOptions): string` (defaulting to
`'none'`) is the whole testable surface. **It lives in `canvas-export`** —
three projects need the identical string builder, and revision 1 left it
homeless ("lives directly in the consuming viewer or a tiny addition to
`canvas-export` … probably is"). Decide it here.

One compatibility note to carry in the UI: `ctx.filter` only shipped in
Safari 18.0 (September 2024). Feature-detect and fall back to ungraded
output rather than silently drawing nothing.

## Part 5 — Retro display simulation shaders (Phase 5)

The most substantive new piece: a WebGL2 fullscreen-quad fragment shader
that takes whatever's currently drawn as an input texture and re-renders it
with a period-display simulation applied — reusing the exact
`compileShader`/`initGL`/fullscreen-quad bootstrapping the indexed-palette
shader already establishes (`viewer.ts:657`), so this is additive to an
established pattern rather than new WebGL plumbing.

### New package: `@seer-project/retro-display` — scoped to *any* canvas

Revision 1 scoped this as a 2D-only package. **It isn't 2D-specific.** A
fullscreen-quad pass that takes a source canvas and re-renders it applies
equally to the 3D viewport's output — a CRT-simulated PSX battle model is
exactly as period-accurate as a CRT-simulated sprite. Scoped as 2D-only it
is a split that doesn't pay for itself; scoped as "post-display simulation
for any canvas" it has the same two-consumer justification `canvas-export`
has, which is what makes a package the right call in this monorepo.

```ts
export type DisplayProfile =
  | 'none'
  | 'crt-shadow-mask'      // classic consumer CRT
  | 'crt-aperture-grille'  // Trinitron-style
  | 'crt-slot-mask'
  | 'lcd-subpixel';        // handheld/early-flatscreen subpixel grid, no scanlines

export interface RetroDisplayOptions {
  profile: DisplayProfile;
  scanlineIntensity?: number;      // 0..1, default 0.3 — no-op for 'lcd-subpixel'
  maskIntensity?: number;          // 0..1, default 0.25
  curvature?: number;              // 0 (flat, default) .. 1 (full barrel distortion)
  vignette?: number;               // 0..1, default 0.15
  glow?: number;                   // phosphor bloom approximation, 0..1, default 0.2
  chromaticAberration?: number;    // 0..1, default 0
  brightness?: number;             // compensates for scanline/mask darkening, default 1.1
}

export const DISPLAY_PROFILE_PRESETS: Record<DisplayProfile, Partial<RetroDisplayOptions>>;

export interface RetroDisplayRenderer {
  /** Draws `source` through the shader into the renderer's own output canvas. */
  render(source: HTMLCanvasElement | HTMLImageElement): void;
  readonly canvas: HTMLCanvasElement;   // the output — what CaptureSource points at when a profile is active
  setOptions(next: RetroDisplayOptions): void;
  dispose(): void;
}
export function createRetroDisplayRenderer(opts?: RetroDisplayOptions): RetroDisplayRenderer;
```

Effects, each a small independent shader term (cite public-domain CRT
shader recipes for the maths — this is well-trodden, not novel research):

- **Scanlines** — per-row sine-wave darkening.
- **Shadow mask / aperture grille / slot mask** — a small tiled RGB
  subpixel pattern sampled against screen-space UV; three tile geometries,
  one per CRT profile.
- **LCD subpixel** — a regular RGB-stripe pattern, no scanlines, no glow —
  a period-accurate handheld look, distinct enough to warrant its own
  preset rather than being "CRT with scanlines at 0".
- **Curvature** — UV remap toward a barrel-distorted rect, off by default
  since an RE asset viewer's primary job is still "inspect the sprite
  clearly".
- **Vignette** — radial darkening toward the corners.
- **Glow** — a cheap bright-pixel bloom approximation. Keep it cheap; if it
  needs a real gaussian, cap it at a small fixed kernel rather than pulling
  in `UnrealBloomPass`-equivalent machinery.
- **Chromatic aberration** — R/G/B sampled at slightly offset UVs, off by
  default.

`DISPLAY_PROFILE_PRESETS` gives each profile sane defaults so the profile
selector alone is a complete, good-looking choice; the individual sliders
are for fine-tuning afterwards, not required inputs.

### Lifecycle constraint

`RetroDisplayRenderer` owns a persistent output canvas and GL context —
which the current draw path would wipe from the DOM on the next
`canvasWrap.innerHTML = ''`. **This depends on Phase 2**, same as video
export.

### Where grading fits relative to this

When a retro profile is active, fold brightness/contrast/saturation into
the same shader pass as extra uniforms — simpler and cheaper than
compositing two passes, and it avoids layering `ctx.filter` on top of a
WebGL output canvas. When `profile: 'none'`, grading falls back to
`ctx.filter` on the Canvas2D path (Part 4). Two code paths chosen by
whether a profile is selected; both converge on "the canvas `canvas-export`
captures."

## Part 6 — UI (Phase 6)

A `🎨 Display` popover (mirrors the 3D `🎬 Render` pattern — same
`createPopover` from `canvas-export`): profile selector, the per-effect
sliders (only those meaningful for the selected profile shown/enabled),
grading sliders, and the export buttons. No dependency on
`engine-3d`/`mesh-viewer-ui`; only `@seer-project/canvas-export` and
`@seer-project/retro-display`.

Each consumer's `package.json` needs `file:` links for both new packages —
`@seer-project/*` is unpublished, so a semver range resolves to a registry
404. Same footgun as the 3D rollout.

## Testing

- `retro-display`: pure tests for `DISPLAY_PROFILE_PRESETS` shape/defaults
  and option merging; the shader itself verified only in the browser
  (screenshot diffing against a baseline per profile).
- `buildGradingFilterString`: pure, exhaustive over the option grid
  (defaults → `'none'`, each param present → correct CSS function syntax).
- Phase 2's refactor: assert the canvas element identity is **stable**
  across an autoplay frame advance, and that `initGL` is called once per
  asset rather than once per draw — these are the two regressions that
  would silently un-break export later.
- Reuses `canvas-export`'s tests unchanged.
- Playwright, per project: switch through each `DisplayProfile` and assert
  the canvas image changes each time and differs from `'none'`; adjust a
  grading slider and assert the image changes; **export a screenshot under
  an active retro profile and confirm the *exported* image reflects the
  shader**, not just the live view — this is the specific regression the
  `ctx.filter`-vs-`style.filter` distinction exists to prevent; record a
  short clip of sprite playback and confirm a valid non-empty blob of the
  negotiated mime type.

## Phases

1. **2D screenshots** — `CaptureSource` with a canvas getter and a
   `renderNow` for the shader path; watermark; wire into the existing
   toolbar. *Exit: a watermarked PNG downloads from all three draw paths.*
2. **Persistent-canvas refactor** — siren first, then flower and chimera.
   *Exit: canvas identity stable across autoplay ticks; one WebGL2 context
   per asset; no visual regression in any draw path.*
3. **2D video export** on top of (2). *Exit: a clip of sprite playback
   records at the requested duration.*
4. **Colour grading** via `ctx.filter`, with `buildGradingFilterString` in
   `canvas-export`. *Exit: grading visible in an exported PNG, not just
   on screen.*
5. **`@seer-project/retro-display`** — package plus the `crt-shadow-mask`
   profile only, to prove the pipeline end-to-end. *Exit: profile visible
   in an exported PNG.*
6. **Remaining profiles** + curvature/glow/chromatic-aberration polish, the
   `🎨 Display` panel, and rollout siren → flower → chimera. *Exit: per-
   project Playwright pass, same discipline as the 3D rollout.*

Phase 1 needs nothing from the 3D plan beyond `canvas-export`, which is now
that plan's Phase 1. Phases 2-6 have no dependency on the 3D work at all.

## Corrections from review

1. **"Zero new export code" was false for video.** Revision 1: the driver
   seam "maps directly onto what the 2D viewer already has: its existing
   sprite-frame autoplay timer … wrap either in `{start, stop}` and hand it
   to `recordClip()`." The three showstoppers and the WebGL2 context
   exhaustion are documented in Part 2. The claim holds for screenshots; it
   does not hold for video.
2. **"Screenshot capture is simpler for 2D" was true for one of three draw
   paths.** `viewer.ts:658` has the same non-preserved WebGL drawing buffer
   as the mesh viewer, and Part 5 adds a third path with the same
   constraint — a problem revision 1 created in its own Part 3 and then
   contradicted in its Part 1.
3. **`CaptureSource.canvas` as a captured reference was unusable here** —
   the element identity changes on every draw. It must be a getter, and the
   3D doc's `capture-source.ts` now documents that at the interface level.
4. **`RetroDisplayRenderer`'s output canvas would have been wiped** by
   `canvasWrap.innerHTML = ''`. Same Phase 2 dependency as video export.
5. **`retro-display` was scoped 2D-only** despite not being 2D-specific.
   Rescoped to any canvas. See Part 5.
6. **`buildGradingFilterString` was left homeless.** It goes in
   `canvas-export`.
7. **Revision 1's Phase 1 was mis-sized by a wide margin** — described as
   "the cheapest, highest-value piece, no new package" while containing the
   un-costed refactor. Split into Phases 1-3.

Sustained from revision 1 without change: the `ctx.filter` vs
`style.filter` distinction and the export-reflects-the-shader Playwright
regression built on it — the sharpest call in either document — and the
judgement that no 3D concept (shadows, AO, DOF, raycasting, path tracing)
carries over to flat sprite art.

## Deferred

- Custom export backgrounds — same deferral as the 3D plan, not
  reconsidered here.
- Any 3D-derived rendering concept — not applicable, not planned in any
  form.
