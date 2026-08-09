# @seer-project/audio-dsp

Format-agnostic real-time-audio primitives shared by `@seer-project`'s
synthesis engines — a block-render driver, voice mixdown, and
fractional-position (optionally looped) resampling.

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
