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

- `@seer-project/arcade` — `Cps2Video` (`capcom/cps2-video.ts`, exported from
  `/capcom`): a CPS2 board video renderer for reimplementations. Game logic
  writes gfx RAM, the CPS-A/CPS-B and CPS2 object registers and object RAM
  over a 68000-style `write16`; `render()` gives a 384x224 frame of palette
  indices, `paletteRgba()` the colours (brightness nibble applied, entry
  0xc00 = the black backdrop). SCROLL1/2/3 with flips and row scroll,
  layer-control order and enables, CPS2 block sprites with the OBJ_PRI
  priority masks, palette upload with page control. Graphics through
  `Cps2Gfx` (`Cps2GfxRegion` lazy decode, `Cps2PackedGfx` sparse tiles).
  Browser-safe.
- `@seer-project/arcade-runtime` — new package: the runtime shell for
  browser-native arcade reimplementations (ported game logic on a virtual
  board, not emulation). `createFixedStepLoop` steps at the board's own
  refresh rate (e.g. Black Tiger's 59.637 Hz) from rAF time, with capped
  catch-up, pause, single-step and a speed multiplier. Boards hand over an
  `IndexedFrame` (`Uint16Array` palette indices) and an RGBA palette;
  `createPresenter` draws them through a WebGL2 R16UI + palette-texture
  shader with integer/fit/fill scaling and pixel aspect, optionally through
  `@seer-project/retro-display`, falling back to Canvas2D.
  `indexedToRgba` is the CPU reference. `createInputMap` turns keyboard
  (MAME default keys) and gamepads into one bitmask per player per step,
  with plain-JSON remappable bindings; `defineDipSwitches` gives typed DIP
  settings that also pack to raw DSW bytes. `snapshotState`/`restoreState`
  (in place, keeping typed-array identity), `RingBuffer` for rewind,
  `InputRecorder`/`runReplay` and `hashState` (FNV-1a over a canonical
  walk) cover save states and per-frame replay regression tests.
  `createAudioWorkletHost` posts frame-stamped sound commands to a worklet,
  and the `./worklet` subpath's `defineGeneratorProcessor` renders a
  generator with each command landing on its exact sample.
- `@seer-project/arcade` — Black Tiger board video in `./capcom`
  (`capcom/blktiger-video.ts`): `BlktigerVideo` holds the bg tile RAM (4
  banks), text RAM, palette RAM, live and vblank-buffered sprite RAM and the
  scroll/layout/enable/bank registers, accepts Z80-style memory and port
  writes, and renders a 256x224 frame of palette indices (0..1023).
  `BlktigerRenderer` is the stateless core. The scrolling bg wraps in both
  8x4 and 4x8 page layouts, sprites follow the hardware draw order with
  clipping, and bg pixels go in front of or behind sprites per pixel from
  the `bd02` -> `bd01` PROM chain. `blktigerPaletteToRgba` and
  `blktigerFrameToRgba` convert to RGBA. Also re-exported from the package
  root.
- `@seer-project/arcade` — new `./yamaha` subpath with register-driven
  YM2203 (OPN) models: `Ym2203Fm` (3 channels, 8 algorithms, envelope
  generator, detune/MUL, feedback; sample rate `clock / 72`) and
  `Ym2203Ssg` (3 tones, noise, mixer, 4-bit volume). Both step one sample at
  a time with no platform imports, so they run in offline renders and
  AudioWorklets alike. Checked against MAME 0.289's ymfm on Black Tiger's
  music and effects (identical register streams within 0.03–0.18 dB and
  ~0.01 cent), not against real silicon. Moved from the kolbold consumer
  repo so a browser runtime and the RE tools share one copy. Also
  re-exported from the package root.
- `@seer-project/switch` — new package: Nintendo Switch container
  primitives, filling the gap left by `@seer-project/gpu-textures` already
  billing itself as a Tegra X1 (Switch) block-linear deswizzler with no
  package to get from a title to the textures. Browser-safe parsers over
  `Uint8Array`: `parsePfs0` (the partition table an NSP is laid out as,
  with every entry offset made *absolute* — the stored value is relative to
  the data base, and treating it as a file offset carves the wrong bytes
  out of a multi-gigabyte NSP with no error at all), `parseTicket` (a
  retail `.tik`'s Rights ID and its title key, returned **raw** — still
  titlekek-encrypted, because the tool that decrypts the NCA unwraps it
  itself against the *NCA header's* Master Key Revision, which really does
  disagree with the ticket's own revision byte in the wild), and
  `buildNsoImage` (the `NSO0` executable's segment table, laid out flat at
  its `memoryOffset`s so a pointer out of the module's own tables indexes
  the image directly) with `readCString`, a deliberately strict pointer
  *oracle* that answers `null` rather than mojibake. A `./node` subpath
  carries the two routines that need the disk — `listPfs0File` reads a
  30 GB NSP's header region and nothing else, `extractFileRange` carves a
  range out in bounded chunks — kept out of the main barrel so a viewer can
  import the parsers. Deliberately **no** key derivation, no AES, no keyset
  format and no decryption-tool driving: a framework package has no
  business hardcoding a user's keyset path or a `hactool` location, so it
  stops at handing those the right byte range and the right raw key. Scope
  is PFS0 (not XCI's HFS0), the NSO header (not MOD0), and ticket layout
  (not signature verification). Migrated out of chimera, its first
  consumer.
- `@seer-project/core` — `decompressLz4Block`, the LZ4 **block** format (no
  frame header, no checksums) that `NSO0` segments, Unity bundle blocks and
  most "LZ4 at a known size" middleware payloads use. It is here rather than
  beside `@seer-project/pipeline`'s other decompressors (`decompressLZEXE`,
  `ancientDecompress`, the RNC/PP20 pair) because that barrel reaches
  `node:fs` through `config.js`/`io.js`; LZ4 is a pure byte transform that
  platform packages need, so it belongs on the zero-dependency side. The
  result is trimmed to what the stream actually produced rather than
  zero-padded to the declared size, so `result.length === outSize` stays a
  usable correctness assertion, and all three overrun conditions throw
  instead of returning a partial buffer indistinguishable from a good one.
- `@seer-project/skeleton` — new package: engine-agnostic skeleton
  retargeting for offline rig conversion — structural humanoid core-bone
  labelling from hierarchy and bind-pose geometry alone
  (`labelHumanoidCoreBones`, no bone names required), three ways to build a
  `BoneCorrespondence` (core-label matching with a Kuhn-Munkres per-fork
  assignment, name-keyed, and a purely geometric pass that reports rather
  than accepts), ancestor-fallback resolution, skin-weight transfer, and
  bind-pose reconciliation (T-pose vs A-pose, differing proportions and
  units). Everything works on plain TRS bone arrays — `{ parent, rotation,
  position, scale }` — so an engine's own skeleton type is *structurally*
  assignable with no adapter and no conversion copy; no DOM, no `node:*`,
  and no dependency beyond `@seer-project/gltf`'s matrix helpers. This is
  the offline counterpart to `@seer-project/engine-3d`'s runtime
  `retargetClipsToSkeleton`, not a replacement for it. Migrated out of
  chimera, its first consumer; the two repos' golden-hash tables are
  deliberately the same numbers for the same case names, which is what
  pins the two sides together. Engine-specific bone remap tables (a
  format's own compact bone-index table, a global bone-id namespace) stay
  in the consuming project by design — this package matches bones, not
  file-format side tables.
- `@seer-project/3ds` — new package: Nintendo 3DS asset-format primitives —
  CTPK texture packs, the CTR texture tile/ETC1 decoder, Nintendo
  LZ10/LZ11/LZ13 decompression, BCSTM/BFSTM streamed-audio headers, and the
  BCH/CGFX 3D model containers (`bch.ts`/`cgfx.ts` share a consolidated
  `mat4-ctr.ts` matrix-math module — except `accumulateBone`, which is kept
  as two separate implementations since the two source files' versions had
  genuinely diverged, not just drifted stylistically). RomFS container
  access and NCCH AES key/ticket derivation (both genuinely Node-only) live
  behind a `./node` subpath. Migrated off lucina, its sole consumer.
- `@seer-project/cri` — new package: CRI Middleware CPK archive, ADX audio,
  and ACB/AWB sound-bank readers (`cpk.ts`, `adx.ts`, `acb.ts`, `awb.ts`),
  plus the shared `@UTF` table engine (`parseUtf`/`readUtfRow`/
  `subUtfTable`) those containers are built on. Ported browser-safe from a
  `Buffer`-based original — every read site now goes through `DataView`/
  `Uint8Array`. Single consumer (vanille) so far.
- `@seer-project/dos` — new package: Microsoft EXEPACK decompression
  (`exepack.ts`) and the Okumura LZHUF codec (`lzhuf.ts`), both already
  browser-safe as extracted. See the package's README for how EXEPACK and
  LZHUF relate to (and differ from) `@seer-project/pipeline`'s existing,
  unrelated LZEXE decompressor (`lzexe.ts`) — same DOS-executable-shrinking
  era, different vendors, different algorithms, no shared code.
- `@seer-project/gfx` — `packed-pixel.ts` (DOS CGA/Tandy chunky-pixel
  decode: `decodePackedPixelLinear`, `decodeCgaBanked`,
  `indicesToRGBAWithTransparency`), `raster.ts` (a generic even-odd
  scanline polygon fill + Bresenham line rasterizer: `scanlineFillPolygon`,
  `bresenhamLine`, consolidating two identical copies of the same
  algorithm that had drifted into two separate output representations —
  indexed-buffer and RGB-canvas — in the same consumer project),
  `megadrive-vdp.ts` (Sega Genesis/Mega Drive VDP 4bpp tile decode + CRAM
  palette), and a standalone `expandVga6` added to `palette.ts` (kept out
  of the existing `ColorWordFormat`/`expandColorWord` API since VGA's
  6-bit-per-channel DAC format isn't a packed color word).
- `@seer-project/arcade` — OKI MSM6295 ADPCM (`capcom/oki-adpcm.ts`),
  uPD7759 ADPCM (`sega/upd7759-adpcm.ts`), the QSound chip split from its
  driver (`capcom/qsound.ts` — sample decode + register map — versus
  `capcom/qsound-driver.ts` — Z80 note tables, envelope dispatch, and the
  full CPS2 sequence/track/instrument/pitch grammar, ~90% of the original
  file), and Sega System 16 tile/sprite/palette decode
  (`sega/system16-gfx.ts`). First-time package adoption for its one
  consumer (kolbold).
- `@seer-project/snes` — `akao-dsp.ts` (`PITCH_TABLE`, `PITCH_UNITY`,
  `noteToResampleStep`, `decodeBrrBlob`): AKAOSNES sound-driver-traced
  pitch/BRR-blob helpers, promoted from byte-identical copies that had
  independently accumulated in two sibling projects (ceres,
  chronotrigger). The per-game AKAO sequence/sample/SPC-render files those
  two projects also hold are deliberately *not* consolidated — each is
  independently reverse-engineered against that game's own compiled sound
  driver, with 85%+ pairwise divergence; see
  `docs/common-tooling-candidates.md`.
- `@seer-project/snes` — new package: SPC700 CPU interpreter
  (`spc700-cpu.ts`), a register-driven S-DSP audio engine (`spc700-dsp.ts`:
  ADSR/GAIN envelopes, BRR playback, echo, noise, pitch modulation),
  standalone envelope helpers (`envelope.ts`), the BRR sample codec
  (`brr.ts`), the echo unit (`echo.ts`), and PPU tile/CGRAM decoders
  (`ppu.ts`) — consolidating a SPC700/S-DSP emulation stack that had
  drifted, with real behavioral differences (GAIN mode, PMON), across
  three sibling SNES projects. Driver-specific pitch/tuning conversion and
  any BRR "blob" container framing are deliberately excluded — see the
  package's own README.
- `@seer-project/playstation` — new package: PlayStation-family (PSX/PS2/
  PSP) disc and hardware primitives. `cd/sector.ts` (raw CD sector layout,
  CD-XA subheaders, BCD/MSF/LBA math, `RawCdReader`/`PlainSectorReader`),
  `cd/iso9660.ts` (a directory walker parameterized over any `DiscReader`,
  replacing near-duplicate PSX-CD and PSP-UMD copies), `cd/cue-sheet.ts`
  (`.cue`/`.bin` parsing and audio-sector decoding), `psx/tim.ts` (the
  standard TIM texture container — ships two independently-verified BGR555
  decode pipelines rather than merging them, since they disagree on channel
  scaling), `psx/str-xa.ts` (STR MDEC video + CD-XA audio, one
  `wrapAsCdxa` covering both the subheader-synthesized and
  subheader-preserved on-disk shapes), `psx/lzs.ts` (the classic PSX LZSS
  variant, unifying two sibling projects' divergent APIs for the same
  codec), `psx/spu-reverb.ts` (the SPU's hardware reverb DSP + the 10
  standard libspu presets), and `psp/atrac3p.ts` (PSMF ATRAC3+ elementary-
  stream extraction + a minimal OMA/EA3 header writer). File-backed disc
  I/O lives behind a separate `./node` subpath so the rest of the package
  stays browser-safe.
- `@seer-project/gltf` — new package: a byte-level glTF 2.0 / GLB read+write
  pipeline for extraction tools. `builder.ts` (buffer/accessor bookkeeping,
  skeleton matrix math, GLB packing — rewritten to use `TextEncoder`/
  `DataView` instead of Node's `Buffer`, so the whole default barrel is
  genuinely browser-safe, unlike the source this was extracted from),
  `reader.ts` (the GLB read direction: accessors with `normalized`
  denormalization and interleaved `byteStride`, node TRS matrix
  decomposition, skins, primitives), and `mesh-shape-classifier.ts` (a
  geometry-only "is this prop weapon-shaped" heuristic — its default
  thresholds are calibrated against one game's corpus and documented as
  such, not a universal constant). Embedded-PNG pixel decoding
  (`readImage`/`readBaseColorImage`, which need `pngjs`) lives behind a
  `./node` subpath, matching `@seer-project/playstation`'s split.
- `@seer-project/gpu-textures` — new package: GPU texture codecs for modern
  console decompilation. `swizzle.ts` (Tegra X1/Nintendo Switch
  block-linear (de)swizzle, including `swizzledSurfaceSize` for the real
  GOB-padded byte span a caller must slice up to), `bc.ts` (BC1-7/S3TC
  block compression, including a full spec-conformant BC7 decoder ported
  from Microsoft's DirectXTex — see the package's README for a known,
  deliberately-not-fixed-here BC2/BC3 alpha-index decode bug carried
  forward from the source this was extracted from), `astc.ts` (ASTC decode)
  and `zstd.ts` (Zstandard decompression) — both now real npm dependencies
  on `@tootallnate/astc-wasm`/`@tootallnate/zstd-wasm` (MIT) rather than
  vendored WASM blobs of uncertain provenance, discovered to be
  byte-identical to what was already being vendored. See
  `THIRD-PARTY-LICENSES.md` for the `swizzle.ts` provenance chain, which
  still needs a licensing review before a published release.
- `@seer-project/engine-3d` — `polygon-validate.ts`
  (`validatePolygonObjects`/`hasIssues`/`describeIssues`): mesh-integrity
  checks (non-finite coordinates, out-of-range face indices, implausible
  extents) for a `{verts, faces}` mesh about to be serialized as
  polygon-json, catching format hypotheses that would otherwise ship a
  file that looks fine and renders as nothing.
- `@seer-project/core` — `atlas-pack.ts` (`shelfPack`/`packAtlasRgba`): the
  shelf-packing atlas layout independently reimplemented byte-for-byte
  identically in two sibling projects and near-identically in a third,
  consolidated onto `atlas.ts`'s `AtlasFrame`/`AtlasMeta` shape.
- `@seer-project/core` — `wav.ts` (`encodeWav`/`int16FromFloat32`/
  `int16FromSigned8`): a pure, filesystem-free RIFF/WAVE PCM encoder usable
  from browser code, not just the offline pipeline.
- `@seer-project/pipeline` — `writeWav` gains an `Int16Array[]` overload
  (most sibling projects hold already-quantized PCM, not normalized
  `Float32Array` samples) and now delegates encoding to
  `@seer-project/core`'s `encodeWav`.
- `@seer-project/pipeline` — `ancient.ts`: a wrapper around the `ancient`
  CLI for RNC ProPack v1/v2, IMP! File Imploder, and PowerPacker/PP20
  (including renamed-magic variants), consolidating three sibling projects'
  independent shell-out wrappers around the same tool.
- `@seer-project/amiga` — `hunk.ts` gains `resolveHunkRelativeGlobal`,
  resolving a bare "absolute address" literal from a disassembly to the
  hunk/file-offset it's actually relative to pre-relocation, corroborated
  by matching `HUNK_RELOC32` entries elsewhere in the file.
- `@seer-project/mesh-viewer-ui` — new package: `MeshSettingsPanel`, a
  generic settings-popover controller collecting a mesh viewer's render
  mode, shading override, smooth/flat normals, subdivision, and texture
  filtering + anisotropy into one togglable panel instead of a row of
  individual toolbar controls — the shared UI layer siren's viewer
  hand-rolled these around, generalized the same way
  `@seer-project/audio-ui` unified the audio transport bar.
- `@seer-project/engine-3d` — `mesh-shading.ts` (`applyMeshShading`, a
  `'lit'\|'unlit'\|'normals'\|'depth'\|'toon'` shading override layered on
  top of `render-modes.ts`'s render mode) and `mesh-polish.ts`
  (`applyMeshPolish`/`subdivideGeometry`/`applySmoothNormals`, browser-side
  geometry subdivision and smooth-normal averaging rebuilt from a captured
  original on every change) — both extracted from siren's viewer so a
  second consumer doesn't have to re-derive them.
- `@seer-project/engine-3d` — `texture-filter.ts`: `applyTextureFilter`, a
  new texture filtering control (`'nearest'\|'linear'\|'trilinear'` +
  clamped anisotropy) applied to a glTF model's original materials so it
  survives switching render modes/shading.
- `@seer-project/engine-3d` — `MeshSession` gained
  `setShading`/`setSmooth`/`setSubdivision`/`setTextureFilter`/
  `getMaxAnisotropy`, composing the three modules above with
  `setRenderMode` so a host's appearance state stays consistent without
  reimplementing the render-mode/shading/geometry interplay itself.
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

### Changed

- `create-seer-app` — the scaffolded `src/main.ts` now renders a
  placeholder splash (game/platform identity read from `game-id.ts`, a
  link to `/tools/viewer/`) into `#game-container` instead of booting an
  empty `createGame()` with `// TODO` hooks. Every downstream project
  still shows a blank black canvas at this stage — `docs/common-tooling-
  candidates.md`'s own audit flagged `onInit`/`onUpdate` as `// TODO` in
  five of six sibling repos, with only `middilgard` ever filling them in.
  The viewer link only renders when `--viewer` was passed (`it.viewer` in
  the template context); a scaffold without the viewer gets a note
  pointing at the flag instead of a dead link.

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
