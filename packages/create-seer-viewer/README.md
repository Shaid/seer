# create-seer-viewer

Scaffold a standalone asset viewer for a seer project — the same viewer that
`create-seer --viewer` generates into `tools/viewer/`, extracted so it can be
scaffolded (or re-scaffolded/updated) into an existing project independently.

## Usage

```bash
npx create-seer-viewer <dir> [options]
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `--game <id>` | `mygame` | Game ID for the default game/platform selection |
| `--platform <id>` | `amiga` | Platform ID |
| `--display-name <name>` | Derived from game ID | Game name shown in the viewer header |

### Examples

```bash
npx create-seer-viewer tools/viewer
npx create-seer-viewer tools/viewer --game zonx --platform amiga --display-name "Zonx"
```

## What it generates

Four files in `<dir>`:

```
<dir>/
  index.html   Viewer entry point
  viewer.ts    Viewer logic
  viewer.css   Viewer styles
  shared.ts    Shared types
```

The generated viewer is data-driven: game/platform selectors read from a
build-emitted `games.json`, asset-type filter tabs derive from whatever is in
the manifest, and it ships a generic indexed-texture + palette WebGL2 shader
with a live palette editor and color-cycling control. See
[`docs/viewer.md`](../../docs/viewer.md) in the seer repo for the full
architecture.

## Programmatic use

```ts
import { scaffoldViewer } from 'create-seer-viewer';

scaffoldViewer('tools/viewer', { game: 'zonx', platform: 'amiga', displayName: 'Zonx' });
```

## Testing

```bash
npm test
npm run lint
```
