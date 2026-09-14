# Package Extraction Plan

A survey of all ~30 sibling seer-framework consumer projects (every repo
alongside this one in `~/Development` with a `seer.config.ts` or a
`file:../seer/packages/*` dependency), looking for code that is generic
enough to promote into this repo's `packages/*` workspace. Produced
2026-09-12 by a six-way parallel scan of `src/`/`tools/` across all consumer
projects, followed by a grounding pass (model: Fable) that re-read the
actual files behind every claim before sequencing the work — several initial
claims turned out to be wrong or overstated; the corrections are recorded
below rather than silently dropped, since they change what to do first.

See also `docs/common-tooling-candidates.md` (an earlier, narrower six-repo
DRY audit with the same spirit) and `docs/project-status.md` (which packages
are settled vs. still moving).

## 0. Ground truth corrections to the initial scan

| Scan claim | What the code actually shows |
|---|---|
| SNES stack "byte-identical/drifted" across 3 projects | `snes-brr.ts`, `snes-echo.ts`, `snes-ppu.ts` are byte-identical ceres↔chronotrigger. `spc700-cpu.ts`, `snes-dsp.ts`, `spc700-dsp.ts` differ, and **ceres is a strict superset** of chronotrigger in every diff hunk (GAIN envelope, PMON, `getPortIn`, `onKeyOn`, `playingVoiceIndices`, the `tuning2` high-byte correction). Chronotrigger has no unique bugfixes. Strike's `snes-ppu.ts` is a strict subset of ceres's (ceres's was ported *from* strike, then extended). No three-way reconciliation is needed; there is one behavioural risk (see Phase 1). |
| `snes-dsp.ts` is hardware | Half of it is: `ENVELOPE_RATE_PERIOD`, `stepEnvelope`, `stepGainEnvelope`, `decodeAdsrRegisters`. The other half (`PITCH_TABLE`, `PITCH_UNITY`, `noteToResampleStep`) is **traced from the AKAOSNES driver's `CalcFreq`**, not S-DSP hardware. It must be split out, not shipped in a platform package. |
| ffv/ffvi `lzss.ts` "duplicated" | Two different codecs (different header semantics, different token bit-packing). `docs/common-tooling-candidates.md` §17 already rules bespoke codecs out. Do not extract. |
| WAV writer in 3 places | 13 sibling files hand-roll a RIFF header (ceres/chronotrigger/powermonger viewers, crawl, kolbold, middilgard, moonstone x3, parasite, strike, valkyrie x2, chimera). vanille has none. And `@seer-project/pipeline` **already has `writeWav`** (`packages/pipeline/src/io.ts`), but with a `Float32Array [-1,1]` API while every sibling holds `Int16Array` PCM; three of the duplicates are in browser viewers, which cannot import pipeline. |
| Atlas packer duplicated | Confirmed: valkyrie/vanille `atlas-packer.ts` are byte-identical; crawl's `atlas-pack.ts` is layout-only with `width/height` keys instead of core's `AtlasFrame` `w/h`. `@seer-project/core` already owns the `AtlasMeta`/`AtlasFrame` types. |
| `strike/tools/shared/{rnc1,lr88}.ts` are decompressors | Both **shell out to the `ancient` CLI** (temp file + `execFileSync`), exactly like methanoid's `ancient-decompress.ts`. Node-only by construction. `strike/tools/shared/amiga-hunk.ts` is a pre-extraction copy of `packages/amiga/src/hunk.ts` (strike never adopted `@seer-project/amiga`) plus two helpers the package lacks (`dataHunks`, `resolveHunkRelativeGlobal`). |
| `parasite/tools/shared/akao-audio.ts` | Does not exist there (it's `tools/parasiteeve/akao-audio.ts`, game-level). The `psx-actor-*` files are Parasite Eve's chunk container, bone directory and a *heuristic* bind-pose fallback: game-specific, not platform. |
| legion GPU-texture code is single-project | **Chimera has copies of `bc.ts`, `swizzle.ts`, `astc.ts`, `astc.wasm`, `gltf-builder.ts`** and is strictly ahead (real DirectXTex-ported BC7 vs legion's "approx"; `swizzledSurfaceSize`; lazy `node:` imports so the module loads in a Vite bundle). This is proven duplication: Tier 1 grade. Chimera additionally has a pure `gltf-reader.ts` that `mesh-shape-classifier.ts` depends on. |
| powermonger DOS files under `tools/shared` | They live in `src/assets/formats/`. `dosvga-palette.ts` is the game's palette table; only `expandVga6` is generic. `huffman-huf.ts` is generic LZHUF + a powermonger-specific `.HUF` container. |
| siren `mips.ts` mirrors `sh2.ts` | It's a 351-line `Ff9Mips*`-prefixed bounded runner with FF9 host callbacks, not a CPU core. `sh2.ts` is a complete opcode-for-opcode FBNeo port. Not comparable; defer. |
| docs already decided some of this | §7 verdict: WAV → `pipeline` `io.ts` (done, but consumers never migrated). §19: AKAO stays in ceres "until a second AKAOSNES consumer shows up" — **chronotrigger is that consumer now**, but its `akao-spc-render.ts` has diverged by ~1,500 lines. |

**Conventions every new/extended package must follow** (from `packages/amiga`,
`packages/audio-dsp`, `tsconfig.build.base.json`, commit `92b2416`):
- `package.json` with `exports["."]`, `files: ["dist","src","!src/__tests__","README.md","LICENSE"]`,
  scripts `build/prepack/prepublishOnly/pretest/test/lint`, `engines.node >=20.19.0`,
  `publishConfig.access: public`, `repository.directory`.
- `tsconfig.json` (extends `../../tsconfig.json`) + `tsconfig.build.json`
  (extends both, `references` to dependency packages' `tsconfig.build.json`).
- Package source imports `./x.js`, never `./x.ts`. Every sibling file uses
  `.ts` imports, so extraction always includes a mechanical rewrite.
- `README.md` mandatory (autogenerates the docs site page). `LICENSE` copy.
  `CHANGELOG.md` `[Unreleased] / Added` entry. `package-lock.json` regenerates.
- Tests: vitest in `src/__tests__/`, synthetic fixtures preferred; corpus-gated
  tests stay in the game repos using `describe.skipIf(!haveData)`.
- Node-only file I/O goes behind a `./node` subpath export (precedent:
  `engine-2d/pixi-helpers`, `/input`), keeping browser-safe barrels clean.
- Consumer projects resolve `file:../seer/packages/x` to `dist/`, so
  `npm run build:packages` in seer precedes every migration test run.
- Licensing gap: `THIRD-PARTY-LICENSES.md` only records Micromod today. The
  SNES stack (blargg's snes_spc, LGPL-2.1; Mesen2, GPL-3), arcade chips
  (MAME, BSD-3), BC7 (DirectXTex, MIT), ASTC (`@tootallnate/astc-wasm`, MIT),
  and `zstd.wasm` ("from astral-extractor", unverified) all need entries
  before any npm publish — `arcade/sh2.ts` (FBNeo) is an already-unrecorded
  precedent to fix in the same pass.

## Phase 0 — small, unblocking additions (all S, fully parallel)

- **0a.** Atlas shelf-packer → `@seer-project/core` (`shelfPack`, `packAtlasRgba`).
  Migrate vanille + valkyrie (delete identical copies), then crawl (mechanical
  `width/height` → `w/h` rename).
- **0b.** WAV encoding → `@seer-project/core` (`encodeWav`, browser-safe) +
  `pipeline`'s `writeWav` gains an `Int16Array[]` overload. Migrate strike
  `wav.ts`, valkyrie `wav-writer.ts` (+ its private copy in
  `valkyrieprofile/build-assets.ts`), the ceres/chronotrigger/powermonger
  `music-view.ts` viewers first; remaining duplicates opportunistic.
- **0c.** `ancient` CLI wrapper → `@seer-project/pipeline`
  (`detectAncientContainer`, `ancientDecompress`, `decompressRnc1/2`,
  `decrunchLr88`). Migrate strike (`rnc1.ts`, `lr88.ts`) and methanoid
  (`ancient-decompress.ts`).
- **0d.** Backport strike's `dataHunks`/`resolveHunkRelativeGlobal` into
  `@seer-project/amiga`'s `hunk.ts`. Migrate strike: add the package dep,
  delete `tools/shared/amiga-hunk.ts` + its test (keep `hunk-wrapper.ts`,
  game-specific).

## Phase 1 — `@seer-project/snes` (L, highest value/risk)

Reconcile before extracting: base = ceres for all six files (chronotrigger
contributed no unique fixes). Split `snes-dsp.ts` into hardware
(`envelope.ts`) vs. AKAO-driver pitch tables (`akao-pitch.ts`, stays in each
consumer). Strip driver references from `echo.ts`/`spc700-cpu.ts` doc
comments. Watch the one real behavioural delta: chronotrigger's DSP treats
GAIN-mode voices as flat volume and ignores PMON where ceres implements
both — capture golden PCM per game before migrating, don't silently pick a
behaviour.

Package layout: `spc700-cpu.ts`, `spc700-dsp.ts`, `brr.ts`, `envelope.ts`,
`echo.ts`, `ppu.ts`. Depends on `@seer-project/audio-dsp` for
`resampleLooped`. Migrate ceres → chronotrigger → strike, each its own PR,
each verified against golden PCM/tile-decode fixtures.

Follow-on trigger fired but deferred to Phase 5: `@seer-project/akao`
(chronotrigger is now a second AKAOSNES consumer, but `akao-spc-render.ts`
has diverged ~1,500 lines and needs its own reconciliation pass).

## Phase 2 — `@seer-project/playstation` (L, parallel with Phase 1)

Name it `playstation`, not `psx`: valkyrie's PSP ATRAC3+/PSMF demux code is
real; there's no generic PS2 content (see the ground-truth corrections
below). Layout: `cd/sector.ts` (raw CD sector/CD-XA subheader primitives,
BCD/MSF/LBA math, `RawCdReader`/`PlainSectorReader`), `cd/iso9660.ts` (one
directory walker parameterised over any `DiscReader`, replacing valkyrie's
2352-byte-stride and PSP's 2048-byte-stride copies), `cd/cue-sheet.ts`
(`.cue`/`.bin` parsing), `psx/{tim,str-xa,lzs,spu-reverb}.ts`, `psp/
atrac3p.ts`. Node-only disc/file I/O behind `./node`. Excluded
(game-specific, stays put): Parasite Eve's `psx-actor-*`, VP2's `ps2-fmv.ts`
(a game-specific cipher layer, not a PS2 format — see corrections),
`psx-slz.ts`, `psx-vp-*`, `psx-tile-scene.ts`, `psp-ge-vertex.ts`.

Migrated: valkyrie (most surface) → parasite → siren (two `lzs.ts` copies
unified onto one API, plus `isLzsCompressed`) → middilgard (`cue-bin.ts`).

### Ground truth corrections found while building this phase

| Plan claim | What the code actually shows |
|---|---|
| `cd/{sector,cue,iso9660,audio}.ts` — one ISO9660 walker plus one combined audio/cue file | The ISO9660 directory-record walk really is one shared, parameterizable piece (`cd/iso9660.ts`). But `.cue`/`.bin` parsing (`cd/cue-sheet.ts`) is a genuinely different concern — track layout + audio extraction, not directory walking — that only shares low-level sync/BCD/MSF math with the CD-XA sector code, which now lives in `cd/sector.ts` and both other files import from. Three files, not four, and no separate `audio.ts` — audio decode/WAV-writing folded into `cue-sheet.ts`. |
| Parasite has "a second (drifted) copy" of valkyrie's PSP ATRAC3+/PSMF code | False on inspection — `grep` for atrac3/psmf in parasite only hits one archive format's magic-byte type tag, never a reimplementation. `psp/atrac3p.ts` is a straight move, no merge. |
| TIM merges parasite's parse core with valkyrie's multi-CLUT-row form | The two `TimImage` types collide (different shapes: a flattened-RGBA result vs. a still-packed scan record) and, more importantly, their BGR555->RGB channel scaling **actually differs** (`<<3` vs. `round(*255/31)`), each independently verified against a different real game's rendered output. Kept as two separate, fully independent decode pipelines (`TimRecord`/`tryParseTim`/`decodeTimToRGBA` vs. `TimImage`/`parseTim`/`parseTimIndexed`) rather than merged — same category of risk as Phase 1's GAIN/PMON divergence. |
| — (not previously flagged) | `ps2-fmv.ts`'s `FMV_KEY64`/`FMV_CTR_BASE` are VP2's own hard-coded obfuscation-cipher constants, not a PS2 hardware/SDK format — excluded from scope entirely rather than migrated, unlike the plan's original assumption that it just needed a home. |

Follow-on: none fired. `the3rdbirthday`'s PSMF-type detection in
`fsd-archive.ts` is a plausible future *consumer* of `psp/atrac3p.ts` (not a
second copy to reconcile).

## Phase 3 — `@seer-project/gltf` + `@seer-project/gpu-textures` (M, parallel)

Split by dependency profile:
- **`gltf`** (browser-safe, zero deps): chimera's `gltf-builder.ts` (ahead of
  legion's) + `gltf-reader.ts` + `mesh-shape-classifier.ts` (depends on the
  reader, so it lives here rather than in `engine-3d`). "Pipeline-side
  counterpart to `engine-3d`'s runtime loader."
- **`gpu-textures`** (isomorphic, ships WASM): chimera's `bc.ts` (real BC7,
  ahead of legion's approximation), `swizzle.ts`, `astc.ts` + `.wasm`,
  `zstd.ts` + `.wasm` (legion only). Needs a genuinely new build step to copy
  non-TS WASM/JS assets into `dist/` — no existing package does this yet.
  Verify `zstd.wasm`'s license before publishing.
- lucina's `polygon-model.ts` validator → `engine-3d/src/polygon-validate.ts`
  (pure, matches `PolygonModel`); its writer/stats stay in lucina
  (process-global, uses `pipeline.writeJson`).

Migrate chimera first (the base) then legion for both.

### Ground truth corrections found while building this phase

| Plan claim | What the code actually shows |
|---|---|
| `gltf` is "browser-safe, zero deps" | `gltf-builder.ts`'s `assembleGLB` used Node's `Buffer` for the final GLB pack, and `gltf-reader.ts`'s `parseGLB` used `Buffer` for its JSON-chunk decode — neither was actually browser-safe as shipped. Rewrote both with `TextEncoder`/`TextDecoder`/`DataView` (verified byte-identical output against the original via a golden-hash comparison across five representative inputs, including Unicode names and odd-byte-length padding). `gltf-reader.ts`'s `readImage`/`readBaseColorImage` are also not zero-dep at all — they import `pngjs`. Split those two functions behind a `./node` subpath, the same shape as `@seer-project/playstation`, rather than accepting "zero deps" as true. |
| lucina's `polygon-model.ts` validator "matches `PolygonModel`" | False on inspection — `engine-3d`'s existing `PolygonModel` carries `edges`/`typeTag` fields the validator has no use for, and a narrower `stats: {vertices,triangles}` shape than `PolygonModel.stats: Record<string,unknown>`. Ported with its own `PolygonObject` type in `polygon-validate.ts` rather than forcing it onto `PolygonModel` — same category of deliberate non-merge as Phase 2's `TimImage`/`TimRecord` split. `describeIssues` moved alongside `validatePolygonObjects`/`hasIssues` (pure, tightly coupled to the same `PolygonModelIssues` type); the impure `writePolygonModel`/`reportPolygonStats`/`resetPolygonStats`/`tally` stay in lucina as planned. |
| `gpu-textures` "needs a genuinely new build step to copy non-TS WASM/JS assets into `dist/`" | Turned out to be unnecessary. Both `astc-decoder.js`/`astc.wasm` (chimera/legion) and legion's `zstd.ts`/`zstd.wasm` are, byte-for-byte, vendored copies of real, already-published npm packages — `@tootallnate/astc-wasm` and `@tootallnate/zstd-wasm` (both MIT, zero deps, from the same maintainer, confirmed via `npm pack` + `diff`/`sha256sum` against the vendored files). `astc.ts`/`zstd.ts` now depend on those packages directly instead of vendoring, and resolve their bundled `.wasm` file via `createRequire(...).resolve()` (not `import.meta.resolve()`, which Vite's SSR module transform rewrites to a non-functional stub — this broke under Vitest until switched) rather than shipping any `.wasm` file of our own. This also fully resolves the "verify `zstd.wasm`'s license" flag below — the vendored blob of uncertain provenance is gone. |
| `swizzle.ts`'s block-linear algorithm provenance | Not previously flagged as a licensing question, but it should have been alongside the SNES entry: the file's own doc comment says it's "ported from the astral-extractor reference (which itself derives from Ryujinx / aboood40091's BNTX-Extractor)" — no LICENSE file for either upstream project was found in this repository's history. Added to `THIRD-PARTY-LICENSES.md` as a second "needs review before publishing" entry, separate from the SNES one. |

Migration order (chimera then legion for both packages, lucina for
`polygon-validate.ts`) confirmed correct — no changes to that sequencing.

## Phase 4 — extend `gfx`/`arcade`; new `dos` (S–M, parallel)

- **gfx**: crawl's CGA/Tandy `packed-pixel.ts` (crawl adopts `@seer-project/gfx`
  in the same PR — it currently has a pre-package local planar copy too);
  drakkhen's polygon-fill/line-draw rasterizer as `raster.ts`; strike's
  Genesis/MD VDP tile decoder as `megadrive-vdp.ts`; `expandVga6` added to
  `palette.ts`'s `ColorWordFormat`.
- **arcade**: kolbold's OKI MSM6295/uPD7759/QSound chip decoders (QSound's
  1,076-line file splits into `capcom/qsound.ts` chip vs.
  `capcom/qsound-driver.ts` Z80 table walkers); kolbold's Sega System 16
  tile/sprite decoder as `sega/system16-gfx.ts`. Migrate kolbold (adds the
  package for the first time) then strike (MD VDP → gfx).
