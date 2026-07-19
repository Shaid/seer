# Boilerplate Guide

Seer is a starting point for a new browser-based, data-file-first
reverse-engineering project — extracted from the reusable parts of an
existing sibling project (see `docs/architecture-overview.md` for the
general architecture this follows). This guide describes what's here, what's
a working example vs. a stub you must replace, and what to build fresh.

Seer is structured as an npm workspace: genuinely reusable, game-agnostic
code lives in scoped `packages/*` (installable independently, in principle —
see `docs/framework-plan.md` for the roadmap toward that). Everything at the
project root (`src/`, `tools/`) is **your project** — templates and
placeholders you edit and diverge from freely, not framework code.

---

## What's genuinely reusable, taken as-is (the `packages/*` workspace)

These packages have no game-specific logic and should work unmodified for
any target. Import from them; don't edit their source directly.

| Package | Contains |
|---------|----------|
| `@seer/core` | `binary.ts` — endian-aware byte-reading primitives (`r8`/`r16`/`r24`/`r32`); `binary-reader.ts` — cursor-based `BinaryReader`, endianness is a constructor param |
| `@seer/engine` | `Camera.ts` — 2D pan/zoom/bounds-clamped camera; `InputManager.ts` — keyboard + mouse input (pan, edge-scroll, wheel zoom, drag, click); `DisplayMode.ts` — zoom-bounds/scale-mode config; `Game.ts` — top-level orchestrator shape; `pixi-helpers.ts` — viewport culling, atlas slicing, label styling (PixiJS-specific; peer dep on `pixi.js`) |
| `@seer/pipeline` | Node-only: `resolveDataDir()`/`findFileCI()` — breadth-first, case-insensitive discovery of wherever the user dropped their game files; `io.ts` — generic file I/O (`readBinary`, `writePNG`, `writeIndexedPNG`, `writeJson`, `scanFilesByExtension`, `resolveDataFile`); `hex-dump.ts` — CLI binary inspector, your first tool when reverse-engineering a new format |
| `@seer/iff` | Generic EA IFF-85 FORM/chunk parser (depends on `@seer/core`). **Optional** — delete this package if your target doesn't use IFF-derived formats (8SVX, ILBM, ANIM, SMUS, or a custom FORM-based format) |
| `@seer/smus` | SMUS (Simple Musical Score) interpreter — EA IFF 85 SMUS format parser, SampledSound .instr/.ss parser, Sonix audio engine with instrument converters. **Optional** — only relevant if your target uses SMUS audio |

Also reusable as-is at the project root:

| File | What it does |
|------|---------------|
| `tsconfig.json`, `eslint.config.js`, `.prettierrc` | Standard strict TS/lint/format setup, shared across all packages |
| The `__tests__/` colocation convention | Vitest auto-discovers `*.test.ts` next to the code it tests, no config needed |

The testing *philosophy* used throughout (construct real bytes, assert on
real decoded output, never mock the decoder) is worth keeping — it validates
your reverse-engineering against actual byte-level ground truth.

---

## What's a template/pattern — the shape is right, the content is a placeholder

These files demonstrate an architecture you should keep, but contain
placeholder values you must replace as soon as you know your actual target:

- **`src/game-id.ts`** — replace `GAME_IDS`/`PLATFORM_IDS` with your real
  game(s) and platform(s). Keep the pattern (string-literal arrays + type
  guards + display names) even for a single game — it costs nothing now and
  pays off the moment you add a second platform port.
- **`tools/shared/game-config.ts`** — replace the single placeholder
  `GAME_PLATFORMS` entry with your real config(s). This is the **one file**
  you should need to edit when adding a new game or platform port. It
  re-exports the generic lookup functions from `@seer/pipeline` and defines
  a locally-narrowed `PlatformConfig` type (`game: GameId`, not bare
  `string`) so typos in your config table are still caught at compile
  time — see `docs/architecture-overview.md` §5 for why this narrowing
  lives here rather than in the library.
