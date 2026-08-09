/**
 * Scaffolds a complete seer project — multi-game/multi-platform support
 * pre-configured, with one game/platform filled in as a working starting point.
 *
 * Optionally composes in the viewer and docs-site scaffolds, which are also
 * available on their own via the `viewer` and `website` subcommands.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capitalize, rendererFor, write } from './render.js';
import { scaffoldViewer } from './viewer.js';
import { scaffoldWebsite } from './website.js';

export interface ScaffoldOptions {
  /** Game ID for the pre-configured entry (default: 'mygame'). */
  game?: string;
  /** Platform ID for the pre-configured entry (default: 'amiga'). */
  platform?: string;
  /** Human-readable game name (default: derived from game ID). */
  displayName?: string;
  /** Include the asset viewer tool under `tools/viewer`. */
  viewer?: boolean;
  /** Include the Astro + Starlight docs site under `www`. */
  docsSite?: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const render = rendererFor('project');

/** Scaffold a new seer project at `targetDir`. */
export function scaffold(targetDir: string, options: ScaffoldOptions = {}): void {
  const game = options.game ?? 'mygame';
  const platform = options.platform ?? 'amiga';
  const displayName = options.displayName ?? capitalize(game);
  const viewer = options.viewer ?? false;
  const docsSite = options.docsSite ?? false;

  for (const dir of [
    '',
    'docs',
    'src/data',
    'src/engine',
    `data/${game}/${platform}`,
    'tools/shared/__tests__',
    `tools/${game}`,
  ]) {
    mkdirSync(resolve(targetDir, dir), { recursive: true });
  }

  const p = (rel: string) => resolve(targetDir, rel);

  // Inside this monorepo, a scaffolded project links against the local package
  // builds via `file:` specifiers so changes are testable without publishing.
  // Anywhere else, it depends on the released versions. `__dirname` is
  // `packages/create-seer-app/dist`, so `../..` is `packages/` — keep this
  // package at that depth or the detection silently falls back to `^0.1.0`.
  const seerPackagesDir = resolve(__dirname, '../..');
  const inMonorepo = existsSync(resolve(seerPackagesDir, 'core/package.json'));
  const seerSpec = (name: string): string => {
    if (!inMonorepo) return '^0.1.0';
    if (!existsSync(resolve(seerPackagesDir, name, 'dist'))) {
      throw new Error(
        `create-seer-app: packages/${name}/dist not found. Run \`npm run build:packages\` from the ` +
          'repo root before scaffolding a project that links to monorepo packages.',
      );
    }
    let rel = relative(resolve(targetDir), resolve(seerPackagesDir, name));
    if (!rel.startsWith('.') && !rel.startsWith('/')) rel = './' + rel;
    return 'file:' + rel;
  };

  const ctx = {
    game,
    platform,
    displayName,
    seerCore: seerSpec('core'),
    seerEngine2d: seerSpec('engine-2d'),
    seerPipeline: seerSpec('pipeline'),
  };

  // ── Root config files ──────────────────────────────────────────────

  write(p('package.json'), render('package.json.eta', ctx));
  write(p('tsconfig.json'), render('tsconfig.json.eta', ctx));
  write(p('vite.config.ts'), render('vite.config.ts.eta', ctx));
  write(p('eslint.config.js'), render('eslint.config.js.eta', ctx));
  write(p('.prettierrc'), render('.prettierrc.eta', ctx));
  write(p('index.html'), render('index.html.eta', ctx));
  write(p('.gitignore'), render('.gitignore.eta', ctx));

  // ── src/ ───────────────────────────────────────────────────────────

  write(p('src/game-id.ts'), render('src/game-id.ts.eta', ctx));
  write(p('src/main.ts'), render('src/main.ts.eta', ctx));
  write(p('src/data/GameData.ts'), render('src/data/GameData.ts.eta', ctx));
  write(p('src/data/AssetLoader.ts'), render('src/data/AssetLoader.ts.eta', ctx));

  // ── tools/ ─────────────────────────────────────────────────────────

  write(p('tools/shared/game-config.ts'), render('tools/shared/game-config.ts.eta', ctx));
  write(
    p('tools/shared/__tests__/game-config.test.ts'),
    render('tools/shared/__tests__/game-config.test.ts.eta', ctx),
  );
  write(p('tools/extract-game-data.ts'), render('tools/extract-game-data.ts.eta', ctx));
  write(p(`tools/${game}/export-game-data.ts`), render('tools/game/export-game-data.ts.eta', ctx));
  write(p(`tools/${game}/build-assets.ts`), render('tools/game/build-assets.ts.eta', ctx));

  // ── Optional sub-scaffolds ─────────────────────────────────────────

  if (viewer) scaffoldViewer(p('tools/viewer'), { game, platform, displayName });
  if (docsSite) scaffoldWebsite(p('www'), { game, displayName });

  // ── Config & docs ──────────────────────────────────────────────────

  write(p('seer.config.ts'), render('seer.config.ts.eta', ctx));
  write(p('README.md'), render('README.md.eta', ctx));
  write(p('docs/architecture-overview.md'), render('docs/architecture-overview.md.eta', ctx));
  write(p('docs/boilerplate-guide.md'), render('docs/boilerplate-guide.md.eta', ctx));

  console.log(`Scaffolded ${displayName} project at ${targetDir}`);
  console.log('  Next steps:');
  console.log(`    cd ${resolve(targetDir)}`);
  console.log('    npm install');
  console.log('    npm run dev');
}
