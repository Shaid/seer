# Changelog

All notable changes to the published `@seer-project/*` packages and the
`create-seer-app` scaffolder are recorded here. The packages are versioned and
released together.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html)
— with the usual 0.x caveat that minor bumps may carry breaking changes until
1.0.0.

## [Unreleased]

### Fixed

- `@seer-project/probe` — `triage` no longer counts the scanner's
  `hunk-wrapped` marker (context for `probe audio`'s output, not a media
  container) as a container hit. On the TOSEC ADF corpus the marker made
  up 81% of all "containers found", drowning the number that matters
  while duplicating what the hunk flag already reports.
- `@seer-project/probe` — the ZIP EOCD probe reads a ~1 KB tail instead
  of 22 bytes. TOSEC torrentzips every archive, which appends a comment
  that pushes the EOCD off the last 22 bytes, so the old fast path
  missed on 100% of a real collection and each miss cost a 64 KB
  fallback read (~1.8 GB of pure overhead across 29k archives).
- `@seer-project/probe` — files extracted from ADF images are deduped by
  content like every other descent path. A TOSEC game averages several
  release variants whose disks differ (crack intros, patches) while most
  files on them are identical; without this, per-game file counts
  inflated by the variant multiplicity.
- `@seer-project/probe` — reading more bytes than are on disk (archive
  tails and local headers on top of payloads) is now reported as
  overhead instead of a negative "avoided" percentage.

### Added

- `@seer-project/gfx` — new package: Amiga/Atari-ST planar bitmap decoding
  (`decodePlanar` across plane-major / row-interleaved / word-interleaved
  layouts with offset, row-padding and plane-stride support),
  `expandColorWord`/`expandPalette` for OCS 12-bit and AGA 24-bit colour
  words, `indicesToRGBA` with explicit opt-in transparency, and
  `greyscaleRamp`. The shared implementation called for by the cross-repo
  audit (`docs/common-tooling-candidates.md` §1, Amiga slice).
- `@seer-project/amiga` — new package: AmigaOS HUNK executable/module
  parsing with decoded `HUNK_RELOC32` and `HUNK_SYMBOL` blocks,
  per-hunk memory sizes, `hunkLoadAddresses` (IRA/LoadSeg contiguous
  layout), and a `buildHunkExe` synthetic-executable builder for test
  fixtures (audit §9).
- `@seer-project/probe` — new package: `seer-probe`, exploratory binary
  recon for 16-bit targets. Five commands — `map` (byte-class plot +
  entropy ribbon + region segmentation), `gfx` (ranked Amiga planar
  contact-sheet sweep), `stride` (record-size finder with harmonic
  folding and a record-grid PNG), `audio` (container scan + raw-PCM
  parameter sweep + spectrogram/WAV listen sheet), and `cnf` (IRA config
  coverage audit and generation). Design record in `docs/probe.md`.
- `@seer-project/probe` — `audio`'s container scan detects containers at
  any offset: IFF FORMs are swept across the whole file (validated
  against their size fields), HUNK executables are unwrapped and each
  hunk payload scanned, and every 8SVX voice found is written as its own
  WAV at its real VHDR rate. Driven by the first acceptance run against
  an untouched corpus, which shipped its sound library as 8SVX forms
  concatenated inside CODE hunks.
- `@seer-project/probe` — new `triage` command: whole-corpus first
  contact. Walks a directory tree and reports, per top-level
  subdirectory, an extension → dominant-class table plus every container
  hit, with HUNK and ADF detection. Promoted from a scratch script after
  being hand-rewritten for three corpora in a row. Descends into ZIP
  archives (deduping members by the central directory's stored CRC-32
  *before* decompressing, so duplicate dumps cost a hash lookup) and into
  walkable AmigaDOS ADF filesystems, and labels each group with its
  WHDLoad slave's game name.
- `@seer-project/probe` — `triage` now reads only what it needs, for
  corpora held on network shares: ZIP archives are parsed tail-first
  (last 22 bytes + central directory), so duplicate members are skipped
  without transferring their payloads and new members are read by byte
  range; files over `--full-read-mb` are sampled head+tail instead of
  read whole. Runs report bytes read against bytes on disk. On a corpus
  with three copies of each dump, 63% of all bytes are avoided and wall
  time stays flat as nominal size triples. Sampled files are counted
  separately, since their dedupe key is (size, head CRC, tail CRC)
  rather than a whole-file CRC.
- `@seer-project/probe` — `fileSource`/`bufferSource` (`ByteSource`):
  random-access byte sources with a `bytesRead` counter, so partial-read
  savings are measurable rather than assumed.
- `@seer-project/amiga` — ADF file sizes are clamped to the disk image's
  own length. A corrupt or non-DOS header block yields byte-size fields
  near 2^32, and both the lister and the reader previously trusted them,
  so a single damaged floppy in a collection made the reader allocate
  gigabytes for an 880 KB disk. Found by a TOSEC triage run reporting
  three "4,098 MB" games.
- `@seer-project/probe` — `triage` groups a flat collection by TOSEC
  title (`Title (year)(publisher)[flags]`), so the cracks, alternates
  and trainers of one game collapse onto one entry instead of one per
  release; non-TOSEC names still group by filename stem. Stored
  container examples are now capped per group and per run (hit counts
  stay exact), keeping the report bounded on a corpus of any size.
- `@seer-project/amiga` — `listAdf`/`readAdfFile`/`adfBootblockType`:
  read-only OFS/FFS filesystem reader for ADF disk images (DD and HD),
  returning null for NDOS/RawDIC trackloader images rather than guessing.
  Verified against real disks (Chaos Strikes Back, Midwinter 2, Conan).
- `@seer-project/amiga` — LHA/LZH reading (`isLhaFile`, `listLha`,
  `readLhaEntry`): header levels 0/1/2 and the `-lh0-`/`-lh4-`/`-lh5-`/
  `-lh6-`/`-lh7-` methods, the format practically every Amiga release
  ships in. Validated byte-for-byte against the system extractor on
  1,996 files across 40 real archives with zero mismatches; unsupported
  methods throw rather than mis-decode.
- `@seer-project/probe` — `triage` descends into LHA archives, so a
  WHDLoad collection reads as its actual contents instead of one opaque
  blob per game.
- `@seer-project/probe` — classifier and container-scan throughput
  roughly tripled (~16 → ~46 MB/s) via exact, behaviour-preserving
  changes: byte-comparison instead of per-offset string allocation in
  the IFF sweep, one histogram pass for entropy and byte-class
  fractions, lazy evaluation of the expensive class tests, and a prefix
  reject in `repeatingPeriod`. Verified identical on 41,516 real
  windows. (A sampled `equalityRateAtLag` was tried and rejected: under
  3% faster for up to 3% changed verdicts, with aliasing against the
  scanline lags being measured.)
- `@seer-project/amiga` — `parseWhdloadSlave`: reads a WHDLoad `.slave`
  header, including the v10+ name/copyright/info strings. 286 of the
  amigagames corpus's slaves self-identify with title, year and
  publisher — the one machine-readable label in a WHDLoad install.
- `@seer-project/probe` — the FORM scanner validates the type 4CC
  (printable alphanumerics, non-space lead); without it, "FORM" byte
  runs inside compressed data with plausible size fields flooded corpus
  triage with junk hits.
- `@seer-project/smus` — `parse8svx` and `isIff8svx` are now exported
  (previously internal to `parseInstr`), so consumers can decode a
  standalone IFF 8SVX file's VHDR header directly.

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
