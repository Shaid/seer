# create-seer

CLI tool to scaffold a new [Seer](https://github.com/Shaid/seer)
project with multi-game/multi-platform support pre-configured.

## Usage

```bash
npx create-seer <project-name> [options]
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `--game <id>` | `mygame` | Game identifier for the pre-configured entry |
| `--platform <id>` | `amiga` | Platform identifier |
| `--display-name <name>` | Derived from game ID | Human-readable game name |
| `--viewer` | off | Include the asset viewer tool |

### Examples

```bash
npx create-seer my-project
npx create-seer zonx --game zonx --platform amiga --display-name "Zonx"
npx create-seer spirit --game spirit --platform dosvga --display-name "Spirit" --viewer
```

## What it generates

The scaffolded project includes:

- **Root config** — `package.json`, `tsconfig.json`, `vite.config.ts`,
  `eslint.config.js`, `.prettierrc`, `.gitignore`, `index.html`
- **`src/`** — Browser-side entry point (`main.ts`), game/platform ID
  types (`game-id.ts`), asset types and loader (`data/`)
- **`tools/`** — Offline pipeline scripts: `extract-game-data.ts`,
  per-game `export-game-data.ts` and `build-assets.ts` templates, shared
  `game-config.ts`
- **`seer.config.ts`** — Pipeline configuration
- **`README.md`** — Project-specific getting-started guide

With `--viewer`, the following is also included:

- **`tools/viewer/`** — Asset viewer for browsing built sprites, atlases,
  and palettes in the browser

### Generated directory structure

```
<project>/
  src/
    main.ts                  Entry point
    game-id.ts               Game/platform identifiers
    data/
      GameData.ts            Asset type definitions
      AssetLoader.ts         Browser asset loader
  tools/
    shared/
      game-config.ts         Shared pipeline config
      __tests__/
        game-config.test.ts  Config smoke test
    <game>/
      export-game-data.ts    Stage 1 template
      build-assets.ts        Stage 2 template
    viewer/                  (with --viewer)
      index.html             Viewer entry point
      viewer.ts              Viewer logic
      viewer.css             Viewer styles
      shared.ts              Shared types
  data/<game>/<platform>/    Game data (gitignored)
  public/assets/             Built web assets (gitignored)
  seer.config.ts             Pipeline configuration
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  README.md
```

## Next steps

After scaffolding:

```bash
cd <project>
npm install
npm run dev
```

Place your original game data files under `data/<game>/<platform>/`, then
implement your parsing logic in `tools/<game>/export-game-data.ts` and
`tools/<game>/build-assets.ts`.

## Testing

```bash
npm test
npm run lint
```
