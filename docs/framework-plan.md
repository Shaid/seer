# Framework Plan

This document maps out what would need to change for Seer to become an
installable framework (`npm install seer`, `import { Camera } from
'seer/engine'`) rather than a clone-and-edit boilerplate. It's a plan, not
a commitment — nothing here has been implemented yet. See
`docs/boilerplate-guide.md` for the current, as-shipped state.

The core tension: a boilerplate can freely mix "infrastructure code" (stable,
generic, meant to be imported) with "project code" (meant to be edited
forever, forked, and diverged from). A framework can't — anything importable
has to stay generic and stable, while anything project-specific has to move
out of the package and into the consumer's own repo. Almost every change
below follows from resolving that tension in one place or another.

---

## 1. Split the library from the starter

The single biggest structural change. Two separate deliverables instead of
one repo:

- **`seer` (or scoped `@seer/*` packages)** — an actual npm dependency
  containing only genuinely generic code: binary utilities, the IFF parser,
  `Camera`/`InputManager`/`DisplayMode`, the pipeline orchestrator,
  `resolveDataDir`. Consumers `npm install` this and never edit its source.
- **`create-seer`** — a scaffolding CLI (`npm create seer@latest`, following
  the `create-vite`/`create-vitest` convention) that generates a new project
  pre-wired to import from `seer`, with placeholder config files, a starter
  `Game` subclass, and stub pipeline scripts for the user to fill in and
  keep in their own repo.

