# @seer/pipeline

Node-only utilities for the offline data extraction pipeline.

Handles the conversion of original game data files (executables, ROMs,
resource archives) into web-native formats (JSON + PNG) via a configurable
two-stage pipeline. **Node.js only** — never imported by browser-bundled
code.

## Installation

```bash
npm install @seer/pipeline
```

Requires `pngjs ^7.0.0` as a peer dependency (for PNG writing).

## CLI

```bash
npx seer <command> [options]
```

| Command | Description |
| --- | --- |
| `extract [--game <id>] [--platform <id>] [--data-dir <path>]` | Run the offline extraction pipeline |
| `hex-dump <file> [offset] [length]` | Inspect binary file contents as hex + ASCII |
| `doctor [--data-dir <path>]` | Sanity-check the resolved config against disk |
| `--help`, `-h` | Show usage |

### Config file

The CLI reads `seer.config.ts` (or `.js` / `.mjs`) from the project root.
The config file exports a `GameConfig[]` array defining games and their
platforms:

```ts
import { defineGameConfig } from '@seer/pipeline';

export default defineGameConfig([{
  id: 'mygame',
  displayName: 'My Game',
  platforms: [{
    platform: 'amiga',
    dataDirs: ['mygame/amiga'],
    executable: 'mygame',
    expectedFiles: ['mygame'],
    supported: true,
    assetDir: 'mygame',
    exportGameData: async (cfg, dataDir) => { /* ... */ },
    buildAssets: async (cfg, dataDir) => { /* ... */ },
  }],
}]);
```

## Pipeline stages

1. **Stage 1 — `exportGameData`**: Parse game executables/data tables and
   write raw JSON to `data/extracted/<game>/`.
2. **Stage 2 — `buildAssets`**: Decode resource files into web-native
   PNG + JSON assets in `public/assets/<game>/<platform>/`.

## Programmatic API

```ts
import { runPipeline } from '@seer/pipeline';
import { defineGameConfig } from '@seer/pipeline';

const configs = defineGameConfig([/* ... */]);
const results = await runPipeline(configs, { game: 'mygame', platform: 'amiga' });
```

## Config helpers

| Function | Description |
| --- | --- |
| `defineGameConfig(config)` | Typed wrapper for `GameConfig[]` |
| `flattenConfigs(configs)` | Flatten nested `GameConfig[]` to `PlatformConfig[]` |
| `resolveDataDir(platformConfig, dataDir?)` | Find the data directory on disk |
| `findFileCI(dir, name)` | Case-insensitive filename lookup |
| `resType(platformConfig, logical)` | Map a logical resource type (e.g. `'imag'`) to its platform-specific code via `platformConfig.typeCodes`, uppercased fallback if unmapped |

## File I/O

| Function | Description |
| --- | --- |
| `readBinary(path)` | Read a file as `Uint8Array` |
| `writeJson(path, data, pretty?)` | Write data as formatted JSON |
| `writePNG(path, rgba, width, height)` | Write an RGBA PNG image |
| `writeIndexedPNG(path, indices, width, height, opts?)` | Write a palette-indexed PNG (index value in the R channel — not resolved colors). `opts.transparentIndex` (default `0`) picks which index renders transparent; pass `null` to make every index opaque |
| `writeWav(path, channels, opts)` | Write PCM samples as a RIFF/WAVE file. `channels` is one array per channel (`[mono]` or `[left, right]`); `opts.bits: 8` expects raw `Uint8Array` samples copied byte-for-byte, `opts.bits: 16` (default) expects normalized `Float32Array` samples in `[-1, 1]`, quantized to 16-bit PCM |
| `resolveDataFile(dataDir, candidates)` | First matching filename from a list of casing candidates, or the first candidate if none exist |
| `scanFilesByExtension(dir, ext)` | Find files by extension, case-insensitive, sorted |

## Testing

```bash
npm test
npm run lint
```
