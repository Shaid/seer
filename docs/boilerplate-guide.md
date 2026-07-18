# Boilerplate Guide

Seer is a starting point for a new browser-based, data-file-first
reverse-engineering project — extracted from the reusable parts of an
existing sibling project (see `docs/architecture-overview.md` for the
general architecture this follows). This guide describes what's here, what's
a working example vs. a stub you must replace, and what to build fresh.

---

## What's genuinely reusable, taken as-is

These files have no game-specific logic and should work unmodified for any
target:

| File | What it does |
|------|---------------|
| `tsconfig.json`, `eslint.config.js`, `.prettierrc` | Standard strict TS/lint/format setup |
| `src/utils/binary.ts` | Endian-aware byte-reading primitives (`r8`/`r16`/`r24`/`r32`) |
| `src/utils/binary-reader.ts` | Cursor-based `BinaryReader`, endianness is a constructor param |
| `src/assets/formats/iff.ts` | Generic EA IFF-85 FORM/chunk parser (delete if your target doesn't use IFF) |
| `src/engine/Camera.ts` | 2D pan/zoom/bounds-clamped camera |
| `src/engine/InputManager.ts` | Keyboard + mouse input (pan, edge-scroll, wheel zoom, drag, click) |
| `src/engine/DisplayMode.ts` | Zoom-bounds/scale-mode config object |
| `src/utils/pixi-helpers.ts` | Viewport culling, atlas slicing, label styling (PixiJS-specific) |
| `tools/shared/hex-dump.ts` | CLI binary inspector — your first tool when reverse-engineering a new format |
| `tools/shared/io.ts` | Generic file I/O: `readBinary`, `writePNG`, `writeIndexedPNG`, `writeJson`, `scanFilesByExtension`, `resolveDataFile` |
| `tools/shared/game-config.ts`'s `resolveDataDir()` / `findFileCI()` | Breadth-first, case-insensitive discovery of wherever the user dropped their game files |
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
  you should need to edit when adding a new game or platform port.
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
- **`src/engine/Game.ts`** — the top-level orchestrator shape (async init →
  camera/input wiring → ticker loop). Replace the `TODO`s with your actual
  rendering: tilemap, sprite layers, dialogue screens, whatever your genre
  needs. **This is not assumed to be a map-based game** — see
  `docs/architecture-overview.md` §8.
- **`vite.config.ts`'s `serveDataDir()` plugin** — only needed if some asset
  type (typically audio) is decoded at runtime rather than precompiled.
  Delete it if your pipeline precompiles everything.

---

## What you'll need to build from scratch

This is the actual reverse-engineering work, and no boilerplate can do it
for you:

1. **Your container format decoder** (if the target bundles multiple assets
   into one file — a resource fork, a PAK/WAD file, ROM banks, etc). Use
   `hex-dump.ts` and `BinaryReader` to start probing; write your own
   `parseContainer()`/`findResource()` once you understand the layout.
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
5. **Your audio format decoder**, if applicable.
6. **Your actual game/rendering logic** in `src/engine/`.

---

## Suggested workflow for a new target

1. Get the original game files under `data/<game>/<platform>/`.
2. Use `npm run hex-dump -- <file>` to start probing headers and structure.
3. Write a minimal container/bitmap decoder as you understand more of the
   format, with tests constructing synthetic byte fixtures (see
   `src/assets/formats/__tests__/iff.test.ts` for the pattern).
4. Update `tools/shared/game-config.ts` with your real game+platform entry.
5. Fill in `tools/<game>/export-game-data.ts` and `build-assets.ts`.
6. Wire up `src/data/GameData.ts` / `AssetLoader.ts` to match what stage 2
   actually produces.
7. Build out `src/engine/Game.ts` to render your actual content.
8. Run `npm test` and `npm run lint` before considering anything done.