Everything that's currently a "template to fill in" in
`docs/boilerplate-guide.md` (game-id.ts's placeholder values, `tools/game1/`,
`Game.ts`'s TODOs) moves into the `create-seer` output, not the `seer`
package itself.

## 2. Config-as-data instead of config-as-source-you-edit

`tools/shared/game-config.ts` currently expects the user to edit
`GAME_PLATFORMS` directly — that only works because the file lives in the
consumer's own repo today. Once it's inside `node_modules`, editing it is
impossible (and wrong even if it were possible). Replace it with a
`defineConfig()`-style API, following the same pattern as Vite/Vitest/ESLint
flat config:

```ts
// consumer's own seer.config.ts, in their repo
import { defineGameConfig } from '@seer/pipeline';

export default defineGameConfig([
  {
    id: 'mygame',
    displayName: 'My Game',
    platforms: [
      {
        platform: 'amiga',
        dataDirs: ['mygame/amiga'],
        executable: 'MYGAME',
        expectedFiles: ['MYGAME'],
        assetDir: 'mygame',
      },
      {
        platform: 'dosvga',
        dataDirs: ['mygame/dosvga'],
        executable: 'MYGAME.EXE',
        expectedFiles: ['MYGAME.EXE', 'DATA.DAT'],
        assetDir: 'mygame',
      },
    ],
  },
]);
```

The framework loads this file (similar to how Vite loads `vite.config.ts`)
rather than importing a hardcoded array from its own source. `GameConfig[]`
is nested — each game entry groups its platforms together, so shared
metadata (like `displayName`) is defined once rather than repeated per
platform.

## 3. Plugin registration instead of naming-convention script dispatch

`extract-game-data.ts` currently shells out to `tools/<game>/export-game-data.ts`
by string convention via `execSync`, resolved relative to the framework's own
`tools/` directory. That only works when the orchestrator and the per-game
scripts live in the same repo. As a library, the orchestrator should accept
**registered functions** from the consumer's config instead of file paths:

```ts
export default defineGameConfig([
  {
    id: 'mygame',
    displayName: 'My Game',
    platforms: [
      {
        platform: 'amiga',
        dataDirs: ['mygame/amiga'],
        executable: 'MYGAME',
        expectedFiles: ['MYGAME'],
        assetDir: 'mygame',
        exportGameData: async (cfg, dataDir) => {
          /* consumer's own reverse-engineered parsing */
        },
        buildAssets: async (cfg, dataDir) => {
          /* consumer's own asset building */
        },
      },
      {
        platform: 'dosvga',
        dataDirs: ['mygame/dosvga'],
        executable: 'MYGAME.EXE',
        expectedFiles: ['MYGAME.EXE', 'DATA.DAT'],
        assetDir: 'mygame',
        // Step functions registered per platform — share a reference
        // or assign different implementations per platform as needed.
        exportGameData: myAmigaExport, // or a different fn for DOS
        buildAssets: myAmigaAssets,
      },
    ],
  },
]);
```

The orchestrator (`runPipeline()`) keeps the parts that are genuinely
reusable — CLI arg parsing, per-step failure tolerance, the summary
printout — but calls into consumer-registered functions instead of resolving
file paths by convention.

## 4. A real CLI binary

`npx tsx tools/extract-game-data.ts` only makes sense when the consumer owns
the `tools/` folder and has `tsx` as a devDependency by convention. A package
needs a `bin` entry in `package.json` so consumers get a proper command
regardless of their own project layout:

```bash
npx seer extract --game mygame --platform myplatform
npx seer hex-dump data/mygame/myplatform/GAME.EXE
npx seer doctor   # sanity-check the resolved config against disk
```

This also opens the door to consumer-facing DX polish (`seer doctor`,
`--help` text generated from the config schema, etc.) that isn't worth
building into a one-off `tools/` script.

## 5. Generalize the fixed data shapes

`GameData.ts`/`AssetLoader.ts` currently hardcode a specific shape
(`AtlasMeta`, fetching a fixed `atlas.json`). A library can't predict what
shape your reverse-engineered data actually takes — this needs to become a
generic helper instead of a template file:

```ts
import { createAssetLoader } from 'seer/data';

interface MyGameAssets {
  atlas: AtlasMeta;
  map: MyMapData;
}

const assets = await createAssetLoader<MyGameAssets>(basePath, {
  atlas: 'atlas.json',
  map: 'map.json',
});
```

The consumer's own `MyGameAssets` type (currently `GameData.ts`) stays in
their repo; only the generic `createAssetLoader<T>()` mechanism ships in the
package.

## 6. `Game` as a base class or composed factory, not a file you edit

Right now the render-loop TODOs live inline in a file the consumer owns
outright. As a library export, editing framework internals to add your
rendering isn't an option — it needs to be either an abstract base class
with lifecycle hooks, or a factory function taking callbacks, so upgrading
the package version doesn't require re-merging local edits into framework
code:

```ts
import { BaseGame } from 'seer/engine';

class MyGame extends BaseGame {
  protected onInit() {
    /* build your sprite layers, tilemap, etc. */
  }
  protected onUpdate() {
    /* per-frame logic */
  }
}
```

or, if composition is preferred over inheritance:

```ts
import { createGame } from 'seer/engine';

const game = createGame({
  container,
  worldWidth,
  worldHeight,
  onInit: (ctx) => {
    /* ... */
  },
  onUpdate: (ctx) => {
    /* ... */
  },
});
```

## 7. Stop hardcoding the data root relative to `process.cwd()`

`resolveDataDir()` currently assumes the data root is `<cwd>/data`. A library
should accept the data root as an explicit parameter (defaulting to `./data`
for convenience), so it works regardless of where the consumer's project
structure puts things, and so the CLI can support `--data-dir` for
non-standard layouts.

## 8. Package boundaries enforce the browser/Node split structurally

The "`tools/` may import `src/`, never the reverse" rule is currently just a
convention documented in AGENTS.md/architecture-overview.md — nothing stops
someone from accidentally importing `node:fs` into browser-bundled code. As
real packages, this becomes structural instead of a code-review catch:

- `@seer/pipeline` — Node-only, uses `fs`/`path`, never imported by browser code
- `@seer/engine-2d`, `@seer/core` — browser-safe, zero Node built-ins
- `package.json` `exports` conditions (and/or separate packages entirely) make
  cross-importing a module-resolution error rather than a silent mistake

This likely means an actual npm/pnpm workspace (or a Turborepo-style
monorepo) rather than a single flat `src/`/`tools/` split.

## 9. Peer dependencies instead of bundled dependencies

PixiJS should become a `peerDependency` of `@seer/engine-2d` rather than a
regular `dependency`. Consumers likely already pin their own PixiJS version;
bundling a second copy risks duplicate/conflicting instances in their build.
Similarly `pngjs` for `@seer/pipeline` if consumers already depend on it.

## 10. Semver discipline and a real release process

A boilerplate has no compatibility contract — you copy it once and diverge
immediately. A framework does: once a consumer's `package.json` pins
`seer: ^1.2.0`, changes to `BinaryReader`'s constructor signature or
`Camera`'s public API are breaking changes with real consequences. This
means adopting:

- Conventional commits or Changesets for versioning
- A documented deprecation policy before removing public API surface
- CI that runs the test suite against the published package shape, not just
  the source tree

---

## Suggested sequencing

These changes have real dependencies on each other; a rough build order.
Package names below follow the scoped layout decided in the
Resolved decisions section.

1. **Workspace scaffolding** — create the pnpm workspace root and the
   individual package directories (`packages/core`, `packages/engine`,
   `packages/pipeline`, `packages/iff`, `packages/smus`). Move existing
   code into the appropriate package based on the table. Establish the
   browser/Node boundary now: `pipeline` and `iff`/`smus` get their own
   `tsconfig` targeting Node, `core` and `engine` stay ES-module-only with
   no Node built-ins in their import graph. This is the structural
   foundation everything else lands on.

2. **Config-as-data + plugin registration** (§2, §3) — design and
   implement `defineGameConfig()` and `runPipeline()` in `@seer/pipeline`.
   The config schema is the API contract that `create-seer` templates,
   the CLI, and middilgard's own config all need to target, so stabilise
   it before anything downstream depends on it.

3. **CLI binary** (§4) — add the `bin` entry to `@seer/pipeline`'s
   `package.json`. Depends on the config/plugin API being settled.

4. **Generalize `AssetLoader` and `Game`** (§5, §6) — `createAssetLoader<T>()`
   lands in `@seer/pipeline`, `BaseGame` or `createGame()` lands in
   `@seer/engine-2d`. These are independent of each other and can be done in
   parallel.

5. **Data root parameterization** (§7) — small change to `resolveDataDir`
   in `@seer/pipeline`, can land any time before the CLI ships `--data-dir`.

6. **Peer dependencies + release process** (§9, §10) — once the public
   API surface of each package is stable enough to commit to, switch PixiJS
   to a peer dep in `@seer/engine-2d`, adopt conventional commits or
   Changesets, and cut the first real release.

7. **Build `create-seer`** — once the package API and config schema are
   settled, build the scaffolding CLI. The templates it generates need to
   target a stable `@seer/*` API surface, so this comes last.

8. **Wire middilgard back to the packages** — replace middilgard's local
   `file:../seer` dependency with proper scoped-package imports
   (`@seer/core`, `@seer/pipeline`, etc.). This is when middilgard
   becomes a normal consumer of the framework rather than a sibling repo.
   Happens after the packages are stable enough that middilgard isn't
   constantly chasing breaking changes during active iteration.

## Resolved decisions

**Scoped packages (`@seer/*`) instead of a single package with subpath exports.**
Each package is independently installable, so consumers only pull in what
they need. Format-specific code (IFF parser, resource-fork decoder, SMUS
interpreter) goes in its own optional package — not every target uses IFF,
so it shouldn't be a mandatory dependency for everyone. Browser/Node
separation also becomes structural: `@seer/pipeline` imports `node:fs`,
`@seer/engine-2d` never can, and that's enforced at install time rather than
by convention.

As-built package layout (updated post-implementation — see note below on the
one deliberate deviation from the originally suggested layout):

| Package | Environment | Contains |
|---|---|---|
| `@seer/core` | browser-safe | `BinaryReader`, `binary.ts`, `loadAssets`/`createAssetLoader` |
| `@seer/engine-2d` | browser-safe | `Camera`, `InputManager`, `DisplayMode`, `Game`, `createGame`, `pixi-helpers.ts` (peer dep: PixiJS) |
| `@seer/pipeline` | Node-only | `PlatformConfig`, `GameConfig`, `defineGameConfig`, `flattenConfigs`, `resolveDataDir`, `runPipeline`, CLI binary (`seer extract`/`hex-dump`/`doctor`), hex-dump |
| `@seer/iff` | Node-only | IFF-85 parser, resource-fork decoder (optional: install only if your target uses IFF containers) |
| `@seer/smus` | Node-only | SMUS interpreter (optional: install only if your target uses SMUS audio) |

**Deviation from the originally suggested layout:** `createAssetLoader`
(§5) was initially placed in `@seer/pipeline` per the table above, following
this document's own original wording literally. This was a mistake caught
during implementation review — `@seer/pipeline` is Node-only and must never
be imported by browser-bundled code (see §8 above), but `createAssetLoader`
is called from the consumer's *browser* runtime code (`src/data/
AssetLoader.ts`) to fetch preprocessed assets at play time. Verified by
actually wiring it up and rebuilding: bundling `@seer/pipeline` into the
browser build pulled in `pngjs` and forced Vite to externalize several
Node built-ins. Moved to `@seer/core` instead, which is genuinely
browser-safe and has zero dependencies. `pixi-helpers.ts` similarly ended
up in `@seer/engine-2d` rather than `@seer/core` as originally suggested,
since it needs PixiJS types and `@seer/core` is meant to stay
dependency-free — this one was caught before implementation, not after.

**Pipeline steps may be sync or async.** `PipelineStep` is typed as
`(config, dataDir) => void | Promise<void>`, and `runPipeline`/`runStep`
`await` every step call before checking success. This matters because a
consumer's `exportGameData`/`buildAssets` implementation will often need to
`await` disk I/O — an earlier draft of the orchestrator called steps
without awaiting, which meant an error thrown *after* an `await` inside an
async step became an unhandled rejection instead of being caught and
reported as a failed step.

**Config shape is nested `GameConfig[]`, not a flat array of one entry per
game+platform.** The worked examples in §2/§3 above match the actual
implementation: `GameConfig[]` where each entry is `{ id, displayName,
platforms: PlatformConfig[] }`. Step functions (`exportGameData`,
`buildAssets`) live directly on `PlatformConfig` — each platform registers
its own functions, and `runPipeline` flattens the nested structure internally
when iterating. This keeps the config readable (shared game metadata defined
once, per-platform details grouped together) while `resolveDataDir`/
`getGameConfig`/`getSupportedPlatforms` all accept `GameConfig[]` directly.
`flattenConfigs()` is still exported for consumers who need a flat list for
convenience helpers (like `GAME_PLATFORMS` in the shared tools), but is not
required for pipeline usage.

**Always scaffold multi-game/multi-platform, with one game/platform
pre-configured.** The scaffolded `seer.config.ts` ships with a single
game and platform entry filled in, but the structure is already multi-game
ready. Retrofitting the second game later means adding a config entry,
not a structural migration — which is exactly the kind of refactoring
`docs/refactoring.md`-style efforts were written to avoid.

**Format-specific abstractions are consumer-side only.** `@seer/core` ships
the `BinaryReader` pattern and the IFF container interface (`findResource`,
`findResourcesByType`), but no concrete container decoders. Concrete
implementations live in the target-specific packages (`@seer/iff`,
`@seer/smus`), or entirely in the consumer's own repo. This avoids
over-abstracting a pattern that diverges the moment a second target
needs different field semantics from the same container shape.
