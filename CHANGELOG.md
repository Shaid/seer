# Changelog

All notable changes to the published `@seer-project/*` packages and the
`create-seer-app` scaffolder are recorded here. The packages are versioned and
released together.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html)
— with the usual 0.x caveat that minor bumps may carry breaking changes until
1.0.0.

## [Unreleased]

## [0.1.0] — first public release

First publication to npm. Thirteen packages, released together because their
cross-dependencies pin `^0.1.0` and a partial release would not install.

### Libraries

- `@seer-project/core` — endian-aware binary reading primitives, cursor-based
  `BinaryReader`, asset/atlas/palette types. Zero dependencies, browser-safe.
- `@seer-project/engine-2d` — PixiJS game loop, pan/zoom camera, input manager,
  display-mode config, viewport culling and atlas-slicing helpers.
- `@seer-project/engine-3d` — format-agnostic three.js viewport, glTF loading,
  and a `{verts, edges, faces}` polygon-model adapter.
- `@seer-project/pipeline` — Node-only offline tooling: case-insensitive game
  data discovery, file I/O, PNG/WAV writers, hex dump, LZEXE decompression,
  sharded manifest writing.
- `@seer-project/iff` — generic EA IFF-85 FORM/chunk parser.
- `@seer-project/smus` — SMUS score parsing and a Web Audio synthesis engine.
- `@seer-project/tracker` — ProTracker MOD replay, ported from Martin
  Cameron's Micromod (BSD 3-Clause; see that package's
  `THIRD-PARTY-LICENSES.md`).
- `@seer-project/audio-dsp` — block-render driver, voice mixdown, looped
  fractional-position resampling.
- `@seer-project/audio-ui` — shared audio transport bar driving any
  `PlaybackEngine`, plus a native `<audio>` engine.
- `@seer-project/dungeon` — first-person grid dungeon walker: view-geometry
  walk, draw ordering, indexed palette compositing.

### Scaffolders

- `create-seer-app` — scaffold a complete project (`npm create seer-app <dir>`),
  or just its asset viewer (`… viewer <dir>`) or Astro + Starlight field-guide
  site (`… website <dir>`) into a project that already exists. The site scaffold
  ships the content standard (`WRITING-GUIDE.md`) with every new site.

### Packaging notes for this release

- Package source (`src/`) ships alongside `dist/`, so the bundled declaration
  and source maps resolve for consumers.
- Published declarations use `.js` import specifiers. An earlier build
  configuration emitted `.ts` specifiers into `.d.ts` files, which no consumer
  outside this workspace could resolve; that is fixed and covered by a
  consumer-position typecheck.
- Every package declares `engines.node >= 20.19.0` and is ESM-only — there is
  no CommonJS `require` entry point.