- **dos** (new, browser-safe): powermonger's `exepack.ts` + generic LZHUF
  core from `huffman-huf.ts` (the `.HUF` container and palette table stay
  game-specific). `pipeline/src/lzexe.ts` stays put for now; note the split
  in `dos`'s README.

Migrated: gfx → crawl, drakkhen, strike (parallel, non-overlapping files).
arcade → kolbold (first-time adoption). dos (new package) → powermonger.

### Ground truth corrections found while building this phase

| Plan claim | What the code actually shows |
|---|---|
| crawl "currently has a pre-package local planar copy too" (singular) | Actually three distinct things in `amiga-planar.ts`: a Black-Crypt-specific `decodePlanar`/`decodeMaskedPlanar` pair (fixed tight-stride, EHB-specific — correctly stays in crawl), a generic `decodePlanarPlaneMajor`/`decodePlanarRowInterleaved` pair that really did duplicate `@seer-project/gfx`'s existing config-driven `decodePlanar` (deleted, call sites converted), and `packed-pixel.ts`'s unrelated chunky-pixel decoders (a distinct format, not planar at all, that only borrowed the same return-shape type). Migration also caught one call site (`wizardry6/decode-ega-screen.ts`) the initial grep pass missed — found by `tsc --noEmit`, not by inspection. |
| drakkhen has "a polygon-fill/line-draw rasterizer" (singular) | Two independent copies of the same scanline-fill + Bresenham-line algorithm exist in drakkhen already — one for an indexed pixel buffer (`vector.ts`), one for an RGB canvas (`map-render.ts`). The new `gfx/raster.ts` had to be written generic enough (parameterized over a pixel-write callback) for both call sites to collapse onto it, not just relocate one copy. Also surfaced: `gfx`'s existing `decodePlanar` has a narrower width contract than crawl's originals (requires `width % 8 === 0`; crawl's handled arbitrary widths) — doesn't bite any real corpus data today, but is a latent behavioral narrowing worth documenting for a future consumer with a non-multiple-of-8 width. |
| `expandVga6` → `palette.ts`'s `ColorWordFormat` | Doesn't literally fit — `ColorWordFormat` is a packed-word abstraction (`expandColorWord(word, format)`); VGA's 6-bit-per-channel DAC format has no packed-word representation (each channel is a separate byte). Added as its own standalone export instead of a new union member. Powermonger's `dosvga-palette.ts` migration onto it was deliberately deferred out of the `gfx` migration's scope (only crawl/drakkhen/strike were named) and picked up later by the `dos` package migration, since that agent was already touching powermonger. |
| QSound "splits into `capcom/qsound.ts` chip vs. `capcom/qsound-driver.ts` Z80 table walkers" | True, but the driver half is much bigger than "table walkers" suggests — confirmed boundary is exactly lines 1–121 (chip: sample decode + register map) vs. 122–1077 (driver: note tables, envelope dispatch, and a full CPS2 sequence/track/instrument/pitch-bend grammar — a complete synth/sequencer format, not just table-walking). The two halves need zero imports from each other, contrary to the plan's hedge that the driver might call back into chip-level decode functions. |
| `THIRD-PARTY-LICENSES.md` already covers MAME provenance for `arcade/sh2.ts` | It does not — grepped and confirmed zero MAME/FBNeo/BSD entries exist at all. This was already a gap before Phase 4; the new OKI/uPD7759/QSound/System16 files (all MAME-device ports) widen it. Needs one combined "MAME arcade chip/video emulation (BSD-3-Clause)" entry covering `sh2.ts` (FBNeo) plus the five new files — see `THIRD-PARTY-LICENSES.md`, now added. |
| `exepack.ts` needs Buffer→browser-safe porting | False — already 100% `Uint8Array`-based (only import is `@seer-project/core`'s `r16`), zero porting needed, just a doc-comment genericization and a move. |
| "Needs a genuinely new build step" concern (implicitly, for any new package with non-TS assets) | Didn't apply here either — `dos` ships pure TS, no WASM/binary assets, no `types: ["node"]` needed (neither file touches a `node:` builtin). |

## Phase 5 — single-consumer platform packages (defer until time or a 2nd consumer)

- **`@seer-project/3ds`** (M–L): lucina's `ctpk.ts`, `ctr-texture.ts`, `lz.ts`,
  `bcstm.ts`, `bch.ts`, `cgfx.ts` browser-safe; `container.ts`/`crypto.ts`
  behind `./node`. `echoes.ts` (game-specific CIA) and `mtf-arc.ts` (MT
  Framework engine, single consumer) stay in lucina. **Done** — was
  deferred once (lucina had in-progress, uncommitted user edits directly in
  this exact surface), revisited once that work settled and extracted
  against the then-current on-disk state rather than the earlier research
  snapshot.
- **`@seer-project/cri`** (M): vanille's `cpk.ts`, `adx.ts`, `acb.ts`,
  `awb.ts` — port Buffer-based APIs to `Uint8Array`/`DataView` first so the
  barrel is browser-safe. **Done.**
- **`@seer-project/akao`** (L → actually S): reconcile ceres's
  `tools/{ffiv,ffv,ffvi}/akao-*.ts` with chronotrigger's
  `tools/chronotrigger/akao-*.ts`; the ~1,500-line `akao-spc-render.ts`
  divergence is the real work. Depends on Phase 1. **Done, but descoped** —
  see the ground-truth correction below; the "L, reconcile the divergence"
  framing was wrong, and the only extractable piece was small.
- Pure PP20/RNC1 decoders into `@seer-project/amiga` (S/M), replacing the
  Phase 0c `ancient` shell-outs once a browser consumer needs them. Still
  deferred — no browser consumer has triggered this yet.

**Not extracting** (record in `docs/common-tooling-candidates.md`): siren's
`ff9/mips.ts` (FF9-shaped bounded runner, not a CPU core — a real R3000 core
would need a full FBNeo/MAME-style port, not a generalisation of this file);
ffv/ffvi LZSS (different codecs); `psx-actor-*`; `ps2-fmv.ts`; `psx-slz.ts`;
`hunk-wrapper.ts`; `echoes.ts`; `mtf-arc.ts`; powermonger's `.HUF` container
and palette table; ceres's/chronotrigger's per-game `akao-seq.ts`/
`akao-samples.ts`/`akao-spc-render.ts`/`akao-render.ts`/`akao-export.ts`
files across ffiv/ffv/ffvi/chronotrigger (each independently
reverse-engineered against that game's own compiled sound-driver binary —
every pairwise diff is 85%+ different, not a mergeable common-base-plus-delta;
see the Phase 5 ground-truth correction below). (This list spans two
different audit scopes — `docs/common-tooling-candidates.md`'s own six
sibling projects, and the broader set this plan covers — so not every item
above literally belongs in that file; treat this list as the authoritative
"why we didn't extract this" record regardless of which doc it's cross-filed
in.)

### Ground truth corrections found while building this phase

| Plan claim | What the code actually shows |
|---|---|
| `@seer-project/akao` — "reconcile ceres's per-game akao files with chronotrigger's; the ~1,500-line `akao-spc-render.ts` divergence is the real work" | Wrong framing. Every pairwise diff between the per-game `akao-seq.ts`/`akao-samples.ts`/`akao-spc-render.ts`/`akao-render.ts`/`akao-export.ts` files (ffiv/ffv/ffvi/chronotrigger) is 85%+ different — not a stable base plus a mergeable delta (Phase 1's GAIN/PMON shape), but four independently-disassembled sound-driver harnesses that happen to share a technique. FFIV even uses a different driver major version (V1) than FFV/FFVI/chronotrigger (V4). **The only genuinely shared piece was `tools/shared/akao-dsp.ts` (119 lines, byte-identical in both repos)** — `PITCH_TABLE`, `PITCH_UNITY`, `noteToResampleStep`, `decodeBrrBlob`. That's been extracted into `@seer-project/snes` (not a separate `@seer-project/akao` package — 119 lines didn't warrant one, and it's tightly coupled to `@seer-project/snes`'s `decodeBrrBlock`), and both consumers migrated. The per-game files are correctly left alone, permanently, not "deferred" — see the updated "Not extracting" list above. |
| `@seer-project/cri` — files are `cpk.ts`/`adx.ts`/`acb.ts`/`awb.ts`, ~4-file scope, "port Buffer-based APIs" (implying all four need porting) | The CPK file is actually named `cri-cpk.ts` in vanille and is also the shared `@UTF`-table engine `acb.ts`/`awb.ts` sit on top of, not a peer of equal size. Only `cri-cpk.ts` (renamed `cpk.ts` in the package) had real `Buffer` depth; `adx.ts` was already 100% browser-safe, `awb.ts` needed two wrapper-line deletions, `acb.ts` needed two signature relaxations. The real size of the job was the downstream ripple inside vanille — 10 more consumer files beyond the 4 core ones, some with their own `Buffer`-returning interfaces layered on top (fixed with a single `Buffer.from(...)` wrap at each of 6 call sites rather than relaxing those interfaces, which would have pointlessly rippled into unrelated Buffer-based decoders). `CriPakTools` (the reference implementation `decompressCrilayla` traces to) has no LICENSE file at all and traces its own provenance to unlicensed Xentax-forum posts — flagged in `THIRD-PARTY-LICENSES.md` alongside the SNES/swizzle entries. |
| `@seer-project/3ds` — "Buffer/`le.ts` cleanup" needed | Stale — `le.ts` and all six browser-safe target files (`ctpk.ts`, `ctr-texture.ts`, `lz.ts`, `bcstm.ts`, `bch.ts`, `cgfx.ts`) are already Buffer-free; nothing to clean up. `container.ts`/`crypto.ts` genuinely do need Node (real `node:fs`/`node:crypto`), confirming that part of the plan. |
| `bch.ts`/`cgfx.ts`'s matrix-math dedup (flagged, not yet acted on, in an earlier pass of this table) | Held at extraction time — the block (`matMul`/`matToQuaternion`/`mat4Invert`/etc.) really was byte-identical and is now consolidated into `packages/3ds/src/mat4-ctr.ts`. **Except `accumulateBone`**, which turned out to have genuinely diverged: `bch.ts`'s version has an undefined-bone guard and a bounds/self-reference check before recursing that `cgfx.ts`'s lacks. Kept as two separate, unexported, per-file implementations rather than forced together — same "don't silently pick a winner" policy as Phase 1's GAIN/PMON split and Phase 2's TimImage/TimRecord split. A second, previously-unflagged barrel collision also surfaced: both files exported `sampleSkeletalAnimation` under the same name — resolved by renaming to `sampleBchSkeletalAnimation`/`sampleCgfxSkeletalAnimation`. |
| Extraction scope was "lucina's `ctpk.ts`, `ctr-texture.ts`, `lz.ts`, `bcstm.ts`, `bch.ts`, `cgfx.ts`" | An extra, previously-unflagged consumer surface existed: six files (`bfnt.ts`, `fe-arc.ts`, `fs-archive.ts`, `g1m.ts`, `g1t.ts`, `mtf-mod.ts`) imported `u16At`/`u32At` directly from `./le.ts`, not through any of the six named target files — missed by the migration's first grep pass, caught only by `tsc --noEmit` after `le.ts` was deleted. A dedicated second-round grep (every exported symbol from every migrated module, across all of lucina) afterward found no further gaps. |
| Provenance not previously checked | `ctpk.ts`/`ctr-texture.ts`/`lz.ts`'s doc comments cite porting from SciresM/FEAT's `ctpktool` and a DSDecmp reference implementation; `bch.ts`/`cgfx.ts`'s doc comments explicitly state "Ported from Ohana3DS-Rebirth's `Models/BCH.cs`/`Models/CGFX.cs` (gdkchan)." Both added to `THIRD-PARTY-LICENSES.md` as "needs review before publishing," matching the SNES/MAME/CRI/swizzle pattern. `bcstm.ts`, `le.ts`, `container.ts`, `crypto.ts` cite no specific ported implementation and likely don't need the same flag.

## Sequencing

```
Phase 0  (0a atlas | 0b wav | 0c ancient | 0d hunk helpers)      all parallel, ~1 PR each
Phase 1  snes: reconcile → package → ceres → chronotrigger → strike
Phase 2  playstation: package → valkyrie → parasite → siren → middilgard     (parallel with Phase 1)
Phase 3  gltf → (shape classifier) ; gpu-textures ; polygon-validate → chimera → legion   (parallel with 1/2)
Phase 4  gfx ext | arcade ext | dos                                (parallel; 4a's crawl PR should follow 0a's crawl PR)   — DONE
Phase 5  3ds | cri | akao (after Phase 1) | pure PP20/RNC1   — 3ds DONE, cri DONE, akao DONE (descoped to a snes addition), pure PP20/RNC1 still deferred (no trigger)
```

Hard dependencies: 0b before any viewer WAV migration; SNES reconciliation
before the SNES package; `gltf` before the shape classifier; Phase 1 before
`akao`. Everything else is independent. Each sibling migration is its own
PR in that repo; originals are deleted in the same PR that adds the `file:`
dependency, so nothing drifts again.

## Effort sizing

| Item | Size | Notes |
|---|---|---|
| 0a atlas → core | S | 3 consumers, mechanical key rename in crawl |
| 0b wav → core/pipeline | S | 13 sites total; migrate 5 now |
| 0c ancient → pipeline | S | pure detection + shell-out |
| 0d hunk helpers → amiga | S | strike adopts `amiga` |
| 1 snes | **L** | AKAO split, GAIN/PMON golden verification, 3 migrations, licensing records |
| 2 playstation | **L** | TIM API merge, ISO9660 abstraction, 4 migrations |
| 3a gltf (+ shape classifier) | M | chimera base, 2 migrations |
| 3b gpu-textures | M | WASM packaging/build step, license check on zstd.wasm |
| 3c polygon-validate | S | |
| 4a gfx ext | S–M | crawl also adopts `gfx` |
| 4b arcade ext | S–M | qsound driver/chip split |
| 4c dos | S–M | |
| 5a 3ds | M–L | Buffer/`le.ts` cleanup, node subpath |
| 5b cri | M | Buffer → DataView |
| 5c akao | L | separate reconciliation |
| ff9 mips | — | not extracting |

## Testing strategy

1. Reference-derived synthetic tests move with the code (ceres's SNES tests
   are already hand-computed from snes_spc/Mesen2 semantics — keep that bar).
2. Golden outputs captured pre-migration in each consumer (PCM hashes for
   SNES/AKAO songs, PNG/RGBA hashes for TIM/BC/CTR decodes, GLB byte hashes
   for builders), asserted post-migration; re-baseline only with a written
   reason.
3. Corpus-gated tests stay in game repos (`describe.skipIf(!existsSync(...))`);
   packages must be fully testable with no ROMs present.
4. Browser-safety check for every browser-safe package: a vitest run under
   the `node` env with `node:` builtins stubbed to throw, catching the
   eager-`readFileSync` class of bug chimera already hit.
5. Root `npm test` runs `build:packages` first; sibling CI runs
   `npm run build-assets` end-to-end at least once per migration PR.

## Critical files referenced during planning

- `ceres/tools/shared/snes-dsp.ts` — must be split (hardware envelope vs.
  AKAO `noteToResampleStep`) before `@seer-project/snes` exists.
- `ceres/tools/shared/spc700-dsp.ts` — base copy of the S-DSP engine; its
  GAIN/PMON behaviour is the one behavioural delta chronotrigger absorbs.
- `chimera/src/data/formats/gltf-builder.ts` (with sibling `bc.ts`,
  `swizzle.ts`, `astc.ts`, `gltf-reader.ts`) — the ahead-of-legion base for
  `gltf` and `gpu-textures`.
- `packages/pipeline/src/io.ts` — existing `writeWav`/`writePNG` that the
  WAV and `ancient` additions extend.
- `packages/tsconfig.build.base.json` — the build/emit conventions every new
  package must follow.
