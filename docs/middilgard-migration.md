# Middilgard → Seer Migration Plan

This document details how to migrate middilgard from its current all-in-one
layout to consuming `@seer/*` scoped packages. The goal is to eliminate
duplicated utility code between the two projects while keeping all
middilgard-specific game logic, decoders, tools, and pipeline orchestration
in-repo.

---

## 1. Current State

Middilgard is fully self-contained — every file (binary readers, PixiJS
helpers, IFF parser, pipeline utilities) lives in-repo. Seer contains
generic, reusable versions of the same utilities as scoped `@seer/*`
packages. The two projects are siblings at `/home/ctemplet/Development/` and
share no code today.

Middilgard's `package.json` has no npm workspaces and no `@seer/*`
dependencies.

---

## 2. What Maps Where

### 2.1 `@seer/core` — Browser-safe binary utilities

| Middilgard file | Seer counterpart | Status |
|---|---|---|
| `src/utils/binary.ts` | `@seer/core` `binary.ts` | **Near-identical.** middilgard has extra `detectEndian()`, `r16()`, `r24()`, `r32()` helpers — keep these in-repo. |
| `src/utils/binary-reader.ts` | `@seer/core` `binary-reader.ts` | **Near-identical.** seer adds an `endian` constructor param (default `'be'`); middilgard hardcodes big-endian. 3 call sites need updating. |
| `src/data/AssetLoader.ts` | `@seer/core` `assets.ts` | **Not a drop-in replacement.** middilgard's loader does game-specific normalisation. Keep middilgard's version. |

### 2.2 `@seer/engine` — PixiJS game loop

| Middilgard file | Seer counterpart | Status |
|---|---|---|
| `src/engine/Camera.ts` | `@seer/engine` `Camera.ts` | **Identical.** Drop-in. |
| `src/engine/DisplayMode.ts` | `@seer/engine` `DisplayMode.ts` | **Identical.** Drop-in. |
| `src/engine/InputManager.ts` | `@seer/engine` `InputManager.ts` | **Identical** (import path differs). Drop-in. |
| `src/utils/pixi-helpers.ts` | `@seer/engine` `pixi-helpers.ts` | **Nearly identical.** seer renamed `makeMapLabelStyle` → `makeLabelStyle` and `MapLabelStyleOptions` → `LabelStyleOptions`. 6 importers need updating. |
| `src/engine/Game.ts` | `@seer/engine` `Game.ts` | **Completely different.** middilgard's Game.ts is a full 472-line implementation. seer's is a 120-line template. middilgard keeps its own Game.ts; it imports subcomponents from seer instead. |

### 2.3 `@seer/iff` — IFF container parser

| Middilgard file | Seer counterpart | Status |
|---|---|---|
| `src/assets/formats/iff.ts` | `@seer/iff` `iff.ts` | **Identical.** Drop-in. |

### 2.4 `@seer/pipeline` — Node-only offline utilities

| Middilgard file | Seer counterpart | Status |
|---|---|---|
| `tools/shared/game-config.ts` | `@seer/pipeline` `config.ts` | **Fundamentally different shapes.** See §4 below. |
| `tools/shared/io.ts` | `@seer/pipeline` `io.ts` | **Partial overlap.** seer has `readBinary`, `writePNG`, `writeJson`, `resolveDataFile`. middilgard adds `loadRes`, `resType`, `detectPlatform`, `scanResFiles`. Keep middilgard's io.ts, use seer for the generic parts. |
| `tools/shared/hex-dump.ts` | `@seer/pipeline` `hex-dump.ts` | seer's `hexDump()` is more parameterised. middilgard can switch to it. |

### 2.5 What stays entirely in middilgard

All game-specific code has no seer counterpart and stays in-repo:

- **Binary format decoders** (`src/assets/formats/*`) — resource-fork, imag,
  frml, mmap, char-tiles, bscene, exe-data, smus, sampled-sound, save-data,
  palette, binary-tables, strategic-icons-catalog
- **Engine systems** (`src/engine/*`) — Game.ts, GameTimer, MovementSystem,
  MusicManager, smus-engine
- **Map rendering** (`src/map/*`) — TileMap, LocationLayer, ItemLayer,
  SettlementLayer
- **Entity system** (`src/entities/*`) — EntityManager, icon-mapping
- **UI** (`src/ui/*`) — LayerPanel, TileInfoPanel
- **Data types** (`src/data/GameData.ts`, scene-compositor, asset-mappings)
- **Game identity** (`src/game-id.ts`)
- **All per-game tools** (`tools/wime/`, `tools/spirit/`, etc.)
- **Shared tools with no seer equivalent** — manifest-types, build-viewer-assets,
  build-music-manifest, viewer-config, smus-player, res-catalog
- **Pipeline orchestration** (`tools/extract-game-data.ts`)

---

