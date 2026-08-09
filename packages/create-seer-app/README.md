# create-seer-app

Scaffold a [seer](https://seer.shaid.net) project — a browser-based,
data-file-first game reverse-engineering project — or just its asset viewer or
docs site into a project you already have.

> **Pre-1.0 — expect breaking changes.** Seer is at `0.x`, and under
> [semver](https://semver.org/#spec-item-4) that means no compatibility
> promise: a minor bump may rename exports or change signatures. Pin an exact
> version if you need reproducible builds, and read the
> [changelog](https://github.com/Shaid/seer/blob/main/CHANGELOG.md) before
> upgrading. Details:
> <https://seer.shaid.net/start-here/project-status/>.

## Usage

```bash
npm create seer-app <project-name> [options]   # a full project
npm create seer-app viewer <dir> [options]     # only the asset viewer
npm create seer-app website <dir> [options]    # only the docs site
```

The templates are stripped-down copies of real, working projects rather than
invented boilerplate, so what you get builds and runs immediately.

Flags may appear **before or after** the target directory, and everything is
flag-driven, so the CLI works unattended in CI. Off a TTY it takes defaults
instead of prompting.

### Full project

```bash
npm create seer-app my-rpg --game myrpg --display-name "My RPG" --viewer --docs-site
```

Generates the Vite + TypeScript project: multi-game/multi-platform config with
one game and platform filled in, the extraction pipeline entry points under
`tools/`, the browser entry under `src/`, and starter docs. `--viewer` and
`--docs-site` compose in the two scaffolds below; `--no-viewer` /
`--no-docs-site` skip the prompt and decline.

| Flag | Default | Description |
| --- | --- | --- |
| `--game <id>` | `mygame` | Game ID; drives config keys, asset paths and `tools/<game>/` |
| `--platform <id>` | `amiga` | Platform ID for the pre-configured entry |
| `--display-name <name>` | Derived from game ID | Human-readable game name |
| `--viewer` / `--no-viewer` | prompt, else off | Include `tools/viewer` |
| `--docs-site` / `--no-docs-site` | prompt, else off | Include `www` |

### Asset viewer only

```bash
npm create seer-app viewer tools/viewer --game zonx --platform amiga
```

Drops the standalone offline asset viewer into an existing project. Takes
`--game`, `--platform` and `--display-name`.

### Docs site only

```bash
npm create seer-app website www --game zonx --site https://zonx.example
```

An Astro + [Starlight](https://starlight.astro.build) field-guide site, plus
`.github/workflows/deploy.yml` written **one level above** the target directory
(the CI-file-at-repo-root layout the template is sourced from). It ships with
`WRITING-GUIDE.md`, the content standard for these sites.

| Flag | Default | Description |
| --- | --- | --- |
| `--game <id>` | `mygame` | Game ID; drives asset paths and content slugs |
| `--display-name <name>` | Derived from game ID | Human-readable game name |
| `--description <text>` | Derived | Starlight config + homepage tagline |
| `--site <url>` | blank | Deployed site URL |
| `--site-dir <path>` | Target's basename | Path used in the generated deploy workflow |
| `--favicon-frame <name>` | blank | Sprite-atlas frame to use as the favicon |
| `--favicon-atlas-dir <dir>` | `amiga/sprites` | Atlas directory under `public/assets/<game>/` |
| `--favicon-manifest <file>` | `items.json` | Manifest filename under the atlas directory |

A placeholder favicon ships until `--favicon-frame` points the build at a real
atlas frame.

## Programmatic use

All three scaffolds are exported, which is how the full-project scaffold
composes the other two:

```ts
import { scaffold, scaffoldViewer, scaffoldWebsite } from 'create-seer-app';

scaffold('my-rpg', { game: 'myrpg', viewer: true, docsSite: true });
scaffoldViewer('tools/viewer', { game: 'myrpg', platform: 'amiga' });
scaffoldWebsite('www', { game: 'myrpg', site: 'https://myrpg.example' });
```

## Inside the seer monorepo

When run from a checkout of the seer repo, a scaffolded project depends on the
local package builds via `file:` specifiers instead of the released versions,
so framework changes are testable without publishing. That requires the
packages to be built first — run `npm run build:packages` from the repo root,
or the scaffold fails with an explanatory error rather than emitting a broken
`package.json`.

## Testing

```bash
npm test
npm run lint
```

## Licensing & Commercial Use

Seer exists to reverse-engineer other people's work, and that is only possible
because the preservation and romhacking communities published what they found
instead of keeping it. The licence is chosen so that keeps happening: build on
Seer and your work stays open too, so the next person gets the same head start.

- **[AGPL-3.0-or-later](https://github.com/Shaid/seer/blob/main/LICENSE)** —
  free for personal, educational and open-source use. Note that the AGPL extends
  copyleft to **network use**: run a public web app or hosted service on this
  and you must publish your application's source under the AGPL.
- **Commercial licence** — waives that requirement so a proprietary or
  closed-source product can keep its codebase private. Flat-fee and subscription
  terms are available, and custom terms are negotiable.

If the copyleft doesn't fit what you're building, we would much rather have the
conversation than have you walk away — email
[dr.shaid@gmail.com](mailto:dr.shaid@gmail.com) with the subject
`[Commercial License Request - Project Name]`.

Full details: <https://seer.shaid.net/start-here/licensing/>.