- **`tools/game1/export-game-data.ts`** and **`build-assets.ts`** — these are
  stage 1 / stage 2 pipeline stubs. Rename the `game1` directory to match
  your actual game ID and fill in real parsing logic once you've
  reverse-engineered the format (see below).
- **`tools/extract-game-data.ts`** — the CLI orchestration pattern (arg
  parsing, per-step failure tolerance, summary printing). Extend it with a
  third stage (e.g. audio) by following the same shape as the existing two.
- **`src/data/GameData.ts`** / **`AssetLoader.ts`** — the "one `GameAssets`
  interface, one loader function, parallel `fetch()`" convention. Replace
  the placeholder `AtlasMeta` fields with whatever your build-assets script
  actually produces.
- **`src/main.ts`** — boots `Game` from `@seer/engine` with placeholder world
  dimensions. Replace `worldWidth`/`worldHeight` with your actual content
  size once known, and adjust if you support multiple games/platforms via
  URL params.
- **`vite.config.ts`'s `serveDataDir()` plugin** — only needed if some asset
  type (typically audio) is decoded at runtime rather than precompiled.
  Delete it if your pipeline precompiles everything.

`@seer/engine`'s `Game.ts` is technically inside the packages workspace, but
unlike the rest of `@seer/engine` it's meant to be edited, not imported
as-is: it's the top-level orchestrator shape (async init → camera/input
wiring → ticker loop) with `TODO`s for your actual rendering — tilemap,
sprite layers, dialogue screens, whatever your genre needs. **This is not
assumed to be a map-based game** — see `docs/architecture-overview.md` §8.
If you outgrow the single-file template, move your game-specific rendering
logic into your own `src/` code and have it import `Camera`/`InputManager`/
`DisplayMode` from `@seer/engine` directly, rather than continuing to edit
the package file.

---

## What you'll need to build from scratch

This is the actual reverse-engineering work, and no boilerplate can do it
for you:

1. **Your container format decoder** (if the target bundles multiple assets
   into one file — a resource fork, a PAK/WAD file, ROM banks, etc). Use
   `@seer/pipeline`'s `hex-dump.ts` and `@seer/core`'s `BinaryReader` to
   start probing; write your own `parseContainer()`/`findResource()` once
   you understand the layout. If your container format is IFF-derived,
   `@seer/iff` already gives you the generic FORM/chunk parsing.
2. **Your bitmap/sprite decoder(s).** Depends entirely on the platform:
   planar bitplane graphics (Amiga/Atari ST), tile-based (SNES/Genesis),
   packed indexed pixels (VGA), etc.
3. **Your palette/colour decoder**, if the platform uses indexed colour.
4. **Your executable data-table parser**, if game data (entities, items,
   levels) is embedded directly in the executable rather than in separate
   resource files. If your target is a 68k/AmigaOS executable, the hunk-format
   loader in the sibling project's `src/assets/formats/exe-data.ts`
   (`parseHunks()`) is a reasonable reference — the table *offsets* are still
   unique to each compiled binary and must be found via disassembly.
5. **Your audio format decoder**, if applicable — `@seer/smus` is populated
   with a working SMUS interpreter if your target uses SMUS.
6. **Your actual game/rendering logic**, built out from `@seer/engine`'s
   `Game.ts` template.

---

## Suggested workflow for a new target

1. Get the original game files under `data/<game>/<platform>/`.
2. Use `npm run hex-dump -- <file>` to start probing headers and structure.
3. Write a minimal container/bitmap decoder as you understand more of the
   format, with tests constructing synthetic byte fixtures (see
   `packages/iff/src/__tests__/iff.test.ts` for the pattern).
4. Update `tools/shared/game-config.ts` with your real game+platform entry.
5. Fill in `tools/<game>/export-game-data.ts` and `build-assets.ts`.
6. Wire up `src/data/GameData.ts` / `AssetLoader.ts` to match what stage 2
   actually produces.
7. Build out `@seer/engine`'s `Game.ts` (or your own `src/` code importing
   from it) to render your actual content.
8. Run `npm test` and `npm run lint` before considering anything done.
