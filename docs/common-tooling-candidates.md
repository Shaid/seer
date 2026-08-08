# Common Tooling Candidates

A cross-repo DRY audit of the six sibling game-reimplementation projects that
consume `@seer-project/*` — `crawl` (Black Crypt / EOTB / Lands of Lore), `wyrm`
(Dune / KGB), `nicodemus` (Phantasie I–III), `sorcery` (Wizardry 6),
`middilgard` (War in Middle Earth / Spirit / Vengeance / Conan / Legend), and
`strike` (Desert / Jungle / Urban Strike).

**Question asked:** what is currently duplicated — fully or in spirit — across
two or more of those repos that could reasonably become shared `@seer-project/*`
tooling instead?

**Method.** Read every `tools/shared/`, `tools/*.ts` entrypoint, `src/`
format decoder and `src/data`/`src/engine` file across the six repos, plus
their project configs, test suites and `docs/` trees, and diffed
same-named/same-shaped implementations against each other and against the
`@seer-project/*` package sources. Every claim below cites a real path; where a
verdict says "identical" it means an actual `diff` was run.

**Companion docs.** This is a breadth review of everything *except* the asset
viewers — the per-repo `tools/viewer/` comparison lives in
`docs/viewer-tooling-review.md`. Read alongside `docs/framework-plan.md`
(roadmap), `docs/weaknesses.md` (gaps found from the `sorcery` side), and
`middilgard/docs/seer-migration.md` (what one consumer already migrated and
deliberately did not). §16 below states what this survey confirms,
contradicts, or adds to those.

> **Status update (2026-08-03).** Several items below are now resolved,
> acted on directly rather than left as candidates: §7 (WAV writer) —
> `writeWav()` added to `@seer-project/pipeline` (commit `efb3cca`), consolidating
> the writers this section names, including middilgard's. §13b (SMUS engine)
> — fully consolidated onto `@seer-project/smus`; verifying it properly surfaced 5
> real behavioral bugs in the package itself, since fixed (`4acde27`). §13c
> (middilgard's hand-rolled IFF walking) and §13d (`@seer-project/pipeline` adoption,
> "execute seer-migration.md Step 9") — both done for middilgard (`68ce3b2`).
> §13e (verbatim package test copies) — middilgard's three stale copies
> deleted; not verified for the other repos this section names. `@seer-project/engine`
> was also renamed to `@seer-project/engine-2d` since this was written (ahead of a
> future `@seer-project/engine-3d` — see `docs/engine-3d-proposal.md`). Everything
> else below is left as-written, not re-verified against current state.
> **A seventh consumer joined since this survey was written**: `ceres`
> (SNES/FFVI-V-IV, not one of the original six). It independently rediscovered
> §13a/§13b's core finding on its own ("don't build a third player, `@seer-project/tracker`
> and `@seer-project/smus` already do this") and adds a forward-looking architecture
> note for SNES audio, not yet RE'd anywhere — see §19.

---

## Executive summary

**16 real candidates**, of which 5 are not "extract new code" at all but
"adopt the package that already exists". Three are false positives worth
naming so nobody re-proposes them. A handful of small findings that are doc
or template fixes rather than packages.

The single most important structural observation is not any individual
candidate:

> **Five of the six repos have an empty `src/engine/` and a placeholder
> `src/main.ts`.** `crawl/src/main.ts`, `wyrm/src/main.ts`,
> `nicodemus/src/main.ts`, `sorcery/src/main.ts` and `strike/src/main.ts` are
> byte-identical scaffolds whose only `@seer-project/engine` import is `createGame`,
> with `onInit`/`onUpdate` still `// TODO`. Only `middilgard` has a real
> PixiJS runtime. Meanwhile `@seer-project/engine` — `Camera`, `InputManager`,
> `DisplayMode`, `Game`, `pixi-helpers` — is the largest browser-side package
> and has exactly one real consumer.
>
> The code all six repos actually write every day is the **offline pipeline
> and the format decoders**, and that is precisely where the framework has
> the least shared surface: there is no graphics package, no canonical asset
> schema, no Amiga/retro-platform package, and no test-harness package.

**Top three by impact:**

1. **§1 — Retro bitmap graphics primitives (`@seer-project/gfx`).** Bitplane/chunky
   pixel decode, 12-bit Amiga colour expansion, indices→RGBA, atlas blit and
   shelf-packing exist in *all six repos*, in at least six independently
   written implementations, with four mutually incompatible `indicesToRGBA`
   signatures. `strike/tools/shared/amiga-planar.ts`'s own docblock admits it
   copied `crawl`'s. This is the largest, cleanest, lowest-risk extraction
   available.
2. **§2 — Canonical asset-output types (`@seer-project/core`).** `AtlasMeta`,
   `PaletteData` and `ManifestEntry` are redeclared 11+ times across the six
   repos — twice *within* `crawl` and `strike` alone — and the
   `create-seer` templates still ship two mutually contradictory `AtlasMeta`
   definitions. This is the root cause of `weaknesses.md` §6 and it has now
   propagated into six repos.
3. **§9/§10 — An Amiga/retro-platform package (`@seer-project/amiga`).** AmigaOS
   HUNK executable parsing exists in **seven** independent implementations
   across four repos; the UAE/Amiberry `.uss` savestate reader was
   reverse-engineered twice, independently, with divergent (both correct,
   differently framed) chunk models. Both are generic, publicly documented
   formats with zero game-specific content — textbook library material.

---

## 1. Retro bitmap graphics primitives

**What it is.** Decode planar (bitplane) or chunky (packed-pixel) bitmap data
into an 8-bit palette-index buffer; expand a hardware colour word into 8-bit
RGB; convert indices + palette → RGBA with a transparency rule; blit cells
into an atlas. This is the first thing every one of these projects writes and
the last thing any of them stops using.

**Evidence.** Six independent implementations of the same core loop:

| Repo | Path | Layouts covered |
|---|---|---|
| crawl | `crawl/tools/shared/amiga-planar.ts` (157 L) | sequential-planar, masked-planar, EHB palette, `amiga12ToRGB`, `indicesToRGBA`, `blitRGBA` |
| sorcery | `sorcery/tools/shared/amiga-planar.ts` (175 L) | plane-major (with `planeStride`), row-interleaved, greyscale + palette RGBA, mono glyph sheets |
| sorcery | `sorcery/tools/shared/packed-pixel.ts` (117 L) | linear chunky N-bpp, CGA bank-interleaved, `indicesToRGBAWithTransparency` |
| strike | `strike/tools/shared/amiga-planar.ts` (282 L) | row-interleaved, sequential-planar, plane-major-masked, `amiga12ToRGB`, `amiga24ToRGB`, `indicesToRGBA`, `blitRGBA`, `blitIndices`, ByteRun1 |
| wyrm | `wyrm/tools/kgb/planar.ts` (116 L) | line-interleaved with word-aligned `bytesPerRow`, `parsePalette` (12-bit), `toRgba` |
| nicodemus | `nicodemus/src/assets/formats/bitplane.ts` (118 L) + `palette.ts` (94 L) | unified planar/ST-word-interleaved via an offset formula, `cropIndices`, ST + Amiga-to-ST palette lookups, `indicesToRGBA` |
| middilgard | `middilgard/src/assets/formats/imag.ts:434-500`, `palette.ts:29-31` | row-interleaved planar inline in the IMAG decoder; the same `((word>>8)&0xf)*17` expansion |

Also in this family: `sorcery/tools/shared/snes-ppu.ts` (126 L) and
`strike/tools/shared/snes-ppu.ts` (73 L) — strike's six exports are a
**strict by-name subset** of sorcery's nine, and sorcery's header says it was
"Ported from the `strike` project's `tools/shared/snes-ppu.ts`". Same for
`strike/tools/shared/genesis-vdp.ts` (Megadrive 4bpp tiles + CRAM), which is
the Genesis analogue of the same three operations.

