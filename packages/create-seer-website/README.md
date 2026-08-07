# create-seer-website

Scaffold a standalone [Astro](https://astro.build) +
[Starlight](https://starlight.astro.build) docs site for a seer project — a
reverse-engineering field guide to a game, complete with a sprite gallery and
lightbox. The template is sourced from a real, working Astro+Starlight site
(game-specific content stripped out), so what you scaffold is a genuinely
working starting point, not boilerplate.

## Usage

```bash
npx create-seer-website <dir> [options]
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `--game <id>` | `mygame` | Game ID; drives asset paths and content slugs |
| `--display-name <name>` | Derived from game ID | Human-readable game name |
| `--description <text>` | `A reverse-engineering field guide to <name>.` | Site description (Starlight config + homepage tagline) |
| `--site <url>` | blank | Deployed site URL |
| `--favicon-frame <name>` | blank | Sprite-atlas frame name to use as the favicon |
| `--favicon-atlas-dir <dir>` | `amiga/sprites` | Atlas directory (under `public/assets/<game>/`) holding the favicon frame |
| `--favicon-manifest <file>` | `items.json` | Manifest filename (under the atlas dir) containing the favicon frame |

### Examples

```bash
npx create-seer-website www
npx create-seer-website www --game zonx --display-name "Zonx" --description "Dos VGA archaeology" --site https://zonx.shaid.net
```

### Favicon from a sprite

By default a placeholder `public/favicon.png` ships. Point the build at a
real atlas frame to generate a sprite-derived favicon:

```bash
npx create-seer-website www --game zonx --favicon-frame "sword_icon" --favicon-atlas-dir amiga/sprites --favicon-manifest items.json
```

## What it generates

Site files under `<dir>`, plus `.github/workflows/deploy.yml` one level up (at
`dirname(<dir>)` — matching the CI-file-at-repo-root layout this template is
sourced from):

- **Root config** — `package.json`, `astro.config.mjs`, `tsconfig.json`, `.gitignore`, `README.md`, `AGENTS.md`
- **`scripts/`** — `build.mjs` (asset/sprite export) and `generate_favicon.mjs`
- **`src/`** — Starlight content config, `SpriteGallery.astro`, `Lightbox.astro`, lightbox script, and per-game docs pages under `src/content/docs/<game>/`
- **`public/`** — placeholder favicon (until `--favicon-frame` is set)
- **`.github/workflows/deploy.yml`** — Pages deployment workflow (at the repo root)

## Programmatic use

```ts
import { scaffoldWebsite } from 'create-seer-website';

scaffoldWebsite('www', { game: 'zonx', displayName: 'Zonx' });
```

## Testing

```bash
npm test
npm run lint
```
