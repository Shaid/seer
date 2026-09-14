# Project status and stability

**Seer is pre-1.0. Breaking changes can and will land in minor releases.**

Every package is versioned `0.x`. Under
[semver's own rules](https://semver.org/#spec-item-4), anything below `1.0.0`
makes no compatibility promise at all, and this project uses that latitude
rather than pretending otherwise. A `0.1.x → 0.2.0` bump may rename exports,
change function signatures, or move a module to a different package.

That is not carelessness — it is the point of being pre-1.0. The API is shaped
by real reverse-engineering projects pushing on it, and those projects keep
finding that the right abstraction is not the one that shipped. Freezing the
surface now would lock in guesses.

## What this means for you

- **Pin exact versions** if you need reproducible builds. `"@seer-project/core":
  "0.1.0"` rather than `"^0.1.0"`. Note that `^0.1.0` already behaves
  restrictively for `0.x` — npm reads it as `>=0.1.0 <0.2.0` — so it will not
  silently pull a breaking minor, but it also will not pull fixes published
  under a later minor.
- **Read the [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md)
  before upgrading.** Breaking changes are called out there.
- **Expect the packages to move together.** They share a version number and are
  released as a set, because their cross-dependencies pin each other. Upgrade
  them together too.
- **Don't build a business-critical dependency on this yet** without either
  vendoring it or being prepared to follow the changes.

## Where the surface is settled, and where it isn't

This is a judgement call, not a guarantee — but it reflects how much real use
each package has taken.

| Package | Stability |
|---|---|
| `@seer-project/core` | **Steadiest.** Binary reading primitives and the asset/palette types are used by every other package and every consuming project; the shapes have survived several games |
| `@seer-project/iff` | Steady. A parser for a published 1985 standard — the format cannot move underneath it |
| `@seer-project/pipeline` | Mostly steady, but Node-only helpers get added as new extraction needs appear |
| `@seer-project/canvas-export`, `@seer-project/retro-display` | New, but already the most widely adopted packages after `core`/`engine-2d`/`pipeline` — picked up by nearly every sibling repo already on `engine-2d` within the same rollout that added them. Expect quicker-than-usual iteration precisely because so many consumers are exercising the API at once |
| `@seer-project/engine-2d`, `@seer-project/smus`, `@seer-project/tracker`, `@seer-project/audio-dsp` | Moving. Each was extracted from a working project and generalised; expect the generalisation to keep being refined |
| `@seer-project/audio-ui`, `@seer-project/dungeon` | Moving faster. Recently extracted, fewer independent consumers |
| `@seer-project/amiga` | Moving faster still — single-consumer as of this writing, so the API hasn't yet had to generalise past that one project's needs |
| `@seer-project/gfx` | Now has three real consumers (crawl, drakkhen, strike) after Phase 4 added a generic rasterizer, DOS CGA/Tandy chunky-pixel decode, and Genesis/MD VDP tile decode on top of its original Amiga planar/palette surface — first time this package has had to generalise past a single project's needs |
| `@seer-project/arcade` | Moving. Long-standing Capcom/Neo Geo surface (CPS2/CPS3, SH-2) gained its first new-project adoption (kolbold) in Phase 4, adding MAME-derived OKI/uPD7759/QSound/Sega System 16 chip and video decoders — expect some reshaping as a second arcade-hardware consumer's needs surface |
| `@seer-project/snes` | Extracted from three sibling projects' independently-drifted copies at once, so the surface reflects real cross-project reconciliation — but only recently migrated, still settling. Gained `akao-dsp.ts` in Phase 5, the one genuinely shared piece of two other sibling projects' AKAO sound-driver tooling |
| `@seer-project/playstation` | Extracted from four sibling projects' PSX/PS2/PSP code at once; ships two independently-verified TIM decode pipelines rather than merging them (they disagree on channel scaling) — expect the two-pipeline shape to be revisited once more consumers exercise it |
| `@seer-project/gltf`, `@seer-project/gpu-textures` | Extracted from Switch-targeting sibling projects' glTF/texture-codec code; `gpu-textures` picked up two real npm dependencies (`@tootallnate/astc-wasm`/`@tootallnate/zstd-wasm`) in place of vendored WASM blobs during extraction, and carries forward a known, documented BC2/BC3 decode bug rather than silently fixing it — see the package's README |
| `@seer-project/dos`, `@seer-project/cri`, `@seer-project/3ds` | **Newest.** Single-consumer platform-format packages added in Phase 4/5 — DOS EXEPACK/LZHUF (powermonger), CRI Middleware CPK/ADX/ACB/AWB (vanille), and Nintendo 3DS CTPK/CTR-texture/LZ/BCSTM/BCH/CGFX + RomFS/crypto (lucina). `3ds` already surfaced one real behavioral divergence between its two source files (`bch.ts`/`cgfx.ts`'s `accumulateBone`) that was deliberately kept unmerged rather than picked a winner. Expect the API to move once a second consumer of any of these shows up |
| `@seer-project/engine-3d`, `@seer-project/mesh-viewer-ui` | **Newest and least settled.** Added most recently; the model-adapter boundary in particular is still being worked out, despite already having several consumers exercising it |
| `@seer-project/probe` | A standalone CLI (binary triage/recon), not a library a project depends on — run directly from this repo (`npm run probe`), not installed by consuming projects. Stability is about its command surface, which is still gaining subcommands |
| `create-seer-app` | Churn matters least — it generates code into your project once, so a later change to the template does not break what you already scaffolded |

## What 1.0 would need

Not a roadmap commitment, just the honest bar: enough independent projects
using the packages that the abstractions stop moving on their own, and a
deprecation policy to replace "we changed it".

See the [framework plan](https://seer.shaid.net/roadmap/framework-plan/) for
where the work is heading.
