# <%= it.displayName %>

A [Seer](https://github.com/Shaid/seer) project for reverse-engineering
<%= it.displayName %> (<%= it.game %>) data files into a browser-playable implementation.

## Getting started

```bash
npm install
```

Place your original game files under `data/<%= it.game %>/<%= it.platform %>/`
(this directory is gitignored — never commit original game data). Then:

```bash
npm run extract-data          # run the offline pipeline
npm run dev                   # start the dev server
```

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | TypeScript + Vite production build |
| `npm test` | Vitest test suite |
| `npm run lint` | ESLint |
| `npm run format` | Prettier auto-format |
| `npm run extract-data` | Full offline pipeline (export + build-assets) |
| `npm run build-assets` | Asset-build stage only |

## Project structure

```
src/                 Browser-side code
  main.ts            Entry point
  game-id.ts         Game/platform identifiers
  data/              Asset types and loader
tools/               Offline pipeline scripts
  shared/            Shared pipeline config
  <%= it.game %>/              Per-game export and build scripts
data/                Original game data (gitignored)
public/assets/       Built web assets (gitignored)
seer.config.ts       Pipeline configuration
```

## Learn more

- [Seer architecture overview](https://github.com/Shaid/seer/blob/main/docs/architecture-overview.md)
- [Boilerplate guide](https://github.com/Shaid/seer/blob/main/docs/boilerplate-guide.md)
- [`@seer/pipeline` docs](https://github.com/Shaid/seer/blob/main/packages/pipeline/README.md)
