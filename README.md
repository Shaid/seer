# Seer

A boilerplate for browser-based, data-file-first game reverse-engineering
projects — reimplementing a classic game by reverse-engineering its original
data files first, building an offline pipeline to convert that data into
web-native assets, and then a browser engine that consumes the preprocessed
output.

See:

- [`docs/architecture-overview.md`](docs/architecture-overview.md) — the
  general architecture this boilerplate follows, independent of any specific
  game.
- [`docs/boilerplate-guide.md`](docs/boilerplate-guide.md) — what's reusable
  as-is, what's a template to fill in, and what you'll need to build from
  scratch for your specific target.

## Getting started

```bash
npm install
```

Place your original game files under `data/<game>/<platform>/` (this
directory is gitignored — never commit original game data). Then:

```bash
npm run hex-dump -- data/<game>/<platform>/<file>   # start probing the format
npm test                                              # run the test suite
npm run lint                                          # lint src/ and tools/
npm run dev                                           # start the dev server
```

## Commands

```bash
npm run dev            # Vite dev server
npm run build          # tsc + vite production build
npm test               # Vitest test suite
npm run lint           # ESLint — src/ and tools/
npm run format         # Prettier — auto-format src/**/*.ts tools/**/*.ts
npm run hex-dump       # CLI binary inspector: npm run hex-dump -- <file> [offset] [length]
npm run extract-data   # Run the full offline pipeline (export + build-assets)
npm run build-assets   # Run only the asset-build stage
```
