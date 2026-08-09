# @seer-project/audio-dsp

Format-agnostic real-time-audio primitives shared by `@seer-project`'s
synthesis engines — a block-render driver, voice mixdown, and
fractional-position (optionally looped) resampling.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

Zero runtime dependencies. Contains **no synthesis** (no oscillators, no
waveform generation — that stays in each format-specific engine, e.g.
`@seer-project/smus`'s Sonix filter-bank generator) and **no format
parsing**. This package exists because one primitive — looped
fractional-position sample resampling — was independently duplicated
across `@seer-project/smus` and `@seer-project/tracker` before it existed,
and a third consumer (SNES DSP-family sound-driver playback) needs the same
shape with a different interpolation kernel.

## What's here

- **`render-driver.ts`** — `BlockRenderer` interface + `renderToStereoBuffers()`:
  pull fixed-size stereo blocks from a source until it reports itself
  finished, concatenate, and trim trailing near-silence.
- **`mix.ts`** — `mixVoiceStereo()` / `applyMasterGain()`: accumulate a mono
  voice buffer into stereo at independent left/right gains, then a clamped
  master-volume pass.
- **`resample.ts`** — `resampleLooped()`: advance a fractional read position
  through a sample buffer, looped or one-shot, with a `'nearest'` /
  `'linear'` / `'gaussian4'` interpolation kernel. `GAUSSIAN_TABLE` is the
  real SNES S-DSP 512-entry Gaussian interpolation table.

## What's deliberately not here

Envelope/ADSR state machines, an `Instrument`/voice-parameter type, and BRR
(or any other codec) decoding are all format/hardware-specific enough that
forcing them into a shared shape would cost more than it saves — see the
package's introduction in the seer git history for the reasoning. Each
engine keeps its own.

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