And atlas packing: `sorcery/tools/shared/atlas-pack.ts`'s `shelfPack()` is
explicitly written as generic ("Reuse this instead of writing a new packer per
game") and used by 7 sorcery decoders — while `wyrm/tools/dune/build-assets.ts:86`
(`packSprites`), `wyrm/tools/dune/build-game-order.ts:41`,
`wyrm/tools/kgb/build-assets.ts:60` (`packAtlas`),
`nicodemus/tools/phantasie/build-assets.ts:85` (`packGridAtlas`) and
`strike/tools/junglestrike/atlas-pack.ts` each hand-roll their own.

**Assessment: truly duplicated, with a genuinely divergent API surface.**
The *algorithms* are the same handful of loops — crawl's `decodePlanar` and
strike's `decodeSequentialPlanar` are byte-for-byte the same function, and
strike's docblock says so outright:

> "Kept here (duplicated from crawl rather than imported across projects) so
> this module is self-contained…" — `strike/tools/shared/amiga-planar.ts:97-101`

The *signatures* are where they diverge, and it's a real design question, not
accidental drift. Four incompatible `indicesToRGBA` shapes exist:

- crawl / strike: `(indices, palette: number[], { mask?, transparentIndex0? })` — flat RGB triplet array
- nicodemus: `(indices, palette: RGB[], transparentIndexZero = false)`
- sorcery: `indicesToPaletteRGBA(img: PlanarImage, palette: RGB[])` + `indicesToRGBAWithTransparency(img, palette, transparentIndex)`
- wyrm: `toRgba(bitmap: IndexedBitmap, palette: RgbColor[], transparentIndex = -1)`

Two container shapes also compete: a bare `Uint8Array` of indices (crawl,
strike, nicodemus) vs. a `{indices, width, height}` struct (sorcery
`PlanarImage`, wyrm `IndexedBitmap`).

**Quality.** High, uniformly. Every one of these files carries a substantive
docblock citing the `docs/` section and the verification that confirmed the
layout (strike's cites a `BLTSIZE` register write; sorcery's cites an
`adda.l #0x2000,a1` in the game's own blit loop). nicodemus's unified
`bitplaneByteOffset()` formula is the most elegant of the set — it collapses
Amiga-contiguous and Atari-ST-word-interleaved into one parameterised
expression. crawl's and strike's inline corrections ("An earlier copy of this
function used that layout and produced scrambled output") are exactly the kind
of knowledge that should not live in six places.

Test coverage is uneven: nicodemus (`__tests__/bitplane.test.ts`,
`palette.test.ts`), sorcery (`__tests__/packed-pixel.test.ts`) and strike
(`__tests__/amiga-planar.test.ts`, but the whole suite is
`describe.skipIf(!dataDirAvailable)` — no unconditional coverage) have tests;
crawl and wyrm's planar modules have none.

**Verdict: extract now. New package — `@seer-project/gfx`.** Not `@seer-project/core` (which
is meant to stay tiny and dependency-free) and not `@seer-project/pipeline` (this is
pure computation with no `node:fs`, and the browser-side viewers want it too —
`middilgard/tools/viewer/components/palette-editor.ts` does index-remapping in
the browser). Browser-safe, zero-dependency, depends only on `@seer-project/core`.

Suggested surface, chosen as the union of what the six already need:

```
decodePlanar(data, { width, height, planes, layout, offset?, planeStride?, rowBytes? })
  layout: 'plane-major' | 'row-interleaved' | 'word-interleaved'
decodePacked(data, { width, height, bpp, offset?, bankGap? })   // chunky/CGA
decodeSnesTile4bpp / 2bpp, decodeGenesisTile4bpp
expandColorWord(word, format)   // 'amiga12' | 'amiga24' | 'bgr555' | 'st444'
indicesToRGBA(indices, palette, { transparentIndex?: number | null, mask? })
blitRGBA / blitIndices / cropIndices
shelfPack(items, maxWidth, padding)
```

The `transparentIndex?: number | null` shape (rather than a boolean) covers
crawl/strike's index-0 rule, sorcery's max-index rule, wyrm's opt-out, and
nicodemus's default-opaque in one parameter — and is the same fix
`weaknesses.md` §7 recommends for `writeIndexedPNG`.

**Effort/risk.** Medium effort (~500 lines plus tests), low risk. The
migration can be incremental: land the package, port one repo, leave the rest
until they next touch that file. Palette shape needs one decision (flat
`number[]` vs `RGB[]`); a `toFlatPalette()` adapter makes that non-blocking.

---

## 2. Canonical asset-output types

**What it is.** The shapes the pipeline writes and the runtime + viewer read:
a packed-frame atlas, a palette sidecar, and the per-game `manifest.json` row.

**Evidence.** Eleven-plus declarations of three types:

| Type | Declared in |
|---|---|
| `AtlasFrame` / `AtlasMeta` (packed-frames) | `crawl/src/data/GameData.ts:10-23`, `crawl/tools/viewer/shared.ts:1-14`, `strike/src/data/GameData.ts:10-23`, `strike/tools/viewer/shared.ts:1-14`, `wyrm/src/data/GameData.ts:4-17`, `wyrm/tools/viewer/shared.ts:1-15`, `nicodemus/tools/viewer/shared.ts:1-14`, `sorcery/tools/viewer/shared.ts:1-14` |
| `AtlasMeta` (uniform-grid — **the stale template shape**) | `nicodemus/src/data/GameData.ts:5-11`, `sorcery/src/data/GameData.ts:5-11` |
| `PaletteData` / `PaletteColor` | all eight of the packed-frames files above |
| `ManifestEntry` | `crawl/src/data/GameData.ts:36-42`, `crawl/tools/shared/asset-paths.ts:13-19`, `strike/src/data/GameData.ts:36-42`, `sorcery/tools/viewer/shared.ts:26-40` (a **different** shape: `{name, group, png, atlas, palette, sprites}`), `middilgard/tools/shared/manifest-types.ts` (two further game-specific shapes) |

`crawl/src/data/GameData.ts` and `strike/src/data/GameData.ts` are
byte-identical modulo one comment. `crawl/tools/viewer/shared.ts` redeclares
the three types its own `src/data/GameData.ts` already exports — an
*intra*-repo duplication, in both crawl and strike.

**Assessment: truly duplicated, and actively harmful.** Three separate
`manifest.json` schemas now exist for the same concept (crawl/strike's
upsert-by-name row, sorcery's group/atlas/palette row, middilgard's per-format
`ImagManifestEntry`/`FrmlManifestEntry`), which means the viewers can never be
shared even if the rest of the viewer code were.

More concretely, `weaknesses.md` §6's template inconsistency has now shipped
into two more repos: `nicodemus/src/data/GameData.ts` and
`sorcery/src/data/GameData.ts` both still carry the dead uniform-grid
`AtlasMeta` from `GameData.ts.eta`, while every real extractor in those repos
emits packed frames. Neither repo's runtime consumes it, so nothing breaks —
it is just latent wrong-by-default code sitting in two more places.

**Quality.** The types themselves are fine and stable — that's the point.
Nobody has meaningfully improved on them in six copies.

**Verdict: extract now, into `@seer-project/core`.** `weaknesses.md` §5 already
recommends this "once a second or third project needs them". Six do. Ship
`AtlasFrame`, `AtlasMeta`, `PaletteColor`, `PaletteData`, `ManifestEntry` from
`@seer-project/core`, delete the uniform-grid `AtlasMeta` from
`packages/create-seer/templates/src/data/GameData.ts.eta`, and have the
template import instead of redeclare.

**Effort/risk.** Small effort, low risk (types only, no runtime behaviour).
The one judgement call is which `ManifestEntry` wins; crawl/strike's is the
most widely deployed, sorcery's is strictly richer. Shipping the richer one
with optional fields covers both.

---

## 3. Asset output paths + manifest merge + platform index

**What it is.** `assetRoot()`/`assetDir()` (mkdir-on-demand output dirs per
category), `manifestEntry()`, `writeManifest()` (merge-by-name upsert into
`public/assets/<game>/<platform>/manifest.json`), and `writePlatformIndex()`
(the `public/assets/index.json` game/platform switcher feed).

**Evidence.** `crawl/tools/shared/asset-paths.ts` (88 L) and
`strike/tools/shared/asset-paths.ts` (93 L). `diff` is ~30 lines, and all of
it is comments, prettier reflow, and strike having already hoisted `writeJson`
and `ManifestEntry` out to `@seer-project/pipeline` / `src/data/GameData.ts`. Strike's
own header says "Pattern mirrors `../../../crawl/tools/shared/asset-paths.ts`".

The other four repos solve the same problem differently rather than not at
all: `sorcery/tools/viewer/build-manifest.ts` (90 L) rebuilds the manifest by
*scanning the output directory* post-hoc;
`middilgard/tools/shared/build-viewer-assets.ts` (326 L) writes its own;
nicodemus and wyrm write per-game atlas JSON with no manifest layer at all.

**Assessment: crawl↔strike are truly duplicated; the other four are the same
problem with different answers.** The upsert-by-name merge semantics are the
non-obvious part and are identical in both — they exist because multiple
independent extraction stages contribute rows in no fixed order, which is a
framework-level concern, not a game-level one.

**Quality.** Good. Both are small, documented, and correct (both defensively
`try/catch` a corrupt existing manifest and clear rather than crash). Neither
is tested.

**Verdict: extract later — `@seer-project/pipeline`.** Blocked on §2 (it needs a
canonical `ManifestEntry` first) and on deciding whether the
write-as-you-go (crawl/strike) or scan-afterwards (sorcery) model is the
framework's. Once §2 lands this is a ~60-line addition to `io.ts`.

**Effort/risk.** Small effort, low risk, but sequenced behind §2.

---

## 4. Pipeline CLI entrypoint

**What it is.** `tools/extract-game-data.ts` — parse `--game`/`--platform`,
default from `DEFAULT_GAME`, call `runPipeline()`, guard on
`process.argv[1].endsWith(...)`.

**Evidence.** `crawl/tools/extract-game-data.ts`,
`wyrm/tools/extract-game-data.ts`, `nicodemus/tools/extract-game-data.ts` and
`sorcery/tools/extract-game-data.ts` are **byte-identical** (42 lines each,
modulo a trailing newline). `strike/tools/extract-game-data.ts` is the same
file plus a `--assets-only` flag. `middilgard/tools/extract-game-data.ts` is a
352-line hand-rolled orchestrator that does not use `runPipeline` at all.

**Assessment: truly duplicated, and already solved upstream but unused.**
`@seer-project/pipeline` already ships `parseArgs()`, `cmdExtract()`, `cmdDoctor()`
and a `bin/seer.mjs` shim (`packages/pipeline/src/cli.ts:74-88`) that do
exactly this. **No repo invokes it from any npm script** — all six go through
their own `tools/extract-game-data.ts`.

The four `seer.config.ts` files that exist (crawl, wyrm, nicodemus, sorcery)
are consequently **dead config**: they are only read by
`CONFIG_FILENAMES` in `packages/pipeline/src/cli.ts:19`, which nothing calls.
`nicodemus/seer.config.ts`'s own comment concedes it is a hand-maintained
second source of truth ("Keep both in sync when adding a game/platform").
`middilgard` and `strike` deleted theirs, which is arguably correct.

Strike's `--assets-only` is worth noting as a genuine missing feature:
`strike/tools/extract-game-data.ts:41-53` implements it by *deep-cloning the
config and deleting `exportGameData` from every platform*, so `runPipeline`
logs each Stage 1 as "not registered — skipping". That is a hack around
`runPipeline()` having no step selection.

**Quality.** The four identical copies are clean but pointless. Strike's
workaround is well-commented and honest about being a workaround.

**Verdict: extract now — `@seer-project/pipeline`.** Two small changes:
1. Add a `steps?: ('export' | 'assets')[]` option to `runPipeline()`, so
   `--assets-only` stops needing config surgery.
2. Export a `runPipelineCli(configs, argv, { defaultGame })` helper so the
   consumer's `tools/extract-game-data.ts` collapses to three lines — *or*
   resolve the `seer.config.ts` dead-config problem by making the `seer`
   binary the documented entrypoint and deleting `extract-game-data.ts` from
   the template. The second is cleaner but is the bigger decision; the first
   is unblocked today.

**Effort/risk.** Small effort, low risk. Note the sequencing dependency:
whichever way §4 goes determines whether `seer.config.ts` stays in the
`create-seer` scaffold at all.

---

## 5. The `game-config.ts` narrowing header

**What it is.** The ~35-line preamble that re-exports `@seer-project/pipeline`'s
generic helpers, defines locally-narrowed `PlatformConfig`/`GameConfig`
interfaces (`game: GameId` instead of bare `string`), and wraps
`getGameConfig`/`getSupportedPlatforms` with narrowing casts.

**Evidence.** Byte-identical in `crawl/tools/shared/game-config.ts:1-31`,
`wyrm/tools/shared/game-config.ts:1-31`,
`nicodemus/tools/shared/game-config.ts:1-38`,
`sorcery/tools/shared/game-config.ts:1-31`,
`strike/tools/shared/game-config.ts:1-19`, and the trailing
`GAME_PLATFORMS = flattenConfigs(...)` + two wrapper functions block is
identical in all five. (`middilgard/tools/shared/game-config.ts` predates the
seer config shape entirely and uses its own `GamePlatformConfig` with
structured `resFiles` — see `middilgard/docs/seer-migration.md` §4.)

**Assessment: truly duplicated — but this is a *deliberate* cost, not drift.**
`docs/architecture-overview.md` §5 resolves this explicitly ("Decision: option
2" — library stays `string`-typed, consumer narrows locally), and
`docs/boilerplate-guide.md` tells the consumer to keep it. So this is **not** a
proposal to reverse that decision.

What the survey adds is the price tag: option 2 costs ~35 lines of pure
mechanical boilerplate × 5 repos, and it is boilerplate that no consumer has
ever edited. The decision can be kept while the cost is reduced.

**Quality.** Correct and well-explained in the boilerplate guide. Just verbose.

**Verdict: extract later — `@seer-project/pipeline`.** A generic factory keeps
option 2's semantics (library stays identifier-agnostic; consumer owns the
narrowing) while collapsing the boilerplate:

```ts
// @seer-project/pipeline
export function defineNarrowedConfig<G extends string, P extends string>(
  configs: GameConfig[],
): {
  GAME_CONFIGS: NarrowedGameConfig<G, P>[];
  GAME_PLATFORMS: NarrowedPlatformConfig<G, P>[];
  getGameConfig(game: G, platform: P): NarrowedPlatformConfig<G, P> | undefined;
  getSupportedPlatforms(game: G): P[];
};
```

Generics appear once, at the consumer's call site, not throughout the public
API — which is the specific cost §5 rejected option 1 for.

**Effort/risk.** Small effort. Low functional risk, moderate *review* risk:
this touches a documented architectural decision, so it needs an explicit note
in `architecture-overview.md` §5 that the factory is an ergonomic wrapper over
option 2, not a move toward option 1.

---

## 6. PackBits / IFF ByteRun1

**What it is.** The EA IFF-85 byte run-length codec: `c<=127` → `c+1`
literals, `c==128` → no-op, `c>=129` → `257-c` repeats.

**Evidence.** Five implementations, three provably the same algorithm:

- `strike/tools/shared/amiga-planar.ts:39` `byteRun1Decode` — canonical.
- `middilgard/src/assets/formats/imag.ts:65` `packBitsDecompress` — identical
  semantics (`PACKBITS_REPEAT_BASE = 257`), plus an `expectedLength` cap.
- `strike/tools/shared/strike-rle.ts:94` — documented as bespoke "Strike RLE",
  but algebraically identical: `-signed + 1 == 257 - ctrl` for `0x81..0xFF`.
  So strike carries **two copies of PackBits in the same `tools/shared/`
  directory** without realising it.
- `strike/tools/shared/megadrive-tilemap.ts:256` `decodeWordPackBits` — same
  formulas at u16 granularity. Related, not drop-in.
- `wyrm/src/formats/cryo-image.ts:111` `decodeRLE` — same formulas but
  **missing the `0x80` no-op branch**, so `0x80` decodes as 129 repeats
  instead of a skip. A real behavioural difference on one control byte.

A near-miss worth naming so it isn't merged by mistake:
`sorcery/tools/wizardry6/dos-rle.ts:60` and
`nicodemus/src/assets/formats/cmp.ts:116` share `c>=0x80 → 256-c` repeats /
`c` literals — off by one from PackBits in *both* branches. Different codec,
same family.

**Assessment: truly duplicated within the well-known-format subset.**
PackBits is a published spec; there is no reverse-engineering value in each
project owning a copy. The bespoke codecs around it (see §17) are the
opposite.

**Quality.** `strike/tools/shared/strike-rle.ts` is honest that it is a
hypothesis with no byte-verified corpus instance yet; both strike files are
tested. `middilgard`'s is well covered
(`src/assets/formats/__tests__/imag.test.ts:57-108`) but builds a `number[]`
and converts, which is slow on 32 KB screens. `wyrm`'s is undocumented,
untested on the codec path, and behaviourally divergent.

**Verdict: extract now, alongside §1 in `@seer-project/gfx`** (PackBits is
overwhelmingly used for bitmap payloads here; a separate `@seer-project/codec`
package for one function is not worth the install). Ship
`byteRun1Decode(data, { expectedLength?, elementSize?: 1 | 2 })`. That single
signature subsumes all three strike/middilgard copies.

**Effort/risk.** Small effort, low risk. Fixing wyrm's missing `0x80` branch
during migration is a behaviour change on that one file and should be checked
against its corpus.

---

## 7. Minimal RIFF/WAVE writer

**What it is.** ~30 lines that wrap raw PCM samples in a 44-byte WAV header.

**Evidence.** Three independent implementations:

- `strike/tools/shared/wav.ts` — mono **16-bit signed**, plus
  `signed8ToPCM16()`.
- `sorcery/tools/wizardry6/decode-sound.ts:22` `wrapWav` — mono **8-bit
  unsigned**, `DataView`-based.
- `middilgard/tools/shared/io.ts:117` `writeMonoU8Wav` — mono **8-bit
  unsigned**, `Buffer`-based. (A fourth, stereo float renderer lives in
  `middilgard/tools/shared/smus-player.ts:1257` `writeWav`.)

**Assessment: truly duplicated.** The differences (8-bit unsigned vs 16-bit
signed, mono vs stereo) are two parameters, not two designs.

`strike/tools/shared/wav.ts`'s own docblock is the most useful artifact here:

> "Kept local (not a dependency on `@seer-project/pipeline`, which has no WAV
> helper)… adding a new shared package mid-session risks colliding with a
> concurrent agent's `package.json` edits. This is a single, self-contained
> ~30-line RIFF/WAVE writer, not worth a package."

That is a **process** reason for duplication, not a technical one — see §15.

**Quality.** All three are correct, small, and clear. None tested directly
(`strike/tools/desertstrike/__tests__/dmca-extract.test.ts` exercises its
output indirectly).

**Verdict: extract now — `@seer-project/pipeline` `io.ts`.** Not a new package.
`writeWav(path, samples, { sampleRate, bits: 8 | 16, channels: 1 | 2 })`
covers all four call sites, sits next to `writePNG` where it belongs
conceptually, and costs one function.

**Effort/risk.** Trivial effort, negligible risk.

---

## 8. Test-harness conventions

**What it is.** The three helper patterns every repo's test suite reinvents:
synthetic binary fixture builders, "is the real corpus present?" guards, and
structural-invariant assertions.

**Evidence.**

*Fixture builders* — 25+ hand-written `function buildX(...): Uint8Array` that
allocate, poke fields through a `DataView`, and return. Examples:
`wyrm/tools/kgb/__tests__/uss.test.ts:9` (`buildChunk`),
`nicodemus/src/assets/formats/__tests__/cmp.test.ts:39`,
`strike/tools/desertstrike/__tests__/audio.test.ts:19`,
`middilgard/src/assets/formats/__tests__/imag.test.ts:14,36`,
`middilgard/src/assets/formats/__tests__/resource-fork.test.ts:9,255`
(the same builder written twice in one file, once per endianness).

*Corpus guards* — **six mutually incompatible idioms**, four of them inside
middilgard alone:

| Idiom | Example |
|---|---|
| `existsSync` + `describe.skipIf` | `strike/tools/desertstrike/__tests__/directory.test.ts:17,19` |
| `try { readFixture() } catch { available = false }` + `describe.skipIf` | `strike/tools/shared/__tests__/amiga-planar.test.ts:20-27` |
| `const maybeIt = hasRealData ? it : it.skip` | `middilgard/tools/vengeance/__tests__/dosvga-episode-layout.test.ts:33-34` |
| `resolveDataDir(...)` then `it.skipIf(!raw)` | `middilgard/src/assets/formats/__tests__/mmap.test.ts:207` |
| `describe.runIf(hasData)` | `wyrm/tools/kgb/__tests__/cryo-lz.test.ts:9`, `sorcery/tools/wizardry6/__tests__/packed-pixel.test.ts:57` |
| bare `if (!existsSync(...)) return;` | `middilgard/tools/__tests__/build-music-manifest.test.ts:96,102` |

The last one is a latent bug pattern: it reports **green**, not skipped, when
the corpus is absent. And the two repos disagree on premise —
`strike/tools/shared/__tests__/amiga-planar.test.ts:6-13` argues `data/` "is
present in every environment", while
`middilgard/tools/__tests__/cdtv-audio-tables.test.ts:22-33` embeds real bytes
as a hex literal *specifically because* `data/` is gitignored.

*Structural-invariant assertions* — the same idea, four bespoke
implementations: `strike/tools/shared/__tests__/amiga-planar.test.ts:29-47`
(decoded length matches `bytesPerRow × planes × height`),
`sorcery/tools/wizardry6/__tests__/packed-pixel.test.ts:59`
("byte accounting reaches EOF exactly"),
`nicodemus/src/assets/formats/__tests__/bitplane.test.ts:11-30`,
`middilgard/tools/__tests__/build-maps.test.ts:9-15`.

*And the template test itself:* `tools/shared/__tests__/game-config.test.ts`
exists in all six repos plus seer. `wyrm`, `nicodemus` and `sorcery` still
carry the **rendered scaffold verbatim** — 9–10 lines, differing only in the
game-name string, all three still asserting it "finds the *placeholder*
config" long after the config stopped being a placeholder. `strike:29-33` and
`middilgard/tools/__tests__/game-config.test.ts:241-249` independently wrote
the *same* "every registered platform resolves to a real data dir" test.

Separately, `middilgard` keeps **verbatim copies of `@seer-project/*`'s own test
files**, retargeted at the package import: `diff
middilgard/src/assets/formats/__tests__/iff.test.ts
seer/packages/iff/src/__tests__/iff.test.ts` is *one line* (the import). Same
for `display-mode.test.ts` (one line) and `camera.test.ts` (one import split
into two).

**Assessment: truly duplicated in spirit, and the divergence causes real
problems** — six ways to answer "is the corpus here?" means CI behaviour is
unpredictable per repo, and one of the six silently passes.

**Quality.** The tests themselves are strong — this codebase's testing
philosophy (construct real bytes, assert on real decoded output, never mock
the decoder) is genuinely good and consistently applied. It's the plumbing
around them that's six-times-reinvented.

**Verdict: extract later — new package `@seer-project/testing`** (a `devDependency`).
Small surface, high leverage:

```
describeWithCorpus(name, dataDirOrConfig, fn)   // one skip idiom, always skips (never silently passes)
buildBinary(spec)                                // DataView-poking fixture builder
expectConsumesExactly(decode, input, expectedLength)
expectPixelBufferSize(buf, { width, height, planes })
```

Plus a `create-seer` template fix: the scaffolded `game-config.test.ts` should
either assert something durable or not be scaffolded at all, since three repos
prove it never gets edited.

**Effort/risk.** Small-to-medium effort. Low risk — it's a devDependency and
migration is opt-in per test file. Sequence it after §1/§2 so the pixel/atlas
assertions have canonical types to assert against.

---

## 9. AmigaOS HUNK executable parsing

**What it is.** Walk a `loadseg()`-able Amiga executable: `HUNK_HEADER`
(0x3f3), per-hunk `HUNK_CODE`/`HUNK_DATA`/`HUNK_BSS`, skip
`HUNK_RELOC32`/`SYMBOL`/`DEBUG`, yield segment payloads and their file
offsets.

**Evidence.** **Seven** independent implementations across four repos:

| # | Path | Scope |
|---|---|---|
| 1 | `strike/tools/shared/amiga-hunk.ts` (156 L) | all hunks + **file offsets**, masks `& 0x3FFFFFFF` on the in-stream tag (MEMF flags), throws on unknown tag — the most complete |
| 2 | `strike/tools/shared/hunk-wrapper.ts` (169 L) | fixed 32-byte single-hunk LoadSeg wrapper; the only one that *decodes* RELOC32 offsets rather than skipping |
| 3 | `middilgard/src/assets/formats/exe-data.ts:359-442` `parseHunks()` | first CODE + first DATA only, no offsets |
| 4 | `nicodemus/src/assets/formats/exe-data.ts:30-169` | same output as #3, split header/body/trailer, correctly loops the resident-library name list |
| 5 | `wyrm/tools/kgb/decrunch-hunk4.ts:131,358` | all hunks by index — and the **only HUNK writer** anywhere (`buildHunkExe`) |
| 6 | `middilgard/tools/conan/decompress-data-hunk/extract-sections.ts:43` | all hunks + type + offset — a *second* parser inside middilgard, unaware of #3 |
| 7 | `crawl/tools/bcdft_decompress/extract_sections.py` (67 L) | Python, hardcoded hunk indices 0/4/5, no header parse |

Plus two inline ad-hoc walkers in middilgard scratch tools
(`tools/wime/analyze-exe-data.ts:17-95`,
`tools/wime/palette-analysis.ts:22-80`). The second is diagnostic:
`palette-analysis.ts` *imports* `parseHunks` **and then re-walks the file
itself**, because `parseHunks` doesn't expose file offsets — which is exactly
the gap strike's `amiga-hunk.ts` fills.

`nicodemus/src/assets/formats/exe-data.ts`'s header explicitly cites
middilgard's file as "same problem shape, reimplemented independently here",
and #4 fixes a latent bug in #3 (which reads the resident-library name list as
a single length longword instead of looping — correct only because the list is
empty in these files).

**Assessment: truly duplicated, structurally diverged in return contract.**
All seven share the same eight constants and the same skip-loop shape. They
differ in what they hand back: `{code, data}` (3, 4) vs `Hunk[]` with offsets
(1, 6) vs indexed `hunkData[]` (5) vs payload + relocs (2). A superset API —
all hunks, file offsets, reloc list, tag masking — covers every caller;
strike's `amiga-hunk.ts` is closest to it already.

**Quality.** Documentation is excellent throughout (every one carries a
confidence-annotated docblock citing its `docs/` section). Test coverage is
inverted from quality: nicodemus (#4), wyrm (#5) and strike's
`hunk-wrapper.ts` (#2) are tested; **strike's `amiga-hunk.ts` — the best
implementation — has no test at all**; middilgard's is only exercised
indirectly.

**Verdict: extract now — new package `@seer-project/amiga`.** HUNK is a published
AmigaOS format with zero game-specific content, and four of six repos target
Amiga. Take strike's `amiga-hunk.ts` as the base, add `hunk-wrapper.ts`'s
reloc decoding as an option, add wyrm's `buildHunkExe` writer (needed by
anything that decrunches a self-extracting executable back to a loadable one),
and write the tests strike's version is missing.

**Effort/risk.** Medium effort (superset API + tests + four migrations), low
risk. The `{code, data}` consumers (middilgard, nicodemus) can keep a
two-line adapter rather than being rewritten.

---

## 10. UAE / Amiberry `.uss` savestate reader

**What it is.** Walk an emulator savestate's chunk stream, zlib-inflate the
RAM chunks, and search them — the standard technique for getting a
*decompressed* ground-truth oracle out of a game that decompresses at load
time.

**Evidence.** Two full, independent reverse-engineerings:

- `wyrm/tools/kgb/uss.ts` (134 L) — `scanChunks` with resync-on-implausible-
  header, `inflateChunk`, `loadSavestate`. Tested
  (`wyrm/tools/kgb/__tests__/uss.test.ts`). Consumed by
  `wyrm/tools/kgb/locate-files.ts` (which searches CRAM/ZRAM for verbatim
  copies of on-disk files to build (compressed, decompressed) pairs) and
  `wyrm/tools/kgb/custom-regs.ts` / `copper.ts`.
- `middilgard/tools/wime/parse-uss-savestate.ts` (277 L) — `walkUssChunks`
  with resync-on-bad-tag, `decompressRamChunk`, `"ASF "` magic validation.

Both independently discovered that the declared chunk size cannot be trusted
and that a forward-scanning resync is required. Both zlib-inflate the RAM
chunks. **They disagree on the chunk model**: wyrm reads a 12-byte header
(`name[4] + size + flags`) with the payload starting after it; middilgard
reads an 8-byte header (`tag + size`) and treats flags as the payload's first
longword. Both are correct — the boundary is just drawn in different places —
but the two docblocks now describe the same format two incompatible ways, and
neither repo knows the other exists.

**Assessment: truly duplicated, and a shared *technique* worth promoting.**
This is not game data at all — it's emulator-artifact tooling that any Amiga
target will want the moment a format resists static analysis. crawl and strike
both have Amiga targets and neither has this capability.

**Quality.** wyrm's is cleaner and tested; middilgard's has the better header
documentation (it documents the variable-length string header, which wyrm
sidesteps by scanning). `locate-files.ts` is the genuinely valuable part and
exists nowhere else.

**Verdict: extract later — `@seer-project/amiga`, alongside §9.** Reconcile the two
chunk models first (that discrepancy is worth resolving on its own merits),
then ship `loadSavestate`, `findChunk`, `inflateChunk`, and a
`findVerbatimFiles(savestate, dataDir)` port of `locate-files.ts`.

**Effort/risk.** Small effort once the model is reconciled; low risk (a
read-only diagnostic tool, not a pipeline stage). Lower priority than §9
because only two repos need it *today* — but it is the higher-leverage of the
two for future RE work.

---

## 11. Musashi 68k emulation harness

**What it is.** A C harness that vendors the Musashi 68000 emulator, maps a
game's own hunk segments into a flat memory image, sets up the entry
registers, and *runs the game's own decompressor* rather than reimplementing
it.

**Evidence.** Two, each with its own cloned `musashi/` directory:

- `crawl/tools/bcdft_decompress/` — `emu.c` (251 L), `emu_jr.c` (272 L),
  `emu_jr_trace.c` (187 L, instrumented read/write logging — the only tracing
  scaffold anywhere), `jr_decrunch.c` (315 L, a hand-written C reimplementation
  of the emulated routine).
- `middilgard/tools/conan/decompress-data-hunk/` — `emu.c`, `extract-sections.ts`,
  `build.sh`, `README.md`.

The shared part is substantial and verbatim: same `MEM_SIZE = 0x10000000` /
`BASE 0x80000`, all sixteen Musashi callbacks byte-equivalent (middilgard's
just collapsed to one line each), the same BPTR segment-chain construction
loop, the same 7-segment `S_0..S_6` model, the same entry setup (`D6=3`,
`A4=code0+0x64`, `A7` at top of RAM). `build.sh` is ~70% identical — same
`MUSASHI_REPO` URL, same clone → `m68kmake` → `gcc -c` → link → `build|run|clean`
case structure.

The divergence is real and deliberate: crawl hardcodes segment sizes as
`#define SZ_S0..SZ_S6`, middilgard computes them from argv; and the **stop
condition** differs — crawl runs to a PC-leaves-range/cycle-budget test,
middilgard slices execution watching `D5 == 3` because the post-completion
`ABSEXECBASE` cache flush wanders into unmapped memory. Middilgard's fix is
documented and has never been backported to crawl.

Worth contrasting: `wyrm/tools/kgb/decrunch-hunk4.ts` solves the *identical*
problem class (self-decrunching 6-hunk Amiga executable, backwards-reading
LZSS, seglist walker at `hunk0+0x64`) by **hand-translating the 68k to
TypeScript** with the tables lifted verbatim from hunk 3. It has an 86-line
algorithm docblock and real unit tests — and it is the only one of the three
approaches that runs in CI.

**Assessment: truly duplicated scaffolding around genuinely per-game
payloads.** The memory map, callbacks, BPTR chain and build script are one
file's worth of shared code copied twice. The entry-point setup and stop
condition are per-game and should stay per-game.

**Quality.** Both are undocumented-by-test one-shot tools. crawl's `emu.c` has
richer inline layout docs; middilgard's has the better stop condition and an
8.3 KB README vs crawl's 1.6 KB. Both repos check in the compiled binaries
(crawl: 788 KB × 5, plus an `emu.c.bak`; middilgard: one 788 KB
`conan_decompress`) and a full `musashi/` git clone — which is the more
pressing hygiene problem.

**Verdict: extract later — a `create-seer` template / `@seer-project/m68k-harness`
scaffold, not an npm package.** This is C plus a build script; it does not
belong in the TypeScript package graph. The right shape is a scaffoldable
`tools/m68k-harness/` template with the memory map, callbacks, BPTR chain and
`build.sh` prefilled, plus documented seams for entry registers and the stop
predicate — and Musashi fetched by the build script rather than vendored twice.

**Effort/risk.** Medium effort, medium risk (C build portability is a real
cost the TypeScript packages don't carry). Genuinely valuable, but only two
repos need it today. If the priority is lower-hanging, note that just
*documenting* wyrm's hand-translation approach as the preferred first attempt
— it's testable, portable, and needs no C toolchain — may deliver more value
than sharing the harness.

---

## 12. Byte-reader micro-helpers

**What it is.** Two-line big-endian `readU16BE`/`readU32BE`/`u16` functions.

**Evidence.** `@seer-project/core` already exports `BinaryReader`, `dataViewOf`, `r8`,
`r16`, `r24`, `r32`. Local redefinitions still present:

- wyrm: `tools/kgb/uss.ts:35`, `anc.ts:49`, `tet.ts:68`, `cma.ts:219`,
  `wrd.ts:28`, `decrunch-hunk4.ts:120` — six near-identical copies.
- strike: `readU32BE` **exported** from `tools/shared/strike-lzss.ts:77` and
  separately redefined in `tools/shared/megadrive-catalog.ts:75`; `u16` twice,
  in `megadrive-overlay-bank.ts:118` and `megadrive-tilemap.ts:154`. Strike
  imports zero binary helpers from `@seer-project/core` despite four local copies.
- middilgard: `src/utils/binary.ts` re-exports core's `dataViewOf` but
  **redefines** `r8`/`r16`/`r24`/`r32` locally (lines 21-46) rather than
  re-exporting core's identical versions;
  `tools/shared/smus-player.ts:22,26` adds two more plus two local `u16`
  closures at :380 and :462.

**Assessment: truly duplicated, zero correctness risk.** All are the same
shift-and-or. Pure noise.

**Quality.** N/A — they're two lines each.

**Verdict: not worth a coordinated effort; fix opportunistically.** No new
package needed; `@seer-project/core` already has all of it. Worth one cleanup pass in
strike and middilgard's `src/utils/binary.ts` (the highest-value two), and
worth a line in `boilerplate-guide.md` saying "don't write `readU16BE`, import
`r16`" — which is a documentation fix, not a code one.

**Effort/risk.** Trivial, negligible.

---

## 13. Packages that already exist and are being reimplemented

Five distinct instances of a consumer writing code that a `@seer-project/*` package it
already depends on provides. These are **adoption gaps, not extraction
candidates** — the verdict for all five is "delete the local copy", and the
interesting question is why they happened.

**13a. ProTracker MOD playback vs `@seer-project/tracker`.**
`wyrm/tools/viewer/music-player.ts` (308 L) is a full FLT4/M.K. module parser
plus a Paula-accurate playback engine — sample tables, period/finetune
handling, PAL/NTSC clock selection. `@seer-project/tracker` (`micromod.ts` 587 L,
`player.ts` 116 L) already does this, with an AudioWorklet. **wyrm declares
`@seer-project/tracker` in `package.json` and imports it from nowhere.**
`strike/tools/desertstrike/audio.ts:42` references `@seer-project/tracker` in a
comment as the thing that *would* play its confirmed `M.K.` modules, without
depending on it.
*Verdict: adopt now.* wyrm's Dune-specific part (HSQ-compressed module
container) stays; the replay engine goes.

**13b. SMUS offline rendering vs `@seer-project/smus`.**
`middilgard/tools/shared/smus-player.ts` (1358 L) contains `parseSmus`,
`sonixOneFilter`, `sampleOctaveForMidi`, `sonixRateUnits`,
`defaultInstrument` and a `SmusEngine` class — every one of those names is an
**existing export of `@seer-project/smus`**, which middilgard itself upstreamed
(`middilgard/docs/seer-migration.md` §3.5) and already depends on. The one
thing the package genuinely lacks is the offline path: render-to-PCM without
WebAudio, plus a WAV writer.
*Verdict: extend `@seer-project/smus` with `renderToPCM()` (reusing §7's `writeWav`),
then delete ~1200 lines from middilgard.* This is the single largest
line-count win in the survey.

**13c. IFF chunk walking vs `@seer-project/iff`.**
`strike/tools/desertstrike/screens.ts:60-75` hand-rolls `fourCC`, `u32` and
`walkFormChunks` — a functional duplicate of `parseIff`/`findChunk`.
`middilgard/tools/shared/smus-player.ts:40+` hand-rolls another. Strike's
docblock gives the reason explicitly: "this project has no `@seer-project/iff`
dependency installed; adding one mid-session risked colliding with a
concurrent agent's `package.json` edits, so this stays local".
*Verdict: adopt now in strike (add the dep); fold middilgard's into 13b.*

**13d. PNG writing.** Five repos import `writePNG`/`writeIndexedPNG` from
`@seer-project/pipeline`. `middilgard/tools/shared/io.ts:82-104` keeps its own
identical copies — the "Step 9 (optional): adopt seer's pipeline utilities"
that `middilgard/docs/seer-migration.md` §5 deferred. Consequence worth
flagging: **`weaknesses.md` §7's silent-corruption bug now exists in two
places** — `middilgard/tools/shared/io.ts:101` has the same
`A = (v === 0 ? 0 : 255)` hardcoded transparent index as
`packages/pipeline/src/io.ts:44`, so fixing only the package leaves middilgard
exposed. Same for `readBinary`, `writeJson`, `resolveResFile`
(≡ `resolveDataFile`), `scanResFiles` (≡ `scanFilesByExtension`), and
`hex-dump.ts` (`middilgard/tools/shared/hex-dump.ts` is the un-parameterised
ancestor of `packages/pipeline/src/hex-dump.ts`).
*Verdict: execute seer-migration.md Step 9.* Note that `middilgard/tools/`
imports **zero** `@seer-project/*` modules today, which is why `@seer-project/pipeline` is a
declared-but-unused dependency there.

**13e. `@seer-project/*` package tests copied into a consumer.** `diff
middilgard/src/assets/formats/__tests__/iff.test.ts
seer/packages/iff/src/__tests__/iff.test.ts` differs by **one line** (the
import). Same for `display-mode.test.ts`; `camera.test.ts` differs by one
import being split in two. These re-test the package from the consumer, which
is defensible as an integration smoke test but is currently just a stale copy.
*Verdict: delete, or reduce to a one-line "the package resolves and exports
what we import" smoke test.*

**Why this cluster exists — the meta-finding.** Two of these five carry an
explicit written reason (`strike/tools/shared/wav.ts`,
`strike/tools/desertstrike/screens.ts`): *adding a dependency mid-session
risks a `package.json` write conflict with a concurrent agent.* That is a
rational local decision producing a bad global outcome, and it is a workflow
problem, not an architecture problem. It is worth a documented answer in
`boilerplate-guide.md` — e.g. declare all `@seer-project/*` packages in the
`create-seer` scaffold up front (they are `file:` links with no install cost),
so no session ever needs to edit `package.json` to import one. Three repos
already carry unused `@seer-project/*` deps (crawl: iff, smus; wyrm: tracker;
middilgard: pipeline), so this is closer to normalising existing practice than
introducing a new one.

---

## 14. `create-seer` scaffold drift

Not a package candidate — a set of template fixes the survey surfaced. Listing
them because each one is currently being inherited by every new project.

1. **Two conflicting `AtlasMeta` definitions** —
   `packages/create-seer/templates/src/data/GameData.ts.eta:5-15` (uniform
   grid) vs `templates/tools/viewer/shared.ts.eta:1-17` (packed frames).
   Already `weaknesses.md` §6; **new evidence: both `nicodemus/src/data/GameData.ts`
   and `sorcery/src/data/GameData.ts` still carry the dead uniform-grid copy,
   untouched.** Fixed by §2.
2. **The viewer is silently dropped from production builds in two repos.**
   `wyrm/vite.config.ts:45` and `nicodemus/vite.config.ts:45-64` add a
   `rollupOptions.input` viewer entry; the template does not. Consequence:
   `crawl/index.html` is a `<meta http-equiv="refresh">` redirect to
   `/tools/viewer/index.html` — but `crawl/vite.config.ts` has no viewer
   entry, so `crawl/dist/` contains only `index.html` + `assets/`. **A
   production build of crawl is a redirect to a 404.** `sorcery` has the same
   shape (viewer + `viewer:manifest` script, no build entry, no `viewer` dev
   script), less severely.
3. **`.prettierrc` is missing in crawl and wyrm**, which both declare the
   `format` script and the `prettier` devDependency. Running `npm run format`
   in either reflows every file to Prettier defaults (double quotes, 80 cols)
   and away from the house style the other four use
   (`singleQuote: true, printWidth: 100`).
4. **`seer.config.ts` is dead in all four repos that have it** — see §4.
   Either wire the `seer` binary up as the documented entrypoint or drop the
   file from the scaffold; a hand-synced second source of truth is the worst
   of both (`nicodemus/seer.config.ts` says so in its own comment).
5. **`middilgard/vitest.config.ts`** (8 lines, `globals: true`, no `include`)
   takes precedence over `vite.config.ts` and silently drops the shared
   `include: ['src/**/*.test.ts', 'tools/**/*.test.ts']`. `globals: true` is
   dead weight — all 39 middilgard test files import from `'vitest'`
   explicitly.

Otherwise the scaffold is holding up well: `tsconfig.json` is byte-identical
in five of six (middilgard adds `"node"` to `types`), `eslint.config.js` in
five of six (wyrm adds one ignore path), the first six `package.json` scripts
are byte-identical in all six, and third-party versions have **zero skew**
across all six repos.

---

## 15. Documentation structure

Two findings that are framework-doc problems, not code.

**15a. `docs/architecture-overview.md` is vendored, not referenced.**
`nicodemus`, `sorcery` and `strike` each carry a **byte-identical 368-line
copy** of `seer/docs/architecture-overview.md` (and a byte-identical 133-line
copy of `boilerplate-guide.md`), scaffolded from
`packages/create-seer/templates/docs/*.eta` — which are themselves plain
copies with no template variables. `middilgard`'s copy is a **57-line-stale
fork**: it predates both the §5 "Type Boundary" decision and §7's
scoped-package generalisation, and nothing will ever propagate those back.
`crawl/README.md:48-50` already does the right thing — links the guides
on GitHub rather than vendoring them.
*Recommendation:* the scaffold should link, not copy. A framework document
that four projects hold stale copies of is worse than no local copy.

**15b. A fifth zone exists that the four-zone model doesn't name.**
`crawl/build/cache/`, `strike/build/cache/` and `middilgard/build/cache/` all
exist and hold decompressed corpora, triage JSON and verification renders —
intermediates that are neither `data/` (user-supplied, never written) nor
`public/assets/` (web-native pipeline output). Strike's tool docstrings cite
"docs/architecture-overview.md S2" as the authority for the rule
(`strike/tools/junglestrike/extract-adf.ts:19`,
`decrunch-corpus.ts:7`), but strike's copy of that doc is byte-identical to
seer's and **§2 says nothing about `build/`**. Only `strike/.gitignore`
ignores it.
*Recommendation:* add `build/cache/` to the §2 table as a fifth zone
(developer-run intermediates, gitignored, never read by the runtime) and to
the scaffolded `.gitignore`. Half the consumers already behave as if it's
documented.

**15c. Framework docs living in game repos.** Three worth relocating:
`docs/walker.md` (1694 L) opens by describing itself as "a reusable,
game-agnostic first-person grid dungeon renderer + movement model **for
Seer-framework projects**", explicitly designed against a second consumer in
`crawl` — and is invisible from `crawl`. `middilgard/docs/seer-migration.md`
concedes the misplacement in its own banner.
`middilgard/docs/tooling/x86-disassembly.md` documents the general
`r2_addr = file_offset − header_size` mapping rule that crawl (two DOS
targets) and sorcery (one) both need.

Also worth noting as the strongest *undocumented* cross-repo convention:
**`docs/<game>/TODO.md` exists in all six repos** and is written down in no
framework doc. Conversely, the `docs/<game>/<platform>/data-structure.md`
convention that *is* implied by the scaffold is followed by only three of six
(crawl, strike, sorcery); wyrm, nicodemus and middilgard each invented a
different layout, and middilgard additionally invented a cross-game
`docs/formats/` tier the convention has no slot for (strike invented the same
thing as a loose root-level file).

---

## 16. What this survey says about the existing framework docs

**Confirms:**

- `weaknesses.md` §5 ("consider hoisting the packed-atlas and palette shapes
  into `@seer-project/core` once a second or third project needs them") — six do, with
  11+ redeclarations. §2 above.
- `weaknesses.md` §6 (conflicting `AtlasMeta` in the templates) — the stale
  uniform-grid shape is now sitting untouched in two more repos.
- `weaknesses.md` §7 (`writeIndexedPNG` hardcodes index 0 transparent) — and
  **adds**: the same bug exists a second time in
  `middilgard/tools/shared/io.ts:101`, so a package-only fix leaves one
  consumer exposed. The `transparentIndex?: number | null` option §7
  recommends is also the right shape for §1's `indicesToRGBA` — worth making
  them consistent.
- `weaknesses.md` §4 (`sliceAtlas`/`sliceAtlasKeyed` only handle uniform
  grids, while every real extractor emits packed frames) — **and adds**: those
  two helpers, along with `computeViewportBounds`, `createDiamondMarker`,
  `findNearestByWorldCoord`, `screenToWorld` and `computeUIScale`, have
  **exactly one consumer between them (middilgard)**. `@seer-project/engine`'s entire
  non-`createGame` surface is single-consumer.
- `weaknesses.md` §1 (`SceneRenderer`/`EntityManager`/`AudioManager` don't
  exist) — confirmed, and the reason is now visible: five of six repos have an
  empty `src/engine/`, so nothing has ever pulled those into existence.
  middilgard's `EntityManager.ts` (211 L), `MusicManager.ts` (199 L) and
  `TileMap.ts` (127 L) are the only real implementations and are firmly
  single-consumer — **so §1's recommendation to "implement stubs" is the wrong
  call; mark §8 as target-architecture instead.**
- `framework-plan.md` §8 (browser/Node separation should be structural) —
  holding up. No repo has leaked `node:fs` into browser code.

**Contradicts / complicates:**

- `framework-plan.md` §§2–4 (config-as-data, plugin registration, a real CLI
  binary) are implemented — and **unused**. All six repos route around the
  CLI via `tools/extract-game-data.ts`, and the four `seer.config.ts` files
  are dead. The plan treated the CLI as the finish line; the survey shows the
  finish line is *adoption*, and nothing in the sequencing plan covers it. §4
  and §14.4 above.
- `framework-plan.md` §1 ("split the library from the starter") assumed the
  starter's value is the scaffold. In practice the scaffold's `src/` half is
  inert in five of six repos and the *contested* territory is `tools/shared/`
  — which the plan doesn't model at all. Every candidate in §1, §3, §6, §7,
  §9, §10 lives in `tools/shared/`.
- `middilgard/docs/seer-migration.md` §6 lists `tools/shared/*` as "stays
  entirely in middilgard". Broadly right for the game-specific parts, but
  §13b (1358-line `smus-player.ts` duplicating a package middilgard itself
  wrote) and §13d (Step 9's deferred `io.ts`) are now the two largest
  identified redundancies in the whole survey. The Step 9 deferral was
  reasonable at the time; it is no longer.

**Adds (not tracked anywhere):**

- No graphics package (§1) — the largest cross-repo duplication by far.
- No Amiga/retro-platform package (§9, §10) — seven HUNK parsers.
- No test-harness package (§8) — six incompatible corpus-guard idioms, one of
  which silently passes.
- `build/cache/` as an undocumented fifth zone (§15b).
- Consumers duplicating rather than depending because of **session-level
  `package.json` write-conflict avoidance** (§13) — a workflow cause with an
  architectural symptom, and cheap to fix by pre-declaring all `@seer-project/*` deps
  in the scaffold.
- `docs/todos.md` currently reads "(all done)". Whatever else comes of this
  review, that file is now inaccurate.

---

## 17. False positives — things that look shareable and aren't

Named explicitly so they don't get re-proposed.

**Bespoke compression codecs.** Every repo has several, and they share
nothing but the words "LZ" and "RLE". `middilgard/src/assets/formats/imag.ts:103`
`lzssDecompress` and `strike/tools/shared/strike-lzss.ts:98` are the trap:
both have an 8-bit flag byte, a 2-byte token and a `+3` length bias, but
middilgard uses a **10-bit output-relative offset** (`token>>6`, LE token, no
ring buffer) while strike uses a **2048-byte ring buffer with `wpos` init
0x7EE** and a split-nibble offset. Different codecs. Do not merge. Likewise
`wyrm/tools/kgb/cryo-lz.ts` (bit stream interleaved with raw bytes on one
shared cursor), `wyrm/tools/kgb/decrunch-hunk4.ts` (backward-reading, unary
class selector into four verbatim 68k tables),
`strike/tools/urbanstrike/snes-tagbyte-codec.ts` (absolute output offsets,
ramp ops), `crawl/tools/bcdft_decompress/jr_decrunch.c` (MSB-first
`add.b`/`addx.b` carry-bit reader), `wyrm/src/formats/cryo-image.ts:131`
`rleUnpack09b8` (descending literal count). Only the *published* formats —
PackBits (§6), PP20, RNC ProPack, zlib — are shareable.

**Amiga copper/custom-regs vs Genesis VDP.** `wyrm/tools/kgb/custom-regs.ts` +
`copper.ts` reconstruct *runtime state* from a savestate (register snapshot +
display-list interpretation); `strike/tools/shared/genesis-vdp.ts` is *static
asset decoding* (tile bitmaps + CRAM words). Same-sounding, different problems.
The true analogue of `genesis-vdp.ts` is `amiga-planar.ts`, and it's already
in §1.

**Disk/CD image extraction.** `strike/tools/junglestrike/extract-adf.ts`
(shells to `xdftool` for OFS ADFs), `nicodemus/tools/stx-extract/stx2st.py`
(Atari STX), `middilgard/tools/shared/cue-bin.ts` (CUE/BIN Red Book sector
maths). Three different media with three different specs; the only shared
thing is the *convention* of writing results to `build/cache/` (§15b) and the
external-tool-wrapper shape, which is ~20 lines.

**crawl's Python pipeline.** `crawl/scripts/bclib/` (`planar.py`,
`palette.py`, `atlas.py`, `paths.py`, `rle.py`) duplicates crawl's own
TypeScript `tools/shared/amiga-planar.ts` and `asset-paths.ts` in another
language, and `crawl/tools/shared/asset-paths.ts`'s docblock notes the two
"must agree". That's a real DRY problem — but it's crawl-internal and the fix
is convergence on TypeScript, not a `@seer-project/*` package.

**Intra-repo duplicates worth fixing locally, not extracting.**
`wyrm/src/formats/hsq.ts:13` and `wyrm/src/formats/cryo-image.ts:505` are the
same Cryo LZ token-for-token (same 16-bit LSB-first refill, same 13-bit
negative offset, same `+2` length bias, same zero-escape/EOS).
`sorcery/tools/wizardry6/decode-msg-text.ts:82` and
`decode-dosega-msg-text.ts:49` are a line-for-line identical Huffman decoder
differing **only** in one `'be'`/`'le'` argument. And
`middilgard/tools/wime/analyze-frml-trailer.ts:42` /
`recover-frml-last-frame.ts:50` carry two copies of a `decompressFRMLData`
wrapper that are now *stale* — both gate on
`rawBitmapStart === 4 + frameCount * 6`, which
`middilgard/src/assets/formats/frml.ts:120` has since corrected to
`8 + frameCount * 6`.

---

## 18. Prioritized list

### Do now

| # | Candidate | Home | Effort |
|---|---|---|---|
| 2 | Canonical `AtlasMeta` / `PaletteData` / `ManifestEntry` | `@seer-project/core` | S |
| 1 | Retro bitmap graphics primitives | **new `@seer-project/gfx`** | M |
| 6 | PackBits / ByteRun1 | `@seer-project/gfx` | S |
| 13b | SMUS offline render + WAV → delete middilgard's 1358-line duplicate | `@seer-project/smus` | S |
| 7 | Minimal WAV writer | `@seer-project/pipeline` `io.ts` | XS |
| 13a | wyrm adopts `@seer-project/tracker` (already a declared dep) | — | S |
| 13c | strike adopts `@seer-project/iff` | — | XS |
| 9 | AmigaOS HUNK parser (superset API + the missing tests) | **new `@seer-project/amiga`** | M |
| 4 | `runPipeline` step selection + CLI entry consolidation | `@seer-project/pipeline` | S |
| 14 | `create-seer` fixes: `AtlasMeta`, viewer build entry, `.prettierrc`, `seer.config.ts` decision | templates | S |
| — | Fix `writeIndexedPNG`'s transparent-index bug in **both** places (`weaknesses.md` §7) | `@seer-project/pipeline` + middilgard | XS |

Order matters: §2 unblocks §1, §3 and §8; §7 unblocks §13b.

### Do later

| # | Candidate | Home | Why later |
|---|---|---|---|
| 3 | Asset paths + manifest merge + platform index | `@seer-project/pipeline` | Blocked on §2 and on picking one manifest model |
| 8 | Test-harness conventions (`describeWithCorpus`, fixture builder, invariant assertions) | **new `@seer-project/testing`** | High leverage, but wants §1/§2's types first |
| 10 | UAE `.uss` savestate reader | `@seer-project/amiga` | Reconcile the two chunk models first; two consumers today |
| 13d | middilgard executes seer-migration Step 9 (`io.ts`) | — | Mechanical, but middilgard is mid-iteration |
| 5 | `defineNarrowedConfig` factory | `@seer-project/pipeline` | Touches a documented decision (`architecture-overview.md` §5) |
| 15 | Link-don't-copy framework docs; document `build/cache/` as a fifth zone; relocate `walker.md` | `docs/` + templates | Cheap, but no forcing function |
| 11 | Musashi 68k harness as a scaffoldable template | `create-seer` | Real value, only 2 consumers, C toolchain cost |
| 19 | `ceres` SNES N-SPC → likely extends `@seer-project/smus`'s instrument shape | `@seer-project/smus` | Blocked on `ceres` RE'ing N-SPC's sequence format first — not started anywhere |

### Not worth it

- **Bespoke compression codecs** (§17) — the reverse-engineering *is* the
  product; sharing them would be sharing nothing.
- **Amiga copper/custom-regs ↔ Genesis VDP** (§17) — different problems.
- **Disk/CD image extraction** (§17) — three media, three specs, ~20 lines of
  shared wrapper.
- **crawl's Python `bclib/`** (§17) — real duplication, but crawl-internal and
  cross-language.
- **Byte-reader micro-helpers** (§12) — `@seer-project/core` already has them; fix
  opportunistically, don't run a campaign.
- **Promoting middilgard's `EntityManager`/`MusicManager`/`TileMap` into
  `@seer-project/engine`** — single consumer, and `@seer-project/engine`'s existing
  single-consumer surface is already the framework's least-earning
  investment. Revisit only if a second repo grows a real runtime.
- **Implementing `weaknesses.md` §1's missing engine stubs** — five of six
  repos have an empty `src/engine/`; there is no demand. Mark
  `architecture-overview.md` §8 as target architecture instead.

---

## 19. Forward-looking: a seventh consumer (`ceres`, SNES) and the N-SPC question

Not part of the original six-repo survey — added 2026-08-03 when `ceres`
(a seer-framework project reverse-engineering FFVI/V/IV on SNES) hit the same
"do we need a new player" question §13a/§13b already answered, independently,
before this document was pointed out to it.

**What `ceres` confirmed on its own, matching this survey:** real WebAudio
playback already exists in `@seer-project/tracker` (MOD) and `@seer-project/smus` (SMUS) —
neither is parse-only. No third player is planned.

**The open question this survey doesn't yet have an answer to, because the
underlying format hasn't been RE'd anywhere in any of these repos:** FFVI/V/IV
music lives on the SNES's SPC700+DSP sound coprocessor, not in a static
on-ROM format the way MOD/SMUS data is. `ceres/docs/ff{vi,v,iv}/TODO.md`'s
`*-music-sound` rows record two candidate approaches (SPC700 RAM-snapshot
dump + WASM emulator playback, vs. RE'ing the sequence/instrument data into
structured notes) and, for the second path, a structural hunch worth
recording here since it bears directly on where that work would land in this
package graph: the SNES DSP's 8 sample-voices-with-hardware-ADSR-and-echo
model reads as much closer to `@seer-project/smus`'s Sonix-derived `Instrument` shape
(ADSR + filter + LFO + sample, per §13b/`sampled-sound.ts`) than to
`@seer-project/tracker`'s flat-sample-no-envelope MOD model — so *if* that RE work
happens and confirms the format is tractable, extending `@seer-project/smus` looks
like the likely target, not a new package or a new format designed from
scratch.

**What's genuinely unverified, not just unimplemented:** whether N-SPC's
sequence data (the note/pattern data itself, as opposed to the instrument
model) is a free-running per-track event stream — matching SMUS's shape,
§ above — or a fixed-grid pattern sequence — matching MOD's shape. Nobody
has RE'd this yet in any of these repos. That answer determines whether
`@seer-project/smus`'s existing stream-based event model extends cleanly or needs
real rework, and it can't be settled from this survey's read-only pass —
it needs an actual RE session against a ROM.

*Original verdict (2026-08-03): not actionable yet — nothing to extract or
adopt today.* Recorded here so the eventual SNES RE work starts from this
hypothesis instead of re-deriving it, and so this document — not a single
game repo's `docs/` — stays the place that answer eventually gets written
down, per §15c's point about cross-cutting framework knowledge belonging
here rather than scattered per-consumer.

### Update 2026-08-08 — both open questions answered by a real RE session

`ceres` ran the RE session this section called for, against the real
FFVI US ROM (`docs/ffvi/snes/data-structure.md` §18 has the full evidence,
byte-level ROM addresses, and paths-tried table — summarized here per this
section's own framing/style, not restated in full).

**Driver family: not literally Nintendo's N-SPC.** FFVI (and, per a quick
cross-check, FFIV and FFV) run Square's own **in-house driver authored by
Minoru Akao** — the fourth of four distinct SPC700 drivers he wrote at
Square, independently confirmed via a byte-exact, whole-ROM signature
search against `vgmtrans/vgmtrans`'s dedicated `AkaoSnes` format module
(a mature third-party SPC-sequence reimplementation, used here the same
way this survey's six original repos use `everything8215`/community
disassemblies as oracles for ROM data tables — just applied to a project
that specifically targets sequenced-audio formats). Concretely: a literal
60-byte VGMTrans constant (`FF6_VCMD_LEN_TABLE`, specific to its
`AKAOSNES_V4_FF6` classification) has exactly one byte-exact hit in the
FFVI ROM, inside the bank the community's own ROM map already guessed was
the sound driver — plus 5 further SPC700-instruction signature patterns,
each also a unique hit in the same bank. The three games in this project's
own SNES corpus turn out to span three successive versions of the same
lineage: **FFIV = AKAOSNES V1, FFV = AKAOSNES V3, FFVI = AKAOSNES V4**
(each via its own version-specific VGMTrans byte-table, single unambiguous
hit per ROM) — a clean "one driver family maturing release over release"
story, not three unrelated engines.

**Sequence format: confirmed free-running per-track event stream, matching
`@seer-project/smus`'s shape, not `@seer-project/tracker`'s pattern-grid
shape.** Two independent lines of evidence agree: (1) direct community
documentation (`ff6hacking.com`'s MML composition tutorial, written by
people who used the real composing toolchain) states this in plain prose
— *"sequences are free-running streams with independent timing per
channel... there is no way to actively keep the channels synchronized"*;
(2) `vgmtrans/vgmtrans`'s `AkaoSnesSeq`/`AkaoSnesTrack` source structurally
implements exactly that — an 8-entry per-channel pointer table with **no**
pattern/phrase indirection layer, each track then walked as an
independent, variable-duration byte-code stream. `ceres` additionally
hand-decoded real opcode bytes from two tracks of a real FFVI song against
the confirmed V4 opcode table and got clean, in-range note/tie/rest/octave
command sequences — not just a documentation citation, an actual verified
decode. The instrument model also came back closer to `smus`'s shape than
`tracker`'s, as this section's original hunch predicted: per-instrument
tuning + hardware ADSR + a BRR-sample reference via the SPC DSP's sample
directory.

*Updated verdict: actionable now.* `ceres`'s recommendation, now
evidence-backed rather than a coin flip between the two originally-listed
candidate approaches: **extend `@seer-project/smus`**, not a SPC700 RAM-
snapshot/WASM-emulator player — the format didn't resist RE the way that
fallback path assumed it might. No player has been built yet in any repo;
this is still "confirmed format, not yet consumed by a package," same
overall status class as the rest of this survey's "do now"/"do later"
items in §18, not a closed loop.

---

## Honest caveats

- Line counts and diffs are as of this survey; `middilgard` in particular is
  under active iteration.
- The `@seer-project/gfx` API sketch in §1 is a synthesis of six existing call sites,
  not a validated design. The palette-representation question (flat
  `number[]` vs `RGB[]`) is a real decision that four repos have already
  answered four ways.
- I did not run any build, test or lint command in any repo (read-only
  review), so claims about behaviour rest on reading the code and its
  docs — with one exception: the "crawl's production build is a redirect to a
  404" finding in §14.2 was confirmed against the committed `crawl/dist/`
  contents, not inferred.
- The viewer tooling is deliberately under-covered here; see
  `docs/viewer-tooling-review.md`. The one viewer-adjacent thing this review
  does claim is §2 — five near-identical `tools/viewer/shared.ts` files whose
  *types* belong in `@seer-project/core` regardless of what happens to the viewers
  themselves.