## 3. Prerequisites (seer side)

Before middilgard can consume seer packages, a few things need resolving on
the seer side first.

### 3.1 Export `makeLabelStyle` + `LabelStyleOptions` from `@seer/engine`

seer's `pixi-helpers.ts` already exports these under the new names.
middilgard will adopt the new names (the `makeMapLabelStyle` name was only
ever used for WIME's map labels — the function is generic).

### 3.2 Export `dataViewOf` from `@seer/core`

seer's `binary.ts` exports `dataViewOf`. Verify it matches middilgard's
version (it does — both create a `DataView` over a `Uint8Array` with
safe bounds).

### 3.3 Export `detectEndian` from `@seer/core` (or keep locally)

`detectEndian()` reads the first u32 to auto-detect Amiga (big-endian) vs
DOS (little-endian) byte order. Only used by `resource-fork.ts`. Option A:
seer core exports it. Option B: middilgard keeps its own copy. **Recommend
Option B** — it's 13 lines, game-specific, and `@seer/core` aims to stay
minimal.

### 3.4 Verify `BinaryReader` endian param doesn't break existing callers

seer's `BinaryReader` accepts `new BinaryReader(buffer, offset, endian)`.
The default is `'be'` — identical to middilgard's hardcoded behaviour. So
switching to seer's `BinaryReader` requires **zero changes** to existing
`new BinaryReader(buffer)` call sites. The 3 files that import `BinaryReader`
(`iff.ts`, `smus.ts`, `sampled-sound.ts`) can switch to `@seer/core`'s
export without modifying their constructor calls.

### 3.5 ~~Decide on `@seer/smus` vs keeping SMUS in middilgard~~ ✓ DONE

**Resolved: Option B — SMUS upstreamed to `@seer/smus`.**

The full SMUS implementation (parser, sampled-sound parser, Sonix engine,
instrument converters, 8 engine tests) now lives in `@seer/smus` as a
working reference implementation of the Sonix-style SMUS format.middilgard
re-exports from `@seer/smus` for backward compatibility — existing importers
are unchanged.

---

## 4. The Config Shape Problem

This is the biggest migration challenge. The two projects model game
configuration differently.

### middilgard's shape (structured `resFiles`)

```ts
interface GamePlatformConfig {
  game: GameId;
  platform: PlatformId;
  displayName: string;
  dataDirs: string[];
  executable?: string;
  supported: boolean;
  assetDir: string;
  resFiles: {
    map: string;        // e.g. 'AMaps.res'
    scene: string[];    // e.g. ['BScene.res', 'AScene.res']
    anims: string;      // e.g. 'AAnims.res'
    text: string;       // e.g. 'AText.res'
    all: string[];      // every .res file for this game+platform
  };
  music: boolean;
  tilesAndMap: boolean;
  typeCodes?: Record<string, string>;
}
```

### seer's shape (flat `PlatformConfig` + step functions)

```ts
interface PlatformConfig {
  game?: string;
  platform: string;
  dataDirs: string[];
  executable?: string;
  expectedFiles: string[];
  supported: boolean;
  assetDir: string;
  typeCodes?: Record<string, string>;
  features?: Record<string, boolean>;
  exportGameData?: (config: PlatformConfig, dataDir: string) => void | Promise<void>;
  buildAssets?: (config: PlatformConfig, dataDir: string) => void | Promise<void>;
}
```

### The mismatch

| Aspect | middilgard | seer |
|---|---|---|
| Resource file mapping | `resFiles.map`, `resFiles.scene[]`, etc. | `expectedFiles: string[]` (flat) |
| Feature flags | `music: boolean`, `tilesAndMap: boolean` | `features?: Record<string, boolean>` |
| Step registration | Dispatched via `execSync` to script files | Functions on `PlatformConfig` |
| Game-level grouping | None (flat array, `game` field on each entry) | Nested `GameConfig[]` with `platforms[]` |

### Recommended approach: adapter layer

Middilgard keeps its own config shape as the source of truth and adds an
adapter that converts it to seer's format when calling seer functions.
This avoids rewriting the entire config table (10+ entries, each with
structured `resFiles`) and preserves the typed resource-file mapping that
middilgard's tools depend on.

```ts
// tools/shared/seer-adapter.ts
import type { GameConfig, PlatformConfig } from '@seer/pipeline';
import { GAME_PLATFORMS, type GamePlatformConfig } from './game-config.ts';

/** Convert middilgard's config to seer's GameConfig[] shape. */
export function toSeerConfigs(): GameConfig[] {
  const byGame = new Map<string, GamePlatformConfig[]>();
  for (const p of GAME_PLATFORMS) {
    const list = byGame.get(p.game) ?? [];
    list.push(p);
    byGame.set(p.game, list);
  }

  return [...byGame.entries()].map(([gameId, platforms]) => ({
    id: gameId,
    displayName: platforms[0].displayName,
    platforms: platforms.map((p) => ({
      game: p.game,
      platform: p.platform,
      dataDirs: p.dataDirs,
      executable: p.executable,
      expectedFiles: p.resFiles.all,
      supported: p.supported,
      assetDir: p.assetDir,
      typeCodes: p.typeCodes,
      features: { music: p.music, tilesAndMap: p.tilesAndMap },
    })),
  }));
}
```

middilgard's own tools continue to import from `game-config.ts` directly
(they need the structured `resFiles` fields). seer functions (`runPipeline`,
`resolveDataDir`, `getGameConfig`, etc.) receive the adapted configs.

---

## 5. Migration Steps

Ordered from lowest risk to highest. Each step is independently shippable —
middilgard should pass all tests and build cleanly after each one.

### ~~Step 1: Upstream SMUS to `@seer/smus`~~ ✓ DONE

The full SMUS implementation (parser, sampled-sound parser, Sonix engine,
instrument converters, 8 engine tests) now lives in `@seer/smus`.
middilgard re-exports from `@seer/smus` for backward compatibility — all
existing importers unchanged. Three local files are now thin re-export shims:
`src/assets/formats/smus.ts`, `src/assets/formats/sampled-sound.ts`,
`src/engine/smus-engine.ts`.

### ~~Step 2: Add `@seer/*` dependencies to middilgard's `package.json`~~ ✓ DONE

All six `@seer/*` packages added as `file:../seer/packages/*` dependencies:
`@seer/core`, `@seer/engine`, `@seer/iff`, `@seer/pipeline`, `@seer/smus`.

### ~~Step 3: Replace `src/assets/formats/iff.ts` with `@seer/iff`~~ ✓ DONE

`iff.ts` deleted. `iff.test.ts` imports from `@seer/iff`. Barrel re-export in
`src/utils/index.ts`. `binary-reader.test.ts` deleted (seer has its own).
`smus.ts`/`sampled-sound.ts` already re-export shims — no changes needed.

**Verified:** `npm test`, `npm run lint`

### ~~Step 4: Replace `src/utils/binary-reader.ts` with `@seer/core`~~ ✓ DONE

`binary-reader.ts` deleted. `src/utils/index.ts` imports `BinaryReader` from
`@seer/core`.

**Verified:** `npm test`, `npm run lint`

### ~~Step 5: Replace `src/utils/binary.ts` with `@seer/core` (partial)~~ ✓ DONE

`binary.ts` imports `dataViewOf` from `@seer/core` and re-exports it.
middilgard-specific helpers (`detectEndian`, `r16`, `r24`, `r32`, `Endianness`)
kept locally.

**Verified:** `npm test`, `npm run lint`

### ~~Step 6: Replace `src/utils/pixi-helpers.ts` with `@seer/engine`~~ ✓ DONE

`pixi-helpers.ts` deleted. All call sites updated to import from `@seer/engine`
with renamed functions (`makeMapLabelStyle` → `makeLabelStyle`,
`MapLabelStyleOptions` → `LabelStyleOptions`). 6 call sites across 5 files
updated: `TileMap.ts`, `LocationLayer.ts`, `ItemLayer.ts`, `SettlementLayer.ts`,
`EntityManager.ts`.

**Verified:** `npm test`, `npm run lint`, `npx tsc --noEmit`

### ~~Step 7: Replace engine subcomponents with `@seer/engine`~~ ✓ DONE

`Camera.ts`, `DisplayMode.ts`, `InputManager.ts` deleted. 11 import sites across
8 files updated to import from `@seer/engine` directly — no aliases.
`Game.ts` kept, only its imports changed.

**Verified:** `npm test`, `npm run lint`, `npx tsc --noEmit`

### Step 8: Wire `@seer/pipeline` for CLI commands (optional)

middilgard can adopt seer's `seer extract`/`seer hex-dump`/`seer doctor`
CLI binary for developer-facing DX, while keeping its own
`extract-game-data.ts` for the full pipeline (which dispatches to game-specific
scripts via `execSync`).

This step is optional — the CLI is a convenience, not a requirement.

To enable it, add a `bin` entry to middilgard's `package.json`:

```json
{
  "bin": {
    "middilgard": "./node_modules/@seer/pipeline/bin/seer.mjs"
  }
}
```

And create `seer.config.ts` at the project root (using the adapter from §4):

```ts
import { defineGameConfig } from '@seer/pipeline';
import { toSeerConfigs } from './tools/shared/seer-adapter.ts';

export default defineGameConfig(toSeerConfigs());
```

**Verify:** `npx middilgard doctor`, `npx middilgard extract --game wime --platform amiga`

### Step 9: Adopt seer's pipeline utilities in tools (optional)

middilgard's `tools/shared/io.ts` partially overlaps with seer's pipeline
`io.ts`. middilgard can switch the generic functions to seer's versions:

| Function | Action |
|---|---|
| `readBinary` | Switch to `@seer/pipeline`'s `readBinary` |
| `writePNG` | Switch to `@seer/pipeline`'s `writePNG` |
| `writeJson` | Switch to `@seer/pipeline`'s `writeJson` |
| `hexDump` | Switch to `@seer/pipeline`'s `hexDump` |
| `loadRes` | **Keep** — middilgard-specific (loads resource forks) |
| `resType` | **Keep** — middilgard-specific (platform type codes) |
| `detectPlatform` | **Keep** — middilgard-specific |
| `resolveResFile` | **Keep** — middilgard-specific |
| `scanResFiles` | **Keep** — middilgard-specific |

This is a partial adoption — middilgard's `io.ts` shrinks but keeps its
game-specific functions. The `DEFAULT_DATA_DIR` and re-exports from
`game-config.ts` stay.

**Verify:** `npm test`, `npm run lint`, full pipeline run (`npm run extract-data`)

---

## 6. What NOT to Migrate

These items stay entirely in middilgard and should not be touched during
this migration:

- `src/assets/formats/*` — all binary format decoders (resource-fork, imag,
  frml, mmap, char-tiles, bscene, exe-data, smus, sampled-sound, save-data,
  palette, binary-tables, strategic-icons-catalog)
- `src/engine/Game.ts` — full game implementation (consumes seer subcomponents
  but is middilgard-specific)
- `src/engine/GameTimer.ts`, `MovementSystem.ts`, `MusicManager.ts`,
  `smus-engine.ts` — game-specific engine systems
- `src/map/*`, `src/entities/*`, `src/ui/*` — rendering and UI
- `src/data/*` — game-specific data types and asset loading
- `src/game-id.ts` — game/platform identifiers (middilgard-specific enum values)
- `tools/wime/`, `tools/spirit/`, `tools/vengeance/`, `tools/conan/`,
  `tools/legend/` — all per-game extraction/build scripts
- `tools/shared/manifest-types.ts`, `build-viewer-assets.ts`,
  `build-music-manifest.ts`, `viewer-config.ts`, `smus-player.ts`,
  `res-catalog.ts` — shared tools with no seer equivalent
- `tools/extract-game-data.ts` — middilgard's own pipeline orchestration
  (uses `execSync` to dispatch to game-specific scripts; seer's `runPipeline`
  expects in-process step functions)

---

## 7. File-Level Summary

| Action | Files |
|---|---|
| **Delete** | `src/utils/binary-reader.ts`, `src/utils/pixi-helpers.ts`, `src/assets/formats/iff.ts` |
| **Rewrite** | `src/utils/binary.ts` (re-export `dataViewOf` from seer, keep local helpers) |
| **Rewrite** | `src/utils/index.ts` (re-export from `@seer/core`, `@seer/engine`, `@seer/iff`) |
| **Re-export** | `src/engine/Camera.ts`, `src/engine/DisplayMode.ts`, `src/engine/InputManager.ts` |
| **Rename** | `makeMapLabelStyle` → `makeLabelStyle` in 5 files |
| **Add** | `package.json` `@seer/*` dependencies |
| **Add** | `tools/shared/seer-adapter.ts` (config adapter) |
| **Optional** | `seer.config.ts` at project root |
| **Keep** | Everything else (35+ files unchanged) |

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| seer `BinaryReader` API diverges from middilgard's usage | Low | High | seer's `BinaryReader` is a superset — defaults match, extra param is opt-in |
| seer `pixi-helpers.ts` changes break middilgard | Low | Medium | Function signatures are stable; rename is one-time |
| `@seer/pipeline` config shape evolves further | Medium | Medium | Adapter layer isolates middilgard from seer config changes |
| seer `@seer/core` or `@seer/engine` publish breaking changes | Medium | High | Pin to exact versions; update during seer's semver discipline rollout (§10) |
| `file:../seer` link breaks when seer packages change | Low | Low | Expected during active iteration — both repos are local |

---

## 9. Success Criteria

After migration, the following must hold:

1. `npm test` passes (all existing middilgard tests)
2. `npm run lint` passes
3. `npx tsc --noEmit` passes
4. `npm run extract-data` runs the full pipeline for all games
5. `npm run dev` launches the browser game and it works
6. `npm run build-assets` produces correct output
7. No `@seer/*` function is called with arguments that would fail at runtime
   (verify by running the full pipeline end-to-end)

---

## 10. Sequencing Notes

Progress:

- **Steps 1–7:** ✓ DONE — all core/engine/iff/smus packages integrated
- **Step 8 (CLI):** optional — defer until seer's config shape stabilises
- **Step 9 (pipeline IO):** optional — defer until pipeline adoption
